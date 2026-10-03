import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { fromIni } from "@aws-sdk/credential-providers";
import { buildTools, groundRules, MissingCredentialsError, summaryRequest, type AskContext, type LlmOptions } from "./advisor.js";
import type { ScanResult } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Default when calling through Amazon Bedrock. */
export const DEFAULT_BEDROCK_MODEL = "in.anthropic.claude-haiku-4-5-20251001-v1:0";

type MessagesApi = Pick<Anthropic["beta"]["messages"], "create" | "toolRunner">;

interface Llm {
  messages: MessagesApi;
  /** Model plus the request settings that model and provider accept. */
  params: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, "model" | "max_tokens" | "output_config" | "betas" | "fallbacks">;
}

async function llm(options: LlmOptions): Promise<Llm> {
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
    });
    const model = options.model ?? DEFAULT_BEDROCK_MODEL;
    return {
      messages: bedrock.beta.messages as unknown as MessagesApi,
      // Haiku 4.5 has no effort setting; server-side fallbacks are not offered on Bedrock.
      params: { model, max_tokens: 16000, ...(model.includes("haiku-4-5") ? {} : { output_config: { effort: "medium" } }) },
    };
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new MissingCredentialsError();
  return {
    messages: new Anthropic().beta.messages,
    params: {
      model: options.model ?? DEFAULT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // Lets the API route a declined request to its default fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
  };
}

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
  const { messages, params } = await llm(options);
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

  const { messages, params } = await llm(ctx.llm ?? {});
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
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check the network connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return undefined;
}
