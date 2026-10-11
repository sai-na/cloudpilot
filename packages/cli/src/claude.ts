import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { fromIni } from "@aws-sdk/credential-providers";
import { buildTools, groundRules, MissingCredentialsError, modelRequest, summaryRequest, type AskContext, type LlmOptions } from "./advisor.js";
import { modelFor, type ModelJob } from "./models.js";
import type { ScanResult } from "./types.js";

type MessagesApi = Pick<Anthropic["beta"]["messages"], "create" | "toolRunner">;

interface Llm {
  messages: MessagesApi;
  /** Model plus the request settings that model and provider accept. */
  params: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, "model" | "max_tokens" | "output_config" | "betas" | "fallbacks">;
}

async function llm(options: LlmOptions, job: ModelJob): Promise<Llm> {
  if (options.provider === "bedrock") {
    if (!options.bedrockProfile) throw new Error("Bedrock needs --bedrock-profile.");
    const profile = options.bedrockProfile;
    // Not installed with CloudPilot by default: it pulls in a second AWS SDK that few users need.
    const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk").catch(() => {
      throw new Error("Claude through Amazon Bedrock needs one more package: npm install @anthropic-ai/bedrock-sdk");
    });
    const bedrock = new AnthropicBedrock({
      awsRegion: options.bedrockRegion,
      providerChainResolver: async () => fromIni({ profile }),
      ...modelRequest(),
    });
    const model = modelFor("bedrock", job, options);
    return {
      messages: bedrock.beta.messages as unknown as MessagesApi,
      // Server-side fallbacks are not offered on Bedrock, and only some Haiku generations take an effort setting.
      params: { model, max_tokens: 16000, ...effortFor(model) },
    };
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new MissingCredentialsError();
  const model = modelFor("anthropic", job, options);
  return {
    messages: new Anthropic({ ...modelRequest(), ...workspaceHeader() }).beta.messages,
    // No Haiku has the fallback routing, which is for the larger models.
    params: {
      model,
      max_tokens: 16000,
      ...effortFor(model),
      ...(isHaiku(model)
        ? {}
        : {
            // Lets the API route a declined request to its default fallback model inside the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          }),
    },
  };
}

const isHaiku = (model: string) => model.includes("haiku");

/** The Haiku generations that take an effort setting. Haiku 4.5 and the 3.x line refuse one, so a Haiku has to be named here to be sent it. */
const HAIKU_WITH_EFFORT = ["haiku-5-5"];

/** Every larger model takes an effort setting; a Haiku takes one only if its generation is named above. */
function effortFor(model: string): Pick<Llm["params"], "output_config"> {
  const takesEffort = !isHaiku(model) || HAIKU_WITH_EFFORT.some((generation) => model.includes(generation));
  return takesEffort ? { output_config: { effort: "medium" } } : {};
}

/** The variable that names the workspace for an API key that is not tied to one. */
export const WORKSPACE_ENV = "ANTHROPIC_WORKSPACE_ID";

/** A key that belongs to no single workspace has to name one on every request; a key made inside a workspace needs nothing. */
function workspaceHeader(): { defaultHeaders?: Record<string, string> } {
  const id = process.env[WORKSPACE_ENV]?.trim();
  return id ? { defaultHeaders: { "anthropic-workspace-id": id } } : {};
}

/** The model's own words, or an error when there are none to trust: a cut-off answer and an answer with no text in it are both discarded. */
function textOf(message: { stop_reason: string | null; content: Array<{ type: string; text?: string }> }): string {
  if (message.stop_reason === "refusal") throw new Error("The model declined to answer this request.");
  if (message.stop_reason === "max_tokens") throw new Error("The model's answer was cut off by the token limit.");
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("The model answered with no text.");
  return text;
}

/** A short prioritised summary of a scan, written by the model from the scan data only. */
export async function summarize(result: ScanResult, options: LlmOptions = {}): Promise<string> {
  const { messages, params } = await llm(options, "summary");
  const message = await messages.create({
    ...params,
    system: groundRules(result),
    messages: [{ role: "user", content: summaryRequest(result) }],
  });
  return textOf(message);
}

/** Answer a free-form question about the account, letting the model look things up in the scan. */
export async function ask(question: string, ctx: AskContext): Promise<string> {
  const tools = buildTools(ctx).map((tool) => betaTool({ ...tool, inputSchema: tool.inputSchema as { type: "object" } }));

  const { messages, params } = await llm(ctx.llm ?? {}, "ask");
  const runner = messages.toolRunner({
    ...params,
    system: groundRules(ctx.result),
    tools,
    max_iterations: 12,
    messages: [{ role: "user", content: question }],
  });

  let last: Anthropic.Beta.BetaMessage | undefined;
  for await (const message of runner) {
    last = message;
    for (const block of message.content) {
      if (block.type === "tool_use") ctx.onToolUse?.(block.name);
    }
  }
  if (!last) throw new Error("The model returned no response.");
  return textOf(last);
}

/** Turn an SDK error into one line a user can act on. */
export function describeError(err: unknown): string | undefined {
  // Asked first: a refusal that names the workspace ID is about the workspace, whichever status Anthropic sends it with.
  if (isWorkspaceRefusal(err)) {
    return process.env[WORKSPACE_ENV]?.trim()
      ? `Anthropic does not accept ${WORKSPACE_ENV} as a workspace ID. Check it against the workspace's ID in the Anthropic Console (it starts with wrkspc_).`
      : `This Anthropic API key is not tied to a workspace. Set ${WORKSPACE_ENV} to the workspace's ID (it starts with wrkspc_), or create a key inside a workspace and use that.`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
    return `The model is not available to this account (${err.status}): ${err.message}`;
  }
  // On Bedrock a zero quota also arrives as a 429, so pass the provider's own wording through.
  if (err instanceof Anthropic.RateLimitError) return `The model's rate limit or quota was hit: ${err.message}`;
  // A timeout is a kind of connection error, so it has to be asked about first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) return `The Anthropic API timed out: no answer within ${Math.round(modelRequest().timeout / 1000)} seconds, twice.`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check the network connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return undefined;
}

/** The statuses a workspace can be refused with; a 429 or a 5xx is about load, not the workspace. */
const WORKSPACE_REFUSAL_STATUSES = new Set([400, 401, 403, 404]);
/**
 * The header name, the `workspace_id_required` code and a plain "workspace ID"
 * all match. "No access in this workspace" does not, so a refusal about the
 * model stays one.
 */
const NAMES_A_WORKSPACE_ID = /workspace[-_ ]?id/i;

const isWorkspaceRefusal = (err: unknown) =>
  err instanceof Anthropic.APIError && WORKSPACE_REFUSAL_STATUSES.has(err.status ?? 0) && NAMES_A_WORKSPACE_ID.test(err.message);
