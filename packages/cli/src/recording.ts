/**
 * Record and replay: capture every AWS response and model event of a run so
 * the same run can be repeated later with no network at all.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import { freezeClock } from "./clock.js";

export const REDACTED_ACCOUNT = "123456789012";

/** Longest pause kept between replayed model events, so a replay still feels live. */
const MAX_REPLAY_GAP_MS = 2000;

/** Response headers the SDK needs to parse a body. Nothing else is stored. */
const KEPT_HEADERS = ["content-type", "smithy-protocol", "x-amzn-errortype", "x-amz-bucket-region"];

/** A response carrying any of these is never written to disk. */
const SECRET = /(?:AKIA|ASIA)[0-9A-Z]{16}|SecretAccessKey|SessionToken|x-amz-security-token|sk-ant-/;

interface StoredResponse {
  service: string;
  operation: string;
  status: number;
  headers: Record<string, string>;
  /** Base64 of the raw body. */
  body: string;
}

export interface LlmEvent {
  atMs: number;
  type: "tool_use" | "text";
  name?: string;
  text?: string;
}

type LlmKind = "summary" | "ask";

export interface SessionMeta {
  id: string;
  command: "scan" | "ask";
  question?: string;
  recordedAt: string;
  /** Region the account lookups were sent to. */
  homeRegion: string;
  /** The one region asked for, or null when every enabled region was scanned. */
  region: string | null;
  /** The regions that were actually scanned. */
  regions: string[];
}

export interface Manifest {
  version: 2;
  accountId: string;
  sessions: SessionMeta[];
}

/** Thrown when a replay is asked for something the recording does not hold. Never retried, never swallowed. */
export class ReplayMissError extends Error {
  constructor(service: string, operation: string, request: string) {
    super(
      `Replay: no recorded response for ${service} ${operation} (${request}). ` +
        "The recording does not cover this request, and replay mode never falls back to the network.",
    );
    this.name = "ReplayMissError";
    lastMiss = this;
  }
}

let lastMiss: ReplayMissError | undefined;

/** The first thing a replay could not serve, even if the caller caught the error. */
export const replayMiss = () => lastMiss;

/** The recording holds no model output of this kind. */
export class NotRecordedError extends Error {
  constructor(kind: LlmKind) {
    super(
      kind === "summary"
        ? "This recording has no AI summary: it was made without --explain or without a model key."
        : "This recording has no answer for that question.",
    );
    this.name = "NotRecordedError";
  }
}

interface RequestParts {
  method: string;
  host: string;
  path: string;
  body: Buffer;
}

const operationContext = new AsyncLocalStorage<{ service: string; operation: string }>();

const state: {
  mode: "live" | "record" | "replay";
  dir?: string;
  meta?: SessionMeta;
  liveLlm: boolean;
  redact: boolean;
  /** The real account ID, once known. Replaced in output and recordings when redaction is on. */
  accountId?: string;
  captured: Array<{ parts: RequestParts; response: StoredResponse }>;
  entries: Record<string, StoredResponse[]>;
  served: Map<string, number>;
  llm: Partial<Record<LlmKind, LlmEvent[]>>;
} = { mode: "live", liveLlm: false, redact: false, captured: [], entries: {}, served: new Map(), llm: {} };

export const mode = () => state.mode;
export const replaysLlm = () => state.mode === "replay" && !state.liveLlm;

const manifestPath = (dir: string) => join(dir, "manifest.json");

export function loadManifest(dir: string): Manifest {
  if (!existsSync(manifestPath(dir))) throw new Error(`${dir} is not a CloudPilot recording (no manifest.json).`);
  const manifest = JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Manifest;
  if (manifest.version !== 2) throw new Error(`${dir} was recorded by an older CloudPilot. Record it again.`);
  return manifest;
}

export const sessionIdFor = (command: "scan" | "ask", question?: string) =>
  command === "scan" ? "scan" : `ask-${createHash("sha256").update(question ?? "").digest("hex").slice(0, 12)}`;

