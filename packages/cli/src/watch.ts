/**
 * `cloudpilot watch`: scan again and again, and speak up only when there is
 * something to decide. The loop knows nothing of AWS or kubectl: the scan, the
 * clock, the sleep and the sending are handed in, so every branch can be run
 * offline and instantly.
 *
 * The same reasoning as the daily report's email (deploy/daily-report.yaml):
 * what has been reported is only advanced once the message was delivered. A
 * send that failed leaves the findings new, so the next round says them again
 * instead of losing them. And silence has to mean "nothing new", so a check
 * that could not run is a message of its own.
 */
import { carryForward, compareScans, keyOf } from "./compare.js";
import { deliver, freshFindings, subjectOf, type Notice, type Sender, type Target } from "./notify.js";
import { money, renderText } from "./report.js";
import type { ScanResult } from "./types.js";

const MINUTE = 60_000;
const UNITS: Record<string, number> = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE };

/**
 * Between rounds: six hours. What a round measures (a day of CPU, a week of
 * Prometheus history, a monthly cost) moves over days, so four reads a day
 * catch a new waste within a working shift without reading the account hourly.
 */
export const DEFAULT_EVERY = "6h";

/**
 * The shortest interval accepted. A round reads every region (volumes,
 * snapshots, images, instances, bucket listings, CPU history, prices), or asks
 * Prometheus for days of history for every container, and AWS and a cluster
 * both throttle. What it measures moves over hours, so a read faster than
 * every 15 minutes finds nothing the last one missed. At most 96 a day.
 */
export const MIN_EVERY_MS = 15 * MINUTE;

/** The longest: a week. Beyond that a scheduler (cron, a systemd timer) is the right tool, and a timer this long is not worth trusting a process to hold. */
export const MAX_EVERY_MS = 7 * UNITS.d!;

/** "30m", "6h", "1.5h", "1d" as milliseconds. Refuses what is too short to be reasonable, or too long to be a watch. */
export function parseEvery(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text.trim());
  if (!match) throw new Error(`--every takes a number and a unit: 30m, 6h or 1d. Got "${text}".`);
  const ms = Math.round(Number(match[1]) * UNITS[match[2]!]!);
  if (ms < MIN_EVERY_MS) throw new Error(`--every must be at least 15m: each round reads the whole account or cluster, and its figures do not move faster than that. Got "${text}".`);
  if (ms > MAX_EVERY_MS) throw new Error(`--every must be 7d or less. For a longer wait, run cloudpilot from cron or a systemd timer. Got "${text}".`);
  return ms;
}

