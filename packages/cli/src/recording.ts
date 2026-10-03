/**
 * Record and replay: capture every AWS response (or, for a cluster, every
 * answer of the Kubernetes API) and model event of a run so the same run can
 * be repeated later with no network at all.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import { freezeClock } from "./clock.js";
import type { KubeReader } from "./kube.js";
import type { ClusterPrices } from "./types.js";

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

interface SessionBase {
  id: string;
  question?: string;
  recordedAt: string;
}

/** A run against an AWS account. Its answers are in aws.json. */
export interface AccountSession extends SessionBase {
  command: "scan" | "ask" | "anomalies";
  /** Region the account lookups were sent to. */
  homeRegion: string;
  /** The one region asked for, or null when every enabled region was scanned. */
  region: string | null;
  /** The regions that were actually scanned. None for anomalies, which reads Cost Explorer alone. */
  regions: string[];
  /** Anomalies only: the days of cost that were read, so a replay asks for the same ones. */
  days?: number;
}

/** A run against a Kubernetes cluster. Its answers are in kube.json. */
export interface ClusterSession extends SessionBase {
  command: "kube" | "kube-ask";
  /** The kubectl context that was read. */
  context: string;
  /** The namespaces that were actually read. */
  namespaces: string[];
  /** What the run was told to read, so a replay asks for the same paths. */
  namespace: string | null;
  prometheus: string | null;
  lookbackHours: number;
  prices: ClusterPrices;
  /** Whether the reads the advisories need (the nodes) were made. Absent in a recording made before there were advisories: it is replayed without them. */
  advisories?: boolean;
}

export type SessionMeta = AccountSession | ClusterSession;

/** Sessions of an account and of a cluster live side by side in one directory, each in a folder of its own. */
export interface Manifest {
  version: 2;
  /** The account of the account sessions. Absent while the directory holds only clusters. */
  accountId?: string;
  sessions: SessionMeta[];
}

/** Thrown when a replay is asked for something the recording does not hold. Never retried, never swallowed. */
export class ReplayMissError extends Error {
  constructor(service: string, operation: string, request: string, fallback = "the network") {
    super(
      `Replay: no recorded response for ${service} ${operation} (${request}). ` +
        `The recording does not cover this request, and replay mode never falls back to ${fallback}.`,
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

/** What the Kubernetes API answered to one read: the JSON, or the reason it refused. */
type KubeAnswer = { answer: unknown } | { error: string };

/** What a cluster run read, as kube.json holds it. */
interface KubeCapture {
  identity?: { context: string; server?: string };
  /** Per path, every answer in the order it was given. */
  responses: Record<string, KubeAnswer[]>;
  /** Reads left out because the answer looked like a credential. */
  withheld: number;
  served: Map<string, number>;
}

const emptyKube = (): KubeCapture => ({ responses: {}, withheld: 0, served: new Map() });

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
  kube: KubeCapture;
  llm: Partial<Record<LlmKind, LlmEvent[]>>;
} = { mode: "live", liveLlm: false, redact: false, captured: [], entries: {}, served: new Map(), kube: emptyKube(), llm: {} };

export const mode = () => state.mode;
export const replaysLlm = () => state.mode === "replay" && !state.liveLlm;

const manifestPath = (dir: string) => join(dir, "manifest.json");

export function loadManifest(dir: string): Manifest {
  if (!existsSync(manifestPath(dir))) throw new Error(`${dir} is not a CloudPilot recording (no manifest.json).`);
  const manifest = JSON.parse(readFileSync(manifestPath(dir), "utf8")) as Manifest;
  if (manifest.version !== 2) throw new Error(`${dir} was recorded by an older CloudPilot. Record it again.`);
  return manifest;
}

export const sessionIdFor = (command: SessionMeta["command"], question?: string) =>
  command === "scan" || command === "kube" || command === "anomalies" ? command : `${command === "ask" ? "ask" : "kube-ask"}-${createHash("sha256").update(question ?? "").digest("hex").slice(0, 12)}`;

/** Replace the account ID in text, when redaction is on and the ID is known. */
export function redact(text: string): string {
  if (!state.redact || !state.accountId || state.accountId === REDACTED_ACCOUNT) return text;
  return text.split(state.accountId).join(REDACTED_ACCOUNT);
}

let redactingOutput = false;

/** From here on, the account ID never reaches the terminal. */
export function enableRedaction(accountId: string): void {
  state.accountId = accountId;
  // Once is enough: the wrapper reads the account ID from state, and a process that scans again and again (watch) would otherwise wrap the streams on every round.
  if (!state.redact || accountId === REDACTED_ACCOUNT || redactingOutput) return;
  redactingOutput = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(typeof chunk === "string" ? redact(chunk) : chunk, ...rest)) as typeof stream.write;
  }
}

