/**
 * Sending each scan's result to CloudPilot's hosted service, so a team gets
 * history without piping output to curl. The only outbound call here is the
 * POST to the address the user gave.
 *
 * The upload token is a secret: whoever has it can add scans to the account's
 * history. It comes only from the environment, never from a flag (a flag ends
 * up in shell history and in the process list), and it is never printed, saved
 * or put in an error message. Wherever the address has to be named, it is named
 * by its host.
 */
import type { ScanResult } from "./types.js";

/** Where the token is read from. */
export const TOKEN_VARIABLE = "CLOUDPILOT_UPLOAD_TOKEN";

/** How long the service gets to answer before an attempt counts as failed. */
const UPLOAD_TIMEOUT_MS = 20_000;

/** The wait before the one retry. */
const RETRY_AFTER_MS = 2_000;

/** How much of an answer is read. Only a few words of it are ever shown, and the service is not trusted to keep it short. */
const READ_LIMIT = 16 * 1024;

const LOOPBACK = ["127.0.0.1", "localhost"];

export interface Destination {
  /** Where the scan is posted. */
  url: string;
  /** What may be shown of it. */
  host: string;
  /** The secret. Only ever handed to the sender. */
  token: string;
}

/**
 * Settle where to upload and with what, before anything is read, so a typo
 * costs no scan. The address and the token are refused without being repeated back.
 */
export function parseDestination(raw: string, token: string | undefined): Destination {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The --upload URL is not a URL. (It is not shown, in case it carries a secret.)");
  }
  // Plain http is for a stand-in on this machine; anything else must be encrypted, since the token travels with every request.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.includes(url.hostname))) {
    throw new Error(`The --upload URL (${url.host}) is not an https URL. The upload token goes with every request and must not travel unencrypted.`);
  }
  if (url.username || url.password) {
    throw new Error(`The --upload URL (${url.host}) has a user name or password in it. The token goes in ${TOKEN_VARIABLE}, not in the URL.`);
  }
  const secret = token?.trim();
  if (!secret) {
    throw new Error(`--upload needs the upload token in the environment variable ${TOKEN_VARIABLE}. It is never taken from a command-line flag, because a flag ends up in shell history and in the process list.`);
  }
  // A header value cannot hold anything else, and the sender must not be the place that finds out.
  if (!/^[\x21-\x7e]+$/.test(secret)) {
    throw new Error(`${TOKEN_VARIABLE} holds characters that cannot be in a token (spaces, line breaks or non-ASCII). It is not shown, because it is a secret.`);
  }
  return { url: url.href, host: url.host, token: secret };
}

/** The scan as `--json` prints it, and as it is uploaded: the one definition of "this run's result". */
export const scanJson = (result: ScanResult, summary: string, banner?: string) => ({ ...result, summary, ...(banner ? { replay: banner } : {}) });

/** What the service answered: its status, and the start of its body. */
export interface Reply {
  status: number;
  body: string;
}

/** Sends one request body. Resolves with whatever the service answered, whatever its status. Throws, with a reason that is safe to print, only when there was no answer. */
export type UploadSender = (destination: Destination, body: string, signal: AbortSignal) => Promise<Reply>;

/** The start of a response body, however long it is: reading stops at the limit. */
async function readStart(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } catch {
    // What was read so far is all there is.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(parts)).slice(0, READ_LIMIT);
}

/** Text with the token and the address taken out: for anything that is printed. */
export function scrub(text: string, destination: Destination): string {
  const url = new URL(destination.url);
  let out = text.split(destination.token).join("[token]");
  // Longest first: the whole address, then the part after the host, which is where an address would carry a secret.
  for (const secret of [destination.url, `${url.pathname}${url.search}`].filter((s) => s.length > 1)) out = out.split(secret).join("[url]");
  return out;
}

/** The real sender: one POST, no redirects followed (a redirect would take the token somewhere nobody configured). */
export const makeSender =
  (timeoutMs: number): UploadSender =>
  async (destination, body, signal) => {
    if (signal.aborted) throw new Error("stopped before it was sent");
    const timer = new AbortController();
    const stop = setTimeout(() => timer.abort(), timeoutMs);
    const abort = () => timer.abort();
    signal.addEventListener("abort", abort);
    try {
      const res = await fetch(destination.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "cloudpilot", authorization: `Bearer ${destination.token}` },
        body,
        redirect: "manual",
        signal: timer.signal,
      });
      return { status: res.status, body: await readStart(res) };
    } catch (err) {
      if (signal.aborted) throw new Error("stopped before it was sent");
      if (timer.signal.aborted) throw new Error(`${destination.host} did not answer within ${timeoutMs / 1000} seconds`);
      const message = err instanceof Error ? err.message : String(err);
      // fetch's own failures say only "fetch failed"; the reason is in the cause.
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      throw new Error(scrub(`could not reach ${destination.host} (${message}${cause})`, destination));
    } finally {
      clearTimeout(stop);
      signal.removeEventListener("abort", abort);
    }
  };

