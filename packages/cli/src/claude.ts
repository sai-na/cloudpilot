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
      // Haiku 4.5 has no effort setting; server-side fallbacks are not offered on Bedrock.
      params: { model, max_tokens: 16000, ...(isHaiku(model) ? {} : { output_config: { effort: "medium" } }) },
    };
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new MissingCredentialsError();
  const model = modelFor("anthropic", job, options);
  return {
    messages: new Anthropic(modelRequest()).beta.messages,
    // Haiku 4.5 takes neither an effort setting nor the fallback routing, which is for the larger models.
    params: isHaiku(model) ? { model, max_tokens: 16000 } : {
      model,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // Lets the API route a declined request to its default fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
  };
}

const isHaiku = (model: string) => model.includes("haiku-4-5");

function textOf(message: { stop_reason: string | null; content: Array<{ type: string; text?: string }> }): string {
  if (message.stop_reason === "refusal") throw new Error("The model declined to answer this request.");
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
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
