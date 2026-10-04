/**
 * Which model does which job, with stand-in model servers on 127.0.0.1: no
 * model key of any value and no real model call. The CLI is run for real
 * against a recording, with the model called live (--live-llm) so that the
 * model that was asked for can be read off the request.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { cli, cliRun, FIXTURE } from "./helpers.js";
import { BEDROCK_HAIKU, DEFAULT_MODELS, modelFor, namedModel, pickOpenAIModel } from "../src/models.js";

const QUESTION = "Which finding is the cheapest to fix?";
const TEXT = "Nothing in this answer is a figure.";

/**
 * Answers the Anthropic Messages API, the OpenAI Responses API and the OpenAI
 * model list. `models` is what the OpenAI key can list. A model named in
 * `unknown` is refused with a 404, as a provider refuses one it does not have.
 * Every request's path and body are kept.
 */
async function fakeModels(options: { models?: string[]; unknown?: string[] } = {}) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path, body });
      res.setHeader("content-type", "application/json");
      if (path === "/v1/models") return void res.end(JSON.stringify({ object: "list", data: (options.models ?? []).map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) }));
      if (options.unknown?.includes(body?.model)) {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model: ${body.model}`, code: "model_not_found" } }));
      }
      if (path === "/v1/messages") {
        return void res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: TEXT }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      }
      res.end(JSON.stringify({ id: "resp_1", object: "response", status: "completed", model: body?.model, output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: TEXT, annotations: [] }] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    /** The models that were asked to write something, in order. */
    asked: () => requests.filter((r) => r.path === "/v1/messages" || r.path === "/v1/responses").map((r) => r.body.model as string),
    requests,
    anthropic: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: base, NO_PROXY: "127.0.0.1" },
    openai: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `${base}/v1`, NO_PROXY: "127.0.0.1" },
    close: () => server.closeAllConnections() ?? server.close(),
  };
}

type Job = "summary" | "ask";
type Fake = Awaited<ReturnType<typeof fakeModels>>;

/** Run one job against the recording with a live model and say which model was asked. */
async function run(job: Job, fake: Fake, provider: "anthropic" | "openai", args: string[] = [], env: Record<string, string> = {}) {
  const command = job === "summary" ? ["scan", "--replay", FIXTURE, "--explain", "--live-llm"] : ["ask", "--replay", FIXTURE, "--live-llm", ...args, QUESTION];
  const result = await cliRun(job === "summary" ? [...command, ...args] : command, { env: { ...fake[provider], ...env } });
  return { ...result, asked: fake.asked() };
}

const withFake = async <T>(options: Parameters<typeof fakeModels>[0], body: (fake: Fake) => Promise<T>) => {
  const fake = await fakeModels(options);
  try {
    return await body(fake);
  } finally {
    fake.close();
  }
};

// ---- The mapping ----

test("each provider maps the two jobs to models in one table, with a small one for the summary and a stronger one for ask", () => {
  assert.deepEqual(DEFAULT_MODELS.anthropic, { summary: "claude-haiku-4-5", ask: "claude-opus-5-5" });
  assert.deepEqual(DEFAULT_MODELS.bedrock, { summary: BEDROCK_HAIKU, ask: BEDROCK_HAIKU });
  assert.equal(modelFor("anthropic", "summary", {}), "claude-haiku-4-5");
  assert.equal(modelFor("anthropic", "ask", {}), "claude-opus-5-5");
});

test("--model beats the job's variable, which beats the default, and an empty value counts as not given", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CLOUDPILOT_MODEL_SUMMARY;
    delete process.env.CLOUDPILOT_MODEL_ASK;
    assert.equal(namedModel({}, "ask"), undefined);
    process.env.CLOUDPILOT_MODEL_SUMMARY = " small-one ";
    process.env.CLOUDPILOT_MODEL_ASK = "strong-one";
    assert.equal(namedModel({}, "summary"), "small-one", "the variable is trimmed");
    assert.equal(namedModel({}, "ask"), "strong-one");
    assert.equal(namedModel({ model: "from-flag" }, "summary"), "from-flag");
    assert.equal(namedModel({ model: "from-flag" }, "ask"), "from-flag");
    assert.equal(modelFor("anthropic", "ask", { model: "from-flag" }), "from-flag");
    assert.equal(modelFor("bedrock", "summary", {}), "small-one");
    process.env.CLOUDPILOT_MODEL_SUMMARY = "";
    assert.equal(modelFor("anthropic", "summary", {}), "claude-haiku-4-5");
    assert.equal(namedModel({ model: "  " }, "summary"), undefined);
  } finally {
    for (const key of ["CLOUDPILOT_MODEL_SUMMARY", "CLOUDPILOT_MODEL_ASK"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("for OpenAI the summary takes the first family that has a mini model, ask the first that has a full-size one, and the undated alias wins", () => {
  const ids = ["gpt-6.1-2026-01-01", "gpt-6.1", "gpt-6.1-mini", "gpt-6.1-mini-2026-01-01", "gpt-5", "gpt-5-mini", "gpt-4o", "text-embedding-3", "gpt-6.1-codex", "gpt-6.1-mini-tts"];
  assert.equal(pickOpenAIModel(ids, "summary"), "gpt-6.1-mini");
  assert.equal(pickOpenAIModel(ids, "ask"), "gpt-6.1");
  // The newest family has no mini model: the summary still gets a small one, from the next family.
  assert.equal(pickOpenAIModel(["gpt-6.1", "gpt-5", "gpt-5-mini"], "summary"), "gpt-5-mini");
  assert.equal(pickOpenAIModel(["gpt-6.1", "gpt-5", "gpt-5-mini"], "ask"), "gpt-6.1");
  // No mini model at all, or only mini ones: each job gets what the key has, as before.
  assert.equal(pickOpenAIModel(["gpt-5", "gpt-4o"], "summary"), "gpt-5");
  assert.equal(pickOpenAIModel(["gpt-5-mini"], "ask"), "gpt-5-mini");
  assert.equal(pickOpenAIModel(["text-embedding-3", "whisper-1"], "ask"), undefined);
  assert.equal(pickOpenAIModel([], "summary"), undefined);
});

test("for OpenAI a -nano model is small too: ask never takes one over a full-size model, and the summary prefers mini to nano", () => {
  // No undated alias listed: the dated full-size model still beats mini and nano.
  assert.equal(pickOpenAIModel(["gpt-5-2025-08-07", "gpt-5-mini-2025-08-07", "gpt-5-nano"], "ask"), "gpt-5-2025-08-07");
  // A nano in a newer family does not beat the full-size model of an older one.
  assert.equal(pickOpenAIModel(["gpt-6-nano", "gpt-5", "gpt-5-mini"], "ask"), "gpt-5");
  assert.equal(pickOpenAIModel(["gpt-5-nano", "gpt-5-mini-2025-08-07", "gpt-5-2025-08-07"], "ask"), "gpt-5-2025-08-07");
  // The summary takes mini before nano, then nano when there is no mini.
  assert.equal(pickOpenAIModel(["gpt-5", "gpt-5-nano", "gpt-5-mini-2025-08-07"], "summary"), "gpt-5-mini-2025-08-07");
  assert.equal(pickOpenAIModel(["gpt-6-nano", "gpt-5", "gpt-5-mini"], "summary"), "gpt-5-mini");
  assert.equal(pickOpenAIModel(["gpt-5", "gpt-5-nano"], "summary"), "gpt-5-nano");
  // A key that lists only small models gets what there is.
  assert.equal(pickOpenAIModel(["gpt-5-nano"], "ask"), "gpt-5-nano");
  assert.equal(pickOpenAIModel(["gpt-5-nano", "gpt-5-mini"], "ask"), "gpt-5-mini");
});

// ---- The two jobs pick different defaults, end to end ----

test("Anthropic: the summary asks the small model and ask the stronger one, and the small one is sent no effort or fallback settings", async () => {
  await withFake({}, async (fake) => {
    const summary = await run("summary", fake, "anthropic");
    assert.equal(summary.status, 0, summary.stderr);
    assert.deepEqual(fake.asked(), ["claude-haiku-4-5"]);
    const body = fake.requests.find((r) => r.path === "/v1/messages")!.body;
    assert.equal(body.output_config, undefined);
    assert.equal(body.fallbacks, undefined);
    assert.match(summary.stdout, new RegExp(TEXT));

    const answer = await run("ask", fake, "anthropic");
    assert.equal(answer.status, 0, answer.stderr);
    assert.deepEqual(fake.asked(), ["claude-haiku-4-5", "claude-opus-5-5"]);
    const asked = fake.requests.filter((r) => r.path === "/v1/messages")[1]!.body;
    assert.deepEqual(asked.output_config, { effort: "medium" }, "the stronger model is asked as it always was");
    assert.equal(asked.fallbacks, "default");
    assert.ok(answer.stdout.trim().endsWith(TEXT), answer.stdout);
  });
});

test("OpenAI: the summary asks the key's mini model and ask its full-size one", async () => {
  await withFake({ models: ["gpt-5", "gpt-5-mini", "gpt-5-mini-2025-01-01", "gpt-4o"] }, async (fake) => {
    assert.equal((await run("summary", fake, "openai")).status, 0);
    assert.equal((await run("ask", fake, "openai")).status, 0);
    assert.deepEqual(fake.asked(), ["gpt-5-mini", "gpt-5"]);
  });
});

test("OpenAI: a key that lists no mini model gets the same model for both jobs, as before", async () => {
  await withFake({ models: ["gpt-5", "gpt-4o"] }, async (fake) => {
    assert.equal((await run("summary", fake, "openai")).status, 0);
    assert.equal((await run("ask", fake, "openai")).status, 0);
    assert.deepEqual(fake.asked(), ["gpt-5", "gpt-5"]);
  });
});

// ---- Overrides ----

test("CLOUDPILOT_MODEL_SUMMARY and CLOUDPILOT_MODEL_ASK each move only their own job", async () => {
  const env = { CLOUDPILOT_MODEL_SUMMARY: "summary-model", CLOUDPILOT_MODEL_ASK: "ask-model" };
  await withFake({}, async (fake) => {
    assert.equal((await run("summary", fake, "anthropic", [], env)).status, 0);
    assert.equal((await run("ask", fake, "anthropic", [], env)).status, 0);
    assert.deepEqual(fake.asked(), ["summary-model", "ask-model"]);
    // Only one is set: the other job keeps its default.
    assert.equal((await run("summary", fake, "anthropic", [], { CLOUDPILOT_MODEL_ASK: "ask-model" })).status, 0);
    assert.equal((await run("ask", fake, "anthropic", [], { CLOUDPILOT_MODEL_SUMMARY: "summary-model" })).status, 0);
    assert.deepEqual(fake.asked().slice(2), ["claude-haiku-4-5", "claude-opus-5-5"]);
  });
  await withFake({ models: ["gpt-5", "gpt-5-mini"] }, async (fake) => {
    assert.equal((await run("summary", fake, "openai", [], env)).status, 0);
    assert.equal((await run("ask", fake, "openai", [], env)).status, 0);
    assert.deepEqual(fake.asked(), ["summary-model", "ask-model"]);
    assert.ok(!fake.requests.some((r) => r.path === "/v1/models"), "a named model is not looked up in the list");
  });
});

test("--model wins over the variables, for whichever job the command does", async () => {
  const env = { CLOUDPILOT_MODEL_SUMMARY: "summary-model", CLOUDPILOT_MODEL_ASK: "ask-model" };
  await withFake({}, async (fake) => {
    assert.equal((await run("summary", fake, "anthropic", ["--model", "flag-model"], env)).status, 0);
    assert.equal((await run("ask", fake, "anthropic", ["--model", "flag-model"], env)).status, 0);
    assert.deepEqual(fake.asked(), ["flag-model", "flag-model"]);
  });
  await withFake({ models: ["gpt-5"] }, async (fake) => {
    assert.equal((await run("ask", fake, "openai", ["--model", "flag-model"], env)).status, 0);
    assert.deepEqual(fake.asked(), ["flag-model"]);
  });
});

test("the existing CLOUDPILOT_OPENAI_MODEL still names the OpenAI model for both jobs, under the new variables", async () => {
  await withFake({}, async (fake) => {
    assert.equal((await run("summary", fake, "openai", [], { CLOUDPILOT_OPENAI_MODEL: "legacy" })).status, 0);
    assert.equal((await run("ask", fake, "openai", [], { CLOUDPILOT_OPENAI_MODEL: "legacy", CLOUDPILOT_MODEL_ASK: "ask-model" })).status, 0);
    assert.deepEqual(fake.asked(), ["legacy", "ask-model"]);
  });
});

// ---- A model that is not there fails as it always did ----

test("a model the provider does not have ends in the templated summary, with the provider's reason, for both providers and both jobs", async () => {
  await withFake({ unknown: ["no-such-model"], models: ["gpt-5"] }, async (fake) => {
    for (const provider of ["anthropic", "openai"] as const) {
      const summary = await run("summary", fake, provider, [], { CLOUDPILOT_MODEL_SUMMARY: "no-such-model" });
      assert.equal(summary.status, 0, summary.stderr);
      assert.match(summary.stderr, /AI explanations are unavailable: The model is not available to this (account|key) \(404\): .*no-such-model.* Showing the templated summary instead\./);
      assert.match(summary.stdout, /Estimated waste: \$151\.53 per month across 10 findings/);

      const answer = await run("ask", fake, provider, ["--model", "no-such-model"]);
      assert.equal(answer.status, 0, answer.stderr);
      assert.match(answer.stderr, /AI explanations are unavailable: The model is not available to this (account|key) \(404\)/);
      assert.match(answer.stdout, /Estimated waste: \$151\.53 per month across 10 findings/);
    }
  });
});

// ---- Record and replay ----

test("a recording replays as it did whatever model is named: nothing is asked of a model, and the text is the recorded one", async () => {
  await withFake({}, async (fake) => {
    const plain = cli(["scan", "--replay", FIXTURE, "--explain"], { blockNetwork: true });
    assert.equal(plain.status, 0, plain.stderr);
    for (const env of [{ CLOUDPILOT_MODEL_SUMMARY: "anything" }, { CLOUDPILOT_MODEL_ASK: "anything", ...fake.anthropic }]) {
      const named = cli(["scan", "--replay", FIXTURE, "--explain", "--model", "also-anything"], { blockNetwork: true, env });
      assert.equal(named.status, 0, named.stderr);
      assert.equal(named.stdout, plain.stdout, "the same bytes");
      assert.equal(named.stderr, plain.stderr);
    }
    const question = "What should I fix first, and what is the risk?";
    const recorded = cli(["ask", "--replay", FIXTURE, question], { blockNetwork: true });
    assert.equal(recorded.status, 0, recorded.stderr);
    const named = cli(["ask", "--replay", FIXTURE, "--model", "x", question], { blockNetwork: true, env: { CLOUDPILOT_MODEL_ASK: "anything" } });
    assert.equal(named.stdout, recorded.stdout);
    assert.doesNotMatch(recorded.stdout, /unavailable/);
    assert.equal(fake.requests.length, 0, "no model was reached");
  });
});