/** Replace the account ID in text, when redaction is on and the ID is known. */
export function redact(text: string): string {
  if (!state.redact || !state.accountId || state.accountId === REDACTED_ACCOUNT) return text;
  return text.split(state.accountId).join(REDACTED_ACCOUNT);
}

/** From here on, the account ID never reaches the terminal. */
export function enableRedaction(accountId: string): void {
  state.accountId = accountId;
  if (!state.redact || accountId === REDACTED_ACCOUNT) return;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(typeof chunk === "string" ? redact(chunk) : chunk, ...rest)) as typeof stream.write;
  }
}

export function startLive(options: { redact: boolean }): void {
  state.redact = options.redact;
}

export function startRecord(dir: string, meta: Omit<SessionMeta, "recordedAt" | "regions">, options: { redact: boolean }): void {
  const recordedAt = new Date();
  Object.assign(state, { mode: "record", dir, redact: options.redact, meta: { ...meta, regions: [], recordedAt: recordedAt.toISOString() } });
  freezeClock(recordedAt);
}

export function startReplay(dir: string, meta: SessionMeta, options: { redact: boolean; liveLlm: boolean }): void {
  const base = join(dir, meta.id);
  Object.assign(state, {
    mode: "replay",
    dir,
    meta,
    redact: options.redact,
    liveLlm: options.liveLlm,
    entries: (JSON.parse(readFileSync(join(base, "aws.json"), "utf8")) as { entries: Record<string, StoredResponse[]> }).entries,
    llm: existsSync(join(base, "llm.json")) ? JSON.parse(readFileSync(join(base, "llm.json"), "utf8")) : {},
  });
  freezeClock(new Date(meta.recordedAt));
}