export function startLive(options: { redact: boolean }): void {
  state.redact = options.redact;
}

/** What a session is told when it starts recording: everything but what only the run itself can say. */
export type NewSession = Omit<AccountSession, "recordedAt" | "regions"> | Omit<ClusterSession, "recordedAt" | "context" | "namespaces">;

export function startRecord(dir: string, meta: NewSession, options: { redact: boolean }): void {
  const recordedAt = new Date();
  // The run fills in what it scanned when it finishes.
  const unknown = meta.command === "kube" || meta.command === "kube-ask" ? { context: "", namespaces: [] } : { regions: [] };
  Object.assign(state, { mode: "record", dir, redact: options.redact, meta: { ...meta, ...unknown, recordedAt: recordedAt.toISOString() } });
  freezeClock(recordedAt);
}

export function startReplay(dir: string, meta: SessionMeta, options: { redact: boolean; liveLlm: boolean }): void {
  const base = join(dir, meta.id);
  const read = (file: string) => JSON.parse(readFileSync(join(base, file), "utf8"));
  const cluster = meta.command === "kube" || meta.command === "kube-ask";
  Object.assign(state, {
    mode: "replay",
    dir,
    meta,
    redact: options.redact,
    liveLlm: options.liveLlm,
    entries: cluster ? {} : (read("aws.json") as { entries: Record<string, StoredResponse[]> }).entries,
    kube: cluster ? { ...emptyKube(), ...read("kube.json") } : emptyKube(),
    llm: existsSync(join(base, "llm.json")) ? read("llm.json") : {},
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

/**
 * Write the session folder and list the session in the manifest, keeping the
 * directory's other sessions. Account and cluster sessions never share a folder.
 */
function writeSession(meta: SessionMeta, files: Record<string, unknown>, accountId: string | undefined): string {
  const dir = state.dir!;
  const base = join(dir, meta.id);
  mkdirSync(base, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(base, name), JSON.stringify(content, null, 1));

  const previous = existsSync(manifestPath(dir)) ? loadManifest(dir) : undefined;
  const manifest: Manifest = {
    version: 2,
    ...((accountId ?? previous?.accountId) ? { accountId: accountId ?? previous!.accountId } : {}),
    sessions: [...(previous?.sessions ?? []).filter((s) => s.id !== meta.id), meta],
  };
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
  return base;
}

/** Write the session to disk. Called once, at the end of a recorded run. */
export function saveRecording(account: { accountId: string; regions: string[] }): string {
  if (state.mode !== "record" || !state.dir || !state.meta || !("regions" in state.meta)) throw new Error("Not recording.");
  const swap = state.redact ? (s: string) => s.split(account.accountId).join(REDACTED_ACCOUNT) : (s: string) => s;

  const entries: Record<string, StoredResponse[]> = {};
  for (const { parts, response } of state.captured) {
    const body = Buffer.from(swap(Buffer.from(response.body, "base64").toString("latin1")), "latin1").toString("base64");
    (entries[keyOf(parts, swap)] ??= []).push({ ...response, body });
  }
  const llm = JSON.parse(swap(JSON.stringify(state.llm)));

  const meta = { ...state.meta, regions: account.regions, ...(state.meta.question ? { question: swap(state.meta.question) } : {}) };
  return writeSession(meta, { "aws.json": { entries }, "llm.json": llm }, swap(account.accountId));
}

/** Write a cluster session to disk, in a folder of its own beside any account sessions. */
export function saveClusterRecording(cluster: { context: string; namespaces: string[] }): string {
  if (state.mode !== "record" || !state.dir || !state.meta || !("context" in state.meta)) throw new Error("Not recording.");
  if (state.kube.withheld > 0) {
    process.stderr.write(`${state.kube.withheld} cluster read(s) were left out of the recording because the answer looked like a credential; replaying them will say so.\n`);
  }
  const { withheld: _withheld, served: _served, ...kube } = state.kube;
  const meta = { ...state.meta, ...cluster };
  return writeSession(meta, { "kube.json": kube, "llm.json": state.llm }, undefined);
}

/**
 * Fields of a Kubernetes object that a scan never reads and that can hold a
 * secret: environment values, commands and their arguments, probes. Labels and
 * annotations are cut down to the one the scan reads (cloudpilot/ignore):
 * kubectl's own annotation holds a whole copy of the manifest, environment
 * included. Node role labels (node-role.kubernetes.io/*) are kept as well, to
 * tell the control plane from the nodes that run workloads, and a node's
 * `images` list is dropped: a scan never reads it. Secrets and ConfigMaps are
 * not on this list because a scan never asks for them. Keep it in step with what kube.ts reads; the record-then-replay
 * test fails if a read starts to depend on something dropped here.
 */
const UNREAD = new Set(["managedFields", "images", "env", "envFrom", "command", "args", "livenessProbe", "readinessProbe", "startupProbe", "lifecycle"]);
const KEPT_LABEL = "cloudpilot/ignore";
/** The one family of labels besides that which a scan reads: a node's role, to tell the control plane from nodes that run workloads. */
const KEPT_LABEL_PREFIX = "node-role.kubernetes.io/";

function unread(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unread);
  if (!value || typeof value !== "object") return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (UNREAD.has(key)) continue;
    if ((key === "labels" || key === "annotations") && inner && typeof inner === "object" && !Array.isArray(inner)) {
      const wanted = Object.entries(inner as Record<string, unknown>).filter(([name]) => name === KEPT_LABEL || (key === "labels" && name.startsWith(KEPT_LABEL_PREFIX)));
      if (wanted.length > 0) kept[key] = Object.fromEntries(wanted);
      continue;
    }
    kept[key] = unread(inner);
  }
  return kept;
}

/** What a cluster answer holds that no scan answer should: a token, a key, a signed header. */
const KUBE_SECRET = /(?:AKIA|ASIA)[0-9A-Z]{16}|sk-ant-|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|[Bb]earer [A-Za-z0-9._~+/-]{20,}|SecretAccessKey|SessionToken/;

/**
 * The reader a cluster run reads through. Live it is the real one. Recording,
 * it passes through and keeps what the cluster answered. Replaying, it answers
 * from the recording alone: kubectl is never started, and a read the recording
 * does not hold is an error naming it, never a call to the cluster.
 */
export function kubeReader(live: () => KubeReader): KubeReader {
  if (state.mode === "replay") {
    const miss = (operation: string, request: string) => new ReplayMissError("kubectl", operation, request, "the cluster");
    return {
      identity: async () => {
        if (!state.kube.identity) throw miss("config view", "the cluster's name");
        return state.kube.identity;
      },
      get: async (path) => {
        const stored = state.kube.responses[path];
        if (!stored?.length) throw miss("get --raw", path);
        const turn = state.kube.served.get(path) ?? 0;
        state.kube.served.set(path, turn + 1);
        const hit = stored[Math.min(turn, stored.length - 1)]!;
        if ("error" in hit) throw new Error(hit.error);
        return structuredClone(hit.answer);
      },
    };
  }
  const reader = live();
  if (state.mode !== "record") return reader;
  return {
    identity: async () => (state.kube.identity = await reader.identity()),
    get: async (path) => {
      let outcome: KubeAnswer;
      try {
        outcome = { answer: await reader.get(path) };
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) };
      }
      const kept = "answer" in outcome ? { answer: unread(outcome.answer) } : outcome;
      if (KUBE_SECRET.test(JSON.stringify(kept))) state.kube.withheld += 1;
      else (state.kube.responses[path] ??= []).push(kept);
      if ("error" in outcome) throw new Error(outcome.error);
      return outcome.answer;
    },
  };
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
