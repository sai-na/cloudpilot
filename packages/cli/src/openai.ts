import OpenAI from "openai";
import { buildTools, GROUND_RULES, MissingCredentialsError, summaryRequest, type AskContext, type LlmOptions } from "./advisor.js";
import type { ScanResult } from "./types.js";

/** Tried in order when no model is named; the first one the account can use wins. */
const MODEL_PREFERENCE = [/^gpt-6\.1/, /^gpt-6/, /^gpt-5\.5/, /^gpt-5/, /^gpt-4/];
const NOT_A_CHAT_MODEL = /audio|realtime|image|tts|transcribe|search|embedding|moderation|codex|instruct/;

/** Stop a question that keeps calling tools without ever answering. */
const MAX_STEPS = 12;

function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new MissingCredentialsError();
  return new OpenAI();
}

async function resolveModel(openai: OpenAI, options: LlmOptions): Promise<string> {
  const named = options.model ?? process.env.CLOUDPILOT_OPENAI_MODEL;
  if (named) return named;
  const ids: string[] = [];
  for await (const model of openai.models.list()) ids.push(model.id);
  const chat = ids.filter((id) => !NOT_A_CHAT_MODEL.test(id)).sort();
  for (const wanted of MODEL_PREFERENCE) {
    // The shortest match is the undated alias rather than a snapshot.
    const match = chat.filter((id) => wanted.test(id)).sort((a, b) => a.length - b.length)[0];
    if (match) return match;
  }
  throw new Error("No usable OpenAI chat model found for this key. Pass --model.");
}

function answerOf(response: OpenAI.Responses.Response): string {
  const refused = response.output.some(
    (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
  );
  if (refused && !response.output_text) throw new Error("The model declined to answer this request.");
  return response.output_text.trim();
}

/** A short prioritised summary of a scan, written by the model from the scan data only. */
export async function summarize(result: ScanResult, options: LlmOptions = {}): Promise<string> {
  const openai = client();
  const response = await openai.responses.create({
    model: await resolveModel(openai, options),
    instructions: GROUND_RULES,
    input: summaryRequest(result),
  });
  return answerOf(response);
}

/** Answer a free-form question about the account, letting the model look things up in the scan. */
export async function ask(question: string, ctx: AskContext): Promise<string> {
  const openai = client();
  const model = await resolveModel(openai, ctx.llm ?? {});
  const specs = buildTools(ctx);
  const tools: OpenAI.Responses.FunctionTool[] = specs.map((spec) => ({
    type: "function",
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    strict: false,
  }));

  let response = await openai.responses.create({ model, instructions: GROUND_RULES, input: question, tools });
  for (let step = 0; step < MAX_STEPS; step++) {
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length === 0) return answerOf(response);

    const outputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] = [];
    for (const call of calls) {
      ctx.onToolUse?.(call.name);
      const spec = specs.find((s) => s.name === call.name);
      let output: string;
      try {
        output = spec ? await spec.run(JSON.parse(call.arguments || "{}")) : `Unknown tool ${call.name}.`;
      } catch (err) {
        output = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      outputs.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    // The API keeps the conversation so far; only the tool results are sent back.
    response = await openai.responses.create({
      model,
      instructions: GROUND_RULES,
      previous_response_id: response.id,
      input: outputs,
      tools,
    });
  }
  throw new Error(`The model did not reach an answer within ${MAX_STEPS} steps.`);
}

/** Turn an SDK error into one line a user can act on. */
export function describeError(err: unknown): string | undefined {
  if (err instanceof OpenAI.AuthenticationError) return "The OpenAI API key was rejected. Check OPENAI_API_KEY.";
  if (err instanceof OpenAI.PermissionDeniedError || err instanceof OpenAI.NotFoundError) {
    return `The model is not available to this key (${err.status}): ${err.message}`;
  }
  if (err instanceof OpenAI.RateLimitError) return `The OpenAI rate limit or quota was hit: ${err.message}`;
  if (err instanceof OpenAI.APIConnectionError) return "Could not reach the OpenAI API. Check the network connection.";
  if (err instanceof OpenAI.APIError) return `OpenAI API error ${err.status}: ${err.message}`;
  return undefined;
}
