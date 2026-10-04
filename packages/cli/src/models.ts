/**
 * Which model does which job. The one place that maps (provider, job) to a
 * model. The summary for `--explain` is a short formatting job over facts the
 * scanner already worked out, so it gets a small, fast model; `ask` may use
 * tools over several turns, so it gets the stronger one. Either can be named:
 * `--model` first, then CLOUDPILOT_MODEL_SUMMARY or CLOUDPILOT_MODEL_ASK,
 * then the defaults below.
 *
 * Light on purpose: it imports no provider SDK, so a plain scan never loads one.
 */
import type { LlmOptions } from "./advisor.js";

export type ModelJob = "summary" | "ask";

/** The variable that names the model for each job. */
export const MODEL_ENV: Record<ModelJob, string> = { summary: "CLOUDPILOT_MODEL_SUMMARY", ask: "CLOUDPILOT_MODEL_ASK" };

/** Claude Haiku 4.5 on Amazon Bedrock. */
export const BEDROCK_HAIKU = "in.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Providers whose models are named here. Anthropic: the summary job gets Haiku
 * 4.5 (the alias of the model the Bedrock default already names) and `ask` the
 * model that has always been the default. Bedrock: Haiku 4.5 for both, since it
 * is the only Bedrock model named and its ID depends on the account's region;
 * name a stronger one for `ask` with --model or CLOUDPILOT_MODEL_ASK.
 * OpenAI is not here: its default is picked from the models the key can use,
 * see `pickOpenAIModel`.
 */
export const DEFAULT_MODELS: Record<"anthropic" | "bedrock", Record<ModelJob, string>> = {
  anthropic: { summary: "claude-haiku-4-5", ask: "claude-opus-5-5" },
  bedrock: { summary: BEDROCK_HAIKU, ask: BEDROCK_HAIKU },
};

const given = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/** The model the user named for this job, if any: `--model`, else the job's variable. */
export const namedModel = (options: LlmOptions, job: ModelJob): string | undefined => given(options.model) ?? given(process.env[MODEL_ENV[job]]);

/** The model for a job on Anthropic or Bedrock. */
export const modelFor = (provider: "anthropic" | "bedrock", job: ModelJob, options: LlmOptions): string => namedModel(options, job) ?? DEFAULT_MODELS[provider][job];

/** Tried in order when no OpenAI model is named; the first family the key can use wins. */
const OPENAI_FAMILIES = [/^gpt-6\.1/, /^gpt-6/, /^gpt-5\.5/, /^gpt-5/, /^gpt-4/];
const NOT_A_CHAT_MODEL = /audio|realtime|image|tts|transcribe|search|embedding|moderation|codex|instruct/;
/** OpenAI's names for the smaller, faster models of a family: gpt-5-mini and gpt-5-nano next to gpt-5. */
const MINI = /-mini(?![a-z0-9])/;
const SMALL = /-(mini|nano)(?![a-z0-9])/;
const NANO = /-nano(?![a-z0-9])/;

/**
 * Pick a default from the models a key can list. The shortest match is the
 * undated alias rather than a snapshot. For `ask`, the first family that has a
 * full-size model wins (never a "-mini" or "-nano" one); for the summary, the
 * first family that has a "-mini" one, else the first that has a "-nano".
 * Where there is none of the kind wanted, any model of the first family will
 * do, so a key that can use only one kind works as it always did.
 * Undefined when the key can use no chat model at all.
 */
export function pickOpenAIModel(ids: string[], job: ModelJob): string | undefined {
  const chat = ids.filter((id) => !NOT_A_CHAT_MODEL.test(id)).sort();
  const first = (keep: (id: string) => boolean) => {
    for (const family of OPENAI_FAMILIES) {
      const match = chat.filter((id) => family.test(id) && keep(id)).sort((a, b) => a.length - b.length)[0];
      if (match) return match;
    }
    return undefined;
  };
  if (job === "summary") return first((id) => MINI.test(id)) ?? first((id) => NANO.test(id)) ?? first(() => true);
  return first((id) => !SMALL.test(id)) ?? first(() => true);
}
