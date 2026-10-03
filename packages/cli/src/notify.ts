/**
 * Telling a team what is new, where it already looks: a Slack or Discord
 * webhook, or any other URL that takes JSON. The only outbound calls here are
 * the POSTs to the URLs the user configured.
 *
 * A webhook URL is a secret: whoever has it can post to the channel. So it is
 * never printed, saved or put in an error message; wherever a target has to be
 * named, it is named by its host.
 */
import { anomalyJson, PROJECTION_DAYS, type AnomalyReport } from "./anomaly.js";
import type { AutopilotLine } from "./autopilot.js";
import { redact } from "./recording.js";
import { comparisonLine, money, shortId, shownFindings, words } from "./report.js";
import type { Finding, ScanResult } from "./types.js";

export type TargetKind = "slack" | "discord" | "generic";

export interface Target {
  kind: TargetKind;
  /** The secret. Only ever handed to the sender. */
  url: string;
  /** What may be shown of it. */
  host: string;
}

/** A message is cut to this many characters, a margin under what each service takes: Discord refuses more than 2000 outright. */
export const LIMIT: Record<"slack" | "discord", number> = { slack: 3000, discord: 2000 };

/** How long a webhook gets to answer before the send counts as failed. */
const SEND_TIMEOUT_MS = 15_000;