function requestParts(request: HttpRequest): RequestParts {
  const query = Object.entries(request.query ?? {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : (value ?? "")}`)
    .sort()
    .join("&");
  const raw = request.body;
  // Copy the bytes directly: the SDK's body type warns when string methods touch it.
  const body =
    typeof raw === "string"
      ? Buffer.from(raw)
      : raw instanceof Uint8Array
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
        : Buffer.alloc(0);
  return { method: request.method, host: request.hostname, path: query ? `${request.path}?${query}` : request.path, body };
}

/** Method, host, path and a hash of the body. Headers (signature, date, token) never take part. */
function keyOf(parts: RequestParts, transform: (s: string) => string = (s) => s): string {
  const body = Buffer.from(transform(parts.body.toString("latin1")), "latin1");
  return `${parts.method} ${transform(parts.host)}${transform(parts.path)} ${createHash("sha256").update(body).digest("hex")}`;
}

const describe = (parts: RequestParts) => `${parts.method} ${parts.host}${parts.path}`;

async function readAll(stream: unknown): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const bodyStream = (body: Buffer) => Readable.from(body.length ? [body] : [], { objectMode: false });

/**
 * The HTTP handler handed to every AWS client. Live mode gets none; record
 * mode passes through and keeps a copy; replay mode answers from the copy.
 */
export function awsRequestHandler() {
  if (state.mode === "live") return undefined;
  const network = state.mode === "record" ? new NodeHttpHandler() : undefined;
  return {
    metadata: { handlerProtocol: "http/1.1" },
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
    destroy() {},
    async handle(request: HttpRequest, options?: object): Promise<{ response: HttpResponse }> {
      const { service, operation } = operationContext.getStore() ?? { service: "unknown", operation: "unknown" };
      const parts = requestParts(request);

      if (!network) {
        const key = keyOf(parts);
        const stored = state.entries[key];
        if (!stored?.length) throw new ReplayMissError(service, operation, describe(parts));
        const turn = state.served.get(key) ?? 0;
        state.served.set(key, turn + 1);
        const hit = stored[Math.min(turn, stored.length - 1)]!;
        return {
          response: new HttpResponse({ statusCode: hit.status, headers: hit.headers, body: bodyStream(Buffer.from(hit.body, "base64")) }),
        };
      }

      const { response } = await network.handle(request, options);
      const body = await readAll(response.body);
      // Credential exchanges (assuming the role) pass through but are never kept.
      if (!operation.startsWith("AssumeRole") && !SECRET.test(body.toString("latin1"))) {
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => KEPT_HEADERS.includes(name.toLowerCase())),
        );
        state.captured.push({
          parts,
          response: { service, operation, status: response.statusCode, headers, body: body.toString("base64") },
        });
      }
      return {
        response: new HttpResponse({ statusCode: response.statusCode, reason: response.reason, headers: response.headers, body: bodyStream(body) }),
      };
    },
  };
}

/** Tell the handler which service and operation each request belongs to. */
export function labelClient<T extends { middlewareStack: { add: (...args: any[]) => void } }>(client: T, service: string): T {
  client.middlewareStack.add(
    (next: (args: unknown) => Promise<unknown>, context: { commandName?: string }) => (args: unknown) =>
      operationContext.run({ service, operation: String(context.commandName ?? "unknown").replace(/Command$/, "") }, () => next(args)),
    { step: "initialize", name: "cloudpilotOperationLabel" },
  );
  return client;
}

/** Write the session to disk. Called once, at the end of a recorded run. */
export function saveRecording(account: { accountId: string; regions: string[] }): string {
  if (state.mode !== "record" || !state.dir || !state.meta) throw new Error("Not recording.");
  const swap = state.redact ? (s: string) => s.split(account.accountId).join(REDACTED_ACCOUNT) : (s: string) => s;

  const entries: Record<string, StoredResponse[]> = {};
  for (const { parts, response } of state.captured) {
    const body = Buffer.from(swap(Buffer.from(response.body, "base64").toString("latin1")), "latin1").toString("base64");
    (entries[keyOf(parts, swap)] ??= []).push({ ...response, body });
  }
  const llm = JSON.parse(swap(JSON.stringify(state.llm)));

  const base = join(state.dir, state.meta.id);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "aws.json"), JSON.stringify({ entries }, null, 1));
  writeFileSync(join(base, "llm.json"), JSON.stringify(llm, null, 1));

  const previous = existsSync(manifestPath(state.dir)) ? loadManifest(state.dir).sessions : [];
  const meta = { ...state.meta, regions: account.regions, ...(state.meta.question ? { question: swap(state.meta.question) } : {}) };
  const manifest: Manifest = {
    version: 2,
    accountId: swap(account.accountId),
    sessions: [...previous.filter((s) => s.id !== meta.id), meta],
  };
  writeFileSync(manifestPath(state.dir), JSON.stringify(manifest, null, 2));
  return base;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one model interaction. Live and record modes call the model and note
 * what the CLI saw; replay mode plays those events back at their original
 * pace instead of calling anything.
 */
export async function llmCall(
  kind: LlmKind,
  onToolUse: ((name: string) => void) | undefined,
  run: (onToolUse: (name: string) => void) => Promise<string>,
): Promise<string> {
  if (replaysLlm()) {
    const events = state.llm[kind];
    if (!events) throw new NotRecordedError(kind);
    let last = 0;
    for (const event of events) {
      await sleep(Math.min(event.atMs - last, MAX_REPLAY_GAP_MS));
      last = event.atMs;
      if (event.type === "tool_use") onToolUse?.(event.name ?? "");
      else return event.text ?? "";
    }
    throw new NotRecordedError(kind);
  }

  const started = performance.now();
  const events: LlmEvent[] = [];
  const text = await run((name) => {
    events.push({ atMs: Math.round(performance.now() - started), type: "tool_use", name });
    onToolUse?.(name);
  });
  events.push({ atMs: Math.round(performance.now() - started), type: "text", text });
  if (state.mode === "record") state.llm[kind] = events;
  return text;
}