export const httpUploader = makeSender(UPLOAD_TIMEOUT_MS);

/** What an upload came to: one line that says what happened and what to do, and whether the service has the scan. */
export interface Outcome {
  ok: boolean;
  line: string;
  /** What kind of failure this is, so that a loop can tell the same one again from another: the status the service gave, or the reason there was no answer with its numbers (a port, a time) left out. */
  key: string;
}

/** A few words of what the service said, safe to print: one line, no control characters, never the token. */
function said(text: string, destination: Destination, max = 160): string {
  const line = scrub(text, destination)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const json = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** What was added, from the answer to a stored scan: said only when the answer has it in the form it should. */
function counted(body: string): string {
  const counts = json(body)?.counts as Record<string, unknown> | undefined;
  const parts = [["new", "new"], ["cameBack", "came back"], ["resolved", "resolved"], ["unchanged", "unchanged"]].map(([key, word]) => [counts?.[key!], word] as const);
  return parts.every(([n]) => typeof n === "number" && Number.isInteger(n) && n >= 0) ? ` (${parts.map(([n, word]) => `${n} ${word}`).join(", ")})` : "";
}

/** The first thing the service found wrong with a scan, as it said it. */
function problemOf(body: string, destination: Destination): { detail: string; field: boolean } | undefined {
  const answer = json(body);
  const first = Array.isArray(answer?.problems) ? (answer.problems[0] as Record<string, unknown> | undefined) : undefined;
  if (first && typeof first.path === "string" && typeof first.message === "string") return { detail: said(`${first.path}: ${first.message}`, destination), field: true };
  return typeof answer?.error === "string" ? { detail: said(answer.error, destination), field: false } : undefined;
}

/** Turn what the service answered into one line. Every status the hosted service documents has its own. */
export function judge(reply: Reply, destination: Destination): Outcome {
  const { host } = destination;
  const refused = (what: string): Outcome => ({ ok: false, line: `Could not upload the scan to ${host}: ${what}`, key: `answered ${reply.status}` });
  switch (reply.status) {
    case 201:
      return { ok: true, line: `Uploaded the scan to ${host}: stored${counted(reply.body)}.`, key: "stored" };
    case 200:
      return { ok: true, line: `Uploaded the scan to ${host}: this exact scan was already stored, so nothing changed.`, key: "already stored" };
    case 401:
      return refused(`the token in ${TOKEN_VARIABLE} was not accepted. It is wrong or has been revoked: make a new one in the hosted service's settings and set the variable again.`);
    case 409:
      return refused("a later scan of this account or cluster is already stored, so this older one was refused. Check the clock of this machine: a scan taken after the stored one is accepted.");
    case 413:
      return refused("the scan is larger than the service accepts. Scan a smaller part at a time, with --region or --namespace.");
    case 422: {
      const problem = problemOf(reply.body, destination);
      const detail = problem ? ` (${problem.detail})` : "";
      return refused(`the service does not take this as a scan result${detail}. ${problem?.field ? "CloudPilot and the service disagree about that field: update CloudPilot, and report it if it still happens." : "Update CloudPilot, and report it if it still happens."}`);
    }
    default:
      if (reply.status >= 300 && reply.status < 400) return refused(`it answered ${reply.status}, a redirect, which CloudPilot does not follow because the token would go with it. Give the address it redirects to as --upload.`);
      if (reply.status >= 500) return refused(`it answered ${reply.status}. The service is failing: try again later.`);
      return refused(`it answered ${reply.status}, which CloudPilot does not know. Check that --upload is the address of the service's upload endpoint.`);
  }
}

export interface UploadDeps {
  send: UploadSender;
  /** Resolves after `ms`, or as soon as the signal aborts. */
  pause(ms: number, signal: AbortSignal): Promise<void>;
}

/**
 * Post one scan. An attempt that gets no answer, or a server error, is tried
 * once more: the service stores a scan once however often it is sent, so a
 * repeat cannot add it twice. Nothing is retried after that, and an answer
 * that says what is wrong with the request is never retried.
 */
export async function upload(destination: Destination, body: string, deps: UploadDeps, signal: AbortSignal): Promise<Outcome> {
  let last: Reply | Error | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await deps.send(destination, body, signal);
      if (reply.status < 500) return judge(reply, destination);
      last = reply;
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt === 1) {
      await deps.pause(RETRY_AFTER_MS, signal);
      if (signal.aborted) break;
    }
  }
  if (last instanceof Error) {
    return {
      ok: false,
      line: `Could not upload the scan to ${destination.host}: ${said(last.message, destination, 300)}. Check the address and the network.`,
      key: `no answer: ${said(last.message, destination, 300).replace(/\d+/g, "#")}`,
    };
  }
  return judge(last!, destination);
}