const DISCORD_HOSTS = ["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/**
 * The URLs to notify: --notify when given, otherwise CLOUDPILOT_NOTIFY
 * (comma-separated). Blank entries and repeats are dropped.
 */
export function notifyUrls(option: string[] | undefined, env: string | undefined = process.env.CLOUDPILOT_NOTIFY): string[] {
  const raw = option && option.length > 0 ? option : (env ?? "").split(",");
  return [...new Set(raw.map((u) => u.trim()).filter(Boolean))];
}

/** Settle which service each URL is for. An unusable URL is refused without being repeated back. */
export function parseTargets(urls: string[]): Target[] {
  return urls.map((raw, n) => {
    const which = `notify URL ${n + 1} of ${urls.length}`;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${which} is not a URL. (It is not shown, because a webhook URL is a secret.)`);
    }
    // Plain http is for a test server on this machine; anything else must be encrypted, since the path is the secret.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.includes(url.hostname))) {
      throw new Error(`${which} (${url.host}) is not an https URL. A webhook URL is a secret and must not travel unencrypted.`);
    }
    const webhook = url.pathname.startsWith("/api/webhooks/");
    const kind: TargetKind = url.hostname === "hooks.slack.com" ? "slack" : webhook && DISCORD_HOSTS.includes(url.hostname) ? "discord" : "generic";
    return { kind, url: url.href, host: url.host };
  });
}

/** Text with every target's URL, and the secret part of it, taken out: for anything that is printed. */
export function scrub(text: string, targets: Target[]): string {
  let out = text;
  for (const t of targets) {
    const url = new URL(t.url);
    // Longest first: the whole URL, then the path that carries the secret.
    for (const secret of [t.url, `${url.pathname}${url.search}`].filter((s) => s.length > 1)) out = out.split(secret).join("[webhook]");
  }
  return out;
}

/** What a message is about. */
export type Notice =
  /** Findings to decide on. `result` is compared with the earlier scan unless `first`, when every finding is new. */
  | { kind: "findings"; result: ScanResult; first: boolean; banner?: string; recoveredSince?: string; autopilot?: string[] }
  /** Services that cost more than usual on the latest complete day. Sent only when there is at least one. */
  | { kind: "anomalies"; report: AnomalyReport; accountId: string; banner?: string }
  /** The check itself did not run to the end. */
  | { kind: "failed"; subject: string; reason: string; at: string; watching: boolean; banner?: string; autopilot?: string[] }
  /** The check works again and there is nothing new to report with it. */
  | { kind: "recovered"; subject: string; since: string; at: string; banner?: string }
  /** What autopilot did in one round: the fixes it ran, would have run, held back, refused or that failed. `problem` is set when it could do nothing at all. */
  | { kind: "autopilot"; subject: string; at: string; dryRun: boolean; rules: string[]; lines: AutopilotLine[]; problem?: string };

/** What a scan is of, in a few words: "AWS account 123456789012" or "cluster prod". */
export const subjectOf = (result: ScanResult) => (result.cluster ? `cluster ${result.cluster.context}` : `AWS account ${result.accountId}`);

/** The findings a notice is about: the new ones, or all of them on a first report. */
export const freshFindings = (result: ScanResult, first: boolean): Finding[] => (first ? result.findings : shownFindings(result, true));

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word === "fix" ? "fixes" : `${word}s`}`;

/** The message as lines, before it is dressed for one service. Figures and IDs come from the scan as they are. */
interface Draft {
  headline: string;
  intro: string[];
  items: string[];
  outro: string[];
  /** What to say when items did not fit. Without it, they are said to be in the report. */
  more?: (left: number) => string;
}

const autopilotOn = (rules?: string[]) => (rules ? ` Autopilot is on for ${rules.join(", ")}: whatever it changed is in its own message, with the way back for each.` : "");

function item(result: ScanResult, f: Finding, n: number, code: (s: string) => string): string {
  const { place } = words(result);
  const ids = f.resourceIds.map(shortId).join(", ");
  const permanence = f.fix.risk === "dangerous" ? "permanent fix" : "reversible fix";
  return `${n}. ${money(f.monthlyCostUsd)}/mo  ${f.title} (${code(ids)}), ${place} ${f.region}, ${permanence}`;
}

const OUTCOME_WORD: Record<AutopilotLine["outcome"], string> = { applied: "RAN", failed: "FAILED", "held-back": "HELD BACK", refused: "NOT RUN", "would-run": "WOULD RUN" };

function autopilotDraft(notice: Extract<Notice, { kind: "autopilot" }>, code: (s: string) => string): Draft {
  const { lines, dryRun } = notice;
  const count = (outcome: AutopilotLine["outcome"]) => lines.filter((l) => l.outcome === outcome).length;
  const changed = count("applied") + count("failed") > 0;
  const parts = [
    ...(dryRun ? [`${plural(count("would-run"), "fix")} would run`] : [`${plural(count("applied"), "fix")} run`]),
    ...(count("failed") ? [`${count("failed")} failed`] : []),
    ...(count("held-back") ? [`${count("held-back")} held back`] : []),
    ...(count("refused") ? [`${count("refused")} not run`] : []),
  ];
  const mode = dryRun ? " (dry run)" : "";
  return {
    headline: notice.problem ? `CloudPilot autopilot${mode}: could not run anything, ${notice.subject}` : `CloudPilot autopilot${mode}: ${parts.join(", ")}, ${notice.subject}`,
    intro: [
      `Autopilot is on for ${notice.rules.join(", ")}. It runs only fixes that can be undone, and never a permanent one. Round at ${notice.at}.`,
      ...(notice.problem ? [`Nothing was run: ${notice.problem}.`] : []),
      ...(dryRun ? ["This is a dry run: nothing was run, and the lines below are what a real run would have run."] : changed ? ["Each fix marked RAN or FAILED was run against the account, with the way back given for it."] : notice.problem ? [] : ["Nothing was changed."]),
    ],
    items: lines.map((l, n) => {
      const what = `${n + 1}. ${OUTCOME_WORD[l.outcome]}  ${money(l.monthlyCostUsd)}/mo  ${l.title} (${code(l.resourceIds.map(shortId).join(", "))}), region ${l.region}`;
      if (l.outcome === "held-back" || l.outcome === "refused") return `${what}. ${l.reason ?? ""}`;
      return `${what}. ${l.halfDone ? "It may be half done: check the resource. " : ""}Way back: ${l.wayBack}`;
    }),
    outro: ["Every command and its result is in .cloudpilot/audit.jsonl on the machine that runs the watch: run cloudpilot audit to read it."],
    more: (left) => `... and ${left} more not listed here: ${left === 1 ? "it is" : "they are"} in the audit log. Run cloudpilot audit.`,
  };
}

function draft(notice: Notice, code: (s: string) => string): Draft {
  if (notice.kind === "autopilot") return autopilotDraft(notice, code);
  const banner = notice.banner ? [notice.banner] : [];
  if (notice.kind === "failed") {
    return {
      headline: `CloudPilot: the check itself failed (${notice.subject})`,
      intro: [
        ...banner,
        `CloudPilot could not finish checking at ${notice.at}, so this is not a report that nothing is new.`,
        `Reason: ${notice.reason}`,
        ...(notice.watching ? ["This is said once. CloudPilot keeps trying and will say so when checking works again."] : []),
      ],
      items: [],
      outro: [notice.autopilot ? `Nothing was changed in this round: autopilot runs only after a check that finished.${autopilotOn(notice.autopilot)}` : "Nothing has been changed: this check only reads."],
    };
  }
  if (notice.kind === "recovered") {
    return {
      headline: `CloudPilot: checking works again (${notice.subject})`,
      intro: [...banner, `The check had been failing since ${notice.since} and completed at ${notice.at}. Nothing new was found.`],
      items: [],
      outro: [],
    };
  }
  if (notice.kind === "anomalies") {
    const { report } = notice;
    const n = report.anomalies.length;
    return {
      headline: `CloudPilot: ${plural(n, "service")} cost${n === 1 ? "s" : ""} more than usual on ${report.latestDay}, ${money(report.totalIncreaseUsd)} a day more, AWS account ${notice.accountId}`,
      intro: [
        ...banner,
        `Each service is compared with its own usual day: the median of the ${report.baseline?.days} days before, and, where the weekday could be checked, higher than the earlier days on the same weekday. Cost Explorer can take a day or two to settle, so these figures may still change.`,
      ],
      items: report.anomalies.map(
        (a, i) => `${i + 1}. ${a.service}: ${money(a.costUsd)} on ${a.day}, ${a.kind === "new" ? "new spend, nothing before" : `usually ${money(a.medianUsd)}`} (+${money(a.increaseUsd)} a day)`,
      ),
      outro: [
        `If all of it continued, that would add up to about ${money(report.totalMonthlyIfContinuesUsd)} over ${PROJECTION_DAYS} days. That is arithmetic on one day, not a forecast.`,
        "Nothing has been changed: this check only reads.",
        "Run cloudpilot anomalies to see the figures behind each one.",
      ],
    };
  }
  const { result, first } = notice;
  const fresh = freshFindings(result, first);
  const total = first ? result.totalMonthlyWasteUsd : result.comparison!.newMonthlyUsd;
  const headline = first
    ? `CloudPilot: first report, ${plural(fresh.length, "finding")}, ${money(total)} a month, ${subjectOf(result)}`
    : `CloudPilot: ${plural(fresh.length, "new finding")}, ${money(total)} a month, ${subjectOf(result)}`;
  const warnings = result.warnings.length;
  return {
    headline,
    intro: [
      ...banner,
      ...(notice.recoveredSince ? [`Checking works again: it had been failing since ${notice.recoveredSince}.`] : []),
      first ? "No earlier scan to compare with, so every finding is listed." : comparisonLine(result)!,
    ],
    items: fresh.map((f, n) => item(result, f, n + 1, code)),
    outro: [
      ...(warnings > 0 ? [`${warnings} check(s) could not run, so some findings may be missing.`] : []),
      notice.autopilot ? `Nothing has been changed by this message: every fix listed is a proposal.${autopilotOn(notice.autopilot)}` : "Nothing has been changed: every fix is a proposal for a person to review and run.",
      "Run cloudpilot to see each finding's evidence and fix commands.",
    ],
  };
}

/**
 * Lay a draft out in at most `limit` characters. When the findings do not all
 * fit the list is cut and the message says how many were left out; the
 * headline and the closing lines are never the part that gives way.
 */
function fit(d: Draft, limit: number, bold: (s: string) => string, escape: (s: string) => string): string {
  const head = [bold(escape(d.headline)), ...d.intro.map(escape)];
  const tail = d.outro.map(escape);
  const lines = d.items.map(escape);
  const build = (shown: number) => {
    const left = lines.length - shown;
    const cut = left > 0 ? [d.more ? d.more(left) : `... and ${left} more not listed here: ${left === 1 ? "it is" : "they are"} in the CloudPilot report.`] : [];
    return [...head, ...(lines.length ? [""] : []), ...lines.slice(0, shown), ...cut, "", ...tail].join("\n").trimEnd();
  };
  let shown = lines.length;
  while (shown > 0 && build(shown).length > limit) shown--;
  // Even with no finding listed it must fit: the intro is a few short lines, but a long failure reason is cut.
  const text = build(shown);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const noBackticks = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** The same message as plain lines, for people reading JSON or a log. */
export function plainText(notice: Notice): string {
  return fit(draft(notice, (s) => s), Number.POSITIVE_INFINITY, (s) => s, (s) => s);
}

/** The request body for one target. */
export function compose(notice: Notice, target: Pick<Target, "kind">): string {
  if (target.kind === "slack") {
    return JSON.stringify({ text: fit(draft(notice, noBackticks), LIMIT.slack, (s) => `*${s}*`, slackEscape) });
  }
  if (target.kind === "discord") {
    // allowed_mentions: a resource name can never ping @everyone.
    return JSON.stringify({ content: fit(draft(notice, noBackticks), LIMIT.discord, (s) => `**${s}**`, (s) => s), allowed_mentions: { parse: [] } });
  }
  const text = plainText(notice);
  if (notice.kind === "autopilot") {
    return JSON.stringify({
      source: "cloudpilot",
      event: "autopilot",
      text,
      subject: notice.subject,
      at: notice.at,
      dryRun: notice.dryRun,
      rules: notice.rules,
      lines: notice.lines,
      ...(notice.problem ? { problem: notice.problem } : {}),
    });
  }
  if (notice.kind === "anomalies") {
    const { report } = notice;
    return JSON.stringify({
      source: "cloudpilot",
      event: "spend-anomalies",
      text,
      subject: `AWS account ${notice.accountId}`,
      day: report.latestDay,
      totalIncreaseUsd: report.totalIncreaseUsd,
      totalMonthlyIfContinuesUsd: report.totalMonthlyIfContinuesUsd,
      anomalies: report.anomalies.map(anomalyJson),
    });
  }
  if (notice.kind === "findings") {
    const { result, first } = notice;
    return JSON.stringify({
      source: "cloudpilot",
      event: first ? "first-report" : "new-findings",
      text,
      subject: subjectOf(result),
      scannedAt: result.scannedAt,
      totalMonthlyWasteUsd: result.totalMonthlyWasteUsd,
      comparison: first ? null : result.comparison,
      findings: freshFindings(result, first),
      warnings: result.warnings,
    });
  }
  return JSON.stringify({
    source: "cloudpilot",
    event: notice.kind === "failed" ? "check-failed" : "check-recovered",
    text,
    subject: notice.subject,
    at: notice.at,
    ...(notice.kind === "failed" ? { error: notice.reason } : { failingSince: notice.since }),
  });
}

/** Sends one request body to one target. Throws, with a reason that is safe to print, when it was not accepted. */
export type Sender = (target: Target, body: string, signal: AbortSignal) => Promise<void>;

/** The real sender: one HTTPS POST, no redirects followed (a redirect would carry the message somewhere nobody configured). */
export const httpSender: Sender = async (target, body, signal) => {
  if (signal.aborted) throw new Error("stopped before it was sent");
  const timer = new AbortController();
  const stop = setTimeout(() => timer.abort(), SEND_TIMEOUT_MS);
  const abort = () => timer.abort();
  signal.addEventListener("abort", abort);
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "cloudpilot" },
      body,
      redirect: "manual",
      signal: timer.signal,
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`${target.host} answered ${res.status}, a redirect, which CloudPilot does not follow`);
    if (!res.ok) {
      const said = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 100);
      throw new Error(`${target.host} answered ${res.status}${said ? ` (${said})` : ""}`);
    }
  } catch (err) {
    if (signal.aborted) throw new Error("stopped before it was sent");
    if (timer.signal.aborted) throw new Error(`${target.host} did not answer within ${SEND_TIMEOUT_MS / 1000} seconds`);
    const message = err instanceof Error ? err.message : String(err);
    // fetch's own failures say only "fetch failed"; the reason is in the cause.
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    throw new Error(message.startsWith(target.host) ? message : `could not reach ${target.host} (${message}${cause})`);
  } finally {
    clearTimeout(stop);
    signal.removeEventListener("abort", abort);
  }
};

export interface Delivery {
  /** Indexes of the targets that have the message: those that took it now, and those in `already`. */
  done: Set<number>;
  /** One line per target that did not take it, safe to print. */
  failures: string[];
}

/**
 * Send a notice to every target that does not have it yet. Every target is
 * tried even when one fails; the failures are reported, never dropped.
 * `already` lets a retry skip the targets that took the message last time, so
 * one broken webhook does not make a working one hear the same thing again.
 */
export async function deliver(targets: Target[], notice: Notice, send: Sender, signal: AbortSignal, already: Set<number> = new Set()): Promise<Delivery> {
  const done = new Set(already);
  const failures: string[] = [];
  await Promise.all(
    targets.map(async (target, n) => {
      if (done.has(n)) return;
      try {
        // The account ID is hidden in a --redact-account run, in messages as in everything else.
        await send(target, redact(compose(notice, target)), signal);
        done.add(n);
      } catch (err) {
        failures.push(scrub(err instanceof Error ? err.message : String(err), targets));
      }
    }),
  );
  return { done, failures: failures.sort() };
}