/** How many rounds to run: a whole number, one or more. */
export function parseMaxRuns(text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--max-runs takes a whole number of one or more. Got "${text}".`);
  return n;
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

export interface RoundScan {
  result: ScanResult;
  /** Set by a replay, so a message about it cannot pass for a live one. */
  banner?: string;
}

export interface WatchDeps {
  /** One scan. Throws when the check could not be made (credentials, network, cluster). Must not save a baseline of its own. */
  scan(): Promise<RoundScan>;
  /** What has been reported so far, kept between runs. */
  baseline: { load(): Promise<ScanResult | undefined>; save(result: ScanResult): Promise<void> };
  send: Sender;
  clock(): Date;
  /** Resolves after `ms`, or as soon as the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

export interface WatchOptions {
  everyMs: number;
  /** Stop after this many rounds. Unset: until stopped. */
  maxRuns?: number;
  targets: Target[];
  /** What is being watched, for a message about a check that failed before it learned that. */
  subject: string;
}

export interface WatchEnd {
  rounds: number;
  /** 1 when the last round failed, or a message is still undelivered; 0 otherwise, and always 0 when stopped by the user. */
  exitCode: number;
  stopped: boolean;
}

/** Thrown inside the loop when the user stopped it. */
class Stopped extends Error {}

/** The promise's result, or Stopped as soon as the signal aborts, so Ctrl+C does not wait for a slow scan. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Stopped());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The first line of an error, cut short: the reason a check failed, as it goes into a message. */
export const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim().slice(0, 300) || "unknown error";

/** Two failures are the same one when they differ only in numbers (a request ID, a time). */
const sameFailure = (reason: string) => reason.replace(/\d+/g, "#");

/** A stretch of rounds in which the check kept failing. */
interface Outage {
  since: string;
  key: string;
  /** Whether anyone was told: a recovery is only announced to those who heard it was down. */
  announced: boolean;
}

export async function watch(options: WatchOptions, deps: WatchDeps, signal: AbortSignal): Promise<WatchEnd> {
  let baseline = await deps.baseline.load();
  let outage: Outage | undefined;
  /** The message in flight, and the targets that already have it. */
  let pending: { key: string; done: Set<number> } | undefined;
  let undelivered = false;
  let saveWarned = false;
  let rounds = 0;

  /** True once every target has the message. Failures are said on stderr and left to the next round. */
  const send = async (key: string, notice: Notice): Promise<boolean> => {
    if (options.targets.length === 0) return true;
    if (pending?.key !== key) pending = { key, done: new Set() };
    const delivery = await abortable(deliver(options.targets, notice, deps.send, signal, pending.done), signal);
    pending.done = delivery.done;
    if (delivery.failures.length > 0) {
      deps.err(`Could not send the message: ${delivery.failures.join("; ")}. It will be sent again next round.`);
      return false;
    }
    deps.out(`Sent to ${options.targets.map((t) => t.host).join(", ")}.`);
    pending = undefined;
    return true;
  };

  const failedRound = async (err: unknown, at: string) => {
    const reason = reasonOf(err);
    const key = sameFailure(reason);
    if (outage?.key !== key) {
      // Said once. The same failure again is not said again; a different one is.
      outage = { since: outage?.since ?? at, key, announced: false };
      deps.err(`${at}  The check failed: ${reason}`);
    }
    // Undelivered until the send says otherwise, so that stopping in the middle of it is not taken for a delivery.
    undelivered = !outage.announced;
    if (!outage.announced) {
      const subject = baseline ? subjectOf(baseline) : options.subject;
      outage.announced = await send(`failed:${key}`, { kind: "failed", subject, reason, at, watching: true });
      undelivered = !outage.announced;
    }
  };

  const goodRound = async ({ result: scanned, banner }: RoundScan, at: string) => {
    const compared = baseline ? compareScans(baseline, scanned) : undefined;
    // Nothing to compare with (the first round, or a baseline of another account): every finding is new.
    const first = !compared;
    const result = compared ?? scanned;
    const fresh = freshFindings(result, first);
    const resolved = compared?.comparison?.resolved.length ?? 0;
    const heard = outage?.announced ? outage.since : undefined;

    if (first || fresh.length > 0 || resolved > 0) {
      deps.out(renderText(result, { onlyNew: true }));
    } else {
      const since = compared?.comparison?.previousScannedAt;
      deps.out(`${at}  Nothing new since ${since}: ${scanned.findings.length} finding${scanned.findings.length === 1 ? "" : "s"}, ${money(scanned.totalMonthlyWasteUsd)} a month.`);
    }

    let notice: Notice | undefined;
    let key = "";
    if (fresh.length > 0) {
      notice = { kind: "findings", result, first, banner, recoveredSince: heard };
      key = `${first ? "first" : "new"}:${fresh.map(keyOf).sort().join("|")}:${heard ?? ""}`;
    } else if (heard) {
      notice = { kind: "recovered", subject: subjectOf(scanned), since: heard, at, banner };
      key = "recovered";
    }

    undelivered = notice !== undefined;
    if (notice) undelivered = !(await send(key, notice));
    if (undelivered) return;

    // Delivered, or nothing was owed: this scan is now what has been reported.
    baseline = carryForward(baseline, scanned);
    await deps.baseline.save(baseline).catch((err) => {
      if (!saveWarned) deps.err(`Could not keep the baseline for the next run (${reasonOf(err)}); a restart will report everything again.`);
      saveWarned = true;
    });
    if (outage) deps.out(`${at}  Checking works again.`);
    outage = undefined;
  };

  try {
    while (!signal.aborted) {
      rounds++;
      const at = deps.clock().toISOString();
      let scan: RoundScan | undefined;
      try {
        scan = await abortable(deps.scan(), signal);
      } catch (err) {
        if (err instanceof Stopped) throw err;
        await failedRound(err, at);
      }
      if (scan) await goodRound(scan, at);
      if (options.maxRuns !== undefined && rounds >= options.maxRuns) break;
      await deps.sleep(options.everyMs, signal);
    }
  } catch (err) {
    if (!(err instanceof Stopped)) throw err;
  }

  const stopped = signal.aborted;
  if (stopped && undelivered) deps.err("Stopped with a message not yet delivered. Its findings are still new, so the next run reports them.");
  return { rounds, exitCode: !stopped && (outage || undelivered) ? 1 : 0, stopped };
}
