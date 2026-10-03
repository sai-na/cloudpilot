/** Routes the AI features to whichever model provider is configured. */
import { MissingCredentialsError, type AskContext, type LlmOptions, type Provider } from "./advisor.js";
import { llmCall } from "./recording.js";
import type { ScanResult } from "./types.js";

export function resolveProvider(options: LlmOptions): Provider {
  if (options.provider) return options.provider;
  if (options.bedrockProfile) return "bedrock";
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  throw new MissingCredentialsError();
}

/** Describes errors from whichever provider SDKs have been loaded so far. */
const describers: Array<(err: unknown) => string | undefined> = [];

/** Provider SDKs are loaded only when a model is actually called, so a plain scan never pays for them. */
async function backend(provider: Provider) {
  const module = provider === "openai" ? await import("./openai.js") : await import("./claude.js");
  if (!describers.includes(module.describeError)) describers.push(module.describeError);
  return module;
}

export function summarize(result: ScanResult, options: LlmOptions = {}): Promise<string> {
  return llmCall("summary", undefined, async () => {
    const provider = resolveProvider(options);
    return (await backend(provider)).summarize(result, { ...options, provider });
  });
}

export function ask(question: string, ctx: AskContext): Promise<string> {
  return llmCall("ask", ctx.onToolUse, async (onToolUse) => {
    const provider = resolveProvider(ctx.llm ?? {});
    return (await backend(provider)).ask(question, { ...ctx, onToolUse, llm: { ...ctx.llm, provider } });
  });
}

export function describeApiError(err: unknown): string {
  for (const describe of describers) {
    const message = describe(err);
    if (message) return message;
  }
  return err instanceof Error ? err.message : String(err);
}
