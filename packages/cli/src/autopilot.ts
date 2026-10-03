/**
 * Autopilot: `cloudpilot watch --autopilot <rules>`, the one thing besides
 * `apply` that can change anything. It is off unless asked for, it acts only
 * for the rules the person names, and only for fixes that can be undone.
 *
 * It takes no decision of its own about how to run a fix: the fix goes through
 * apply's machinery (the allow-list, arguments never through a shell, the
 * audit log). What is added here is the list of reasons to refuse. A finding
 * has to pass every gate, in this order:
 *
 *  1. its rule is one that was named, and a rule is named only if autopilot
 *     can ever run its fix (the table below, checked against the real rules
 *     by a test);
 *  2. the fix can be undone: the finding's own risk is not "dangerous", no
 *     command in it is of a kind the allow-list calls permanent, and the
 *     commands are word for word the ones the rule prints for that resource.
 *     The alternative fix of a finding is never taken in place of its fix;
 *  3. the finding's confidence is at least --autopilot-min-confidence;
 *  4. it has been in at least --autopilot-after rounds of this watch in a row;
 *  5. the scan is from this round and read the finding's region in full;
 *  6. no fix has been run or failed on that resource from this directory
 *     before (the audit log says, and so does what this process has done);
 *  7. the caps: --autopilot-max a round, --autopilot-max-total in all.
 *
 * The finding is always one of this round's scan, held in memory. Autopilot
 * reads no saved scan and no saved baseline, so a file edited by hand cannot
 * hand it a fix. The count of rounds is kept in memory too: a restart starts
 * it again. What must outlive the process, what was tried, is in the audit log.
 */
import { apply, auditEntry, commandRisk, plan, type AuditEntry, type Plan, type Runner } from "./apply.js";
import { keyOf } from "./compare.js";
import { gp3Command, lifecycleCommand, regionsNotFullyScanned } from "./detect.js";
import { subjectOf, type Notice } from "./notify.js";
import { PATTERNS, type Finding, type Pattern, type ScanResult } from "./types.js";

/** A rule autopilot can run the fix of, and what is checked of a finding of it. */
interface Qualifies {
  ok: true;
  /** What the fix does, in a few words. */
  fix: string;
  /** The confidence every finding of the rule has: a rule that never reaches --autopilot-min-confidence is refused up front. */
  confidence: number;
  /** The commands the rule prints for this finding. A finding whose fix is anything else is refused. */
  commands: (f: Finding) => string[];
}

/** A rule autopilot never runs, and the reason, which is what a person who names it is told. */
interface Never {
  ok: false;
  reason: string;
}

const permanent = (what: string) => `its fix ${what}, which is permanent, and autopilot never runs a permanent fix.`;
const alternativeNever = (what: string) => ` It has a fix that can be undone (${what}), but autopilot never takes an alternative in place of the fix a finding proposes: run it yourself with cloudpilot apply.`;

/**
 * Every rule, and whether autopilot can ever run it. Written apart from the
 * rules, like apply's allow-list, and held to them by a test that goes through
 * every rule's real findings: a new rule has to be put here, and a rule whose
 * fix changes cannot stay on the list unnoticed.
 */
export const AUTOPILOT_RULES: Record<Pattern, Qualifies | Never> = {
  "gp2-volume": { ok: true, fix: "change the volume from gp2 to gp3", confidence: 0.9, commands: (f) => [gp3Command(f.region, f.resourceIds[0]!)] },
  "bucket-without-lifecycle": { ok: true, fix: "add a lifecycle rule to the bucket", confidence: 0.9, commands: (f) => [lifecycleCommand(f.region, f.resourceIds[0]!)] },
  "unattached-ebs-volume": { ok: false, reason: `${permanent("deletes the volume")}${alternativeNever("convert it from gp2 to gp3")}` },
  "idle-elastic-ip": { ok: false, reason: permanent("releases the address") },
  "stopped-instance": { ok: false, reason: permanent("terminates the instance") },
  "idle-instance": { ok: false, reason: permanent("terminates the instance") },
  "oversized-instance": {
    ok: false,
    reason: "its fix stops a running instance, changes its size and starts it again. That is an outage, a failure part-way leaves the instance stopped, and the rule's confidence never reaches the default bar. A person should choose the moment.",
  },
  "idle-rds-instance": { ok: false, reason: `${permanent("deletes the database")}${alternativeNever("stop it")}` },
  "idle-nat-gateway": { ok: false, reason: permanent("deletes the gateway") },
  "idle-load-balancer": { ok: false, reason: permanent("deletes the load balancer") },
  "orphaned-snapshot": { ok: false, reason: permanent("deletes the snapshot") },
  "unused-ami": { ok: false, reason: permanent("deregisters the image and deletes its snapshots") },
  "incomplete-multipart-upload": { ok: false, reason: permanent("aborts the upload, and the parts already uploaded are discarded for good") },
  "over-requested-workload": {
    ok: false,
    reason:
      "its fix restarts the workload's pods with smaller requests, which can get them evicted or killed under a load the history did not show, and a Helm, Argo CD or Flux sync undoes it. Autopilot also runs nothing on a cluster.",
  },
  "unused-volume-claim": { ok: false, reason: permanent("deletes the claim") },
  "released-volume": { ok: false, reason: permanent("deletes the volume") },
};

/** The rules autopilot can run the fix of today, in the order the rules are listed. */
export const AUTOPILOT_QUALIFYING = PATTERNS.filter((p) => AUTOPILOT_RULES[p].ok);

export const AUTOPILOT_DEFAULTS = { minConfidence: 0.9, after: 2, maxPerRound: 3, maxTotal: 10 } as const;

export interface AutopilotSettings {
  rules: Pattern[];
  minConfidence: number;
  /** Rounds of this watch in a row a finding must have been in. */
  after: number;
  maxPerRound: number;
  maxTotal: number;
  dryRun: boolean;
}

/** The options as the command line gives them, still text. */
export interface AutopilotOptions {
  autopilot: string;
  minConfidence?: string;
  after?: string;
  max?: string;
  maxTotal?: string;
  dryRun?: boolean;
}

const oneOrMore = (flag: string, text: string | undefined, fallback: number) => {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} takes a whole number of one or more. Got "${text}".`);
  return n;
};

/** The settings, or an error naming what is wrong. Nothing has run when this throws. */
export function parseAutopilot(options: AutopilotOptions): AutopilotSettings {
  const minText = options.minConfidence;
  const minConfidence = minText === undefined ? AUTOPILOT_DEFAULTS.minConfidence : Number(minText);
  if (minText !== undefined && (minText.trim() === "" || !Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 1)) {
    throw new Error(`--autopilot-min-confidence takes a number above 0 and up to 1. Got "${minText}".`);
  }
  const after = oneOrMore("--autopilot-after", options.after, AUTOPILOT_DEFAULTS.after);
  const maxPerRound = oneOrMore("--autopilot-max", options.max, AUTOPILOT_DEFAULTS.maxPerRound);
  const maxTotal = oneOrMore("--autopilot-max-total", options.maxTotal, AUTOPILOT_DEFAULTS.maxTotal);

  const named = options.autopilot.split(",").map((name) => name.trim());
  if (named.length === 0 || named.some((name) => name === "")) throw new Error(`--autopilot takes rule names separated by commas, such as ${AUTOPILOT_QUALIFYING.join(",")}. A name is empty here.`);
  const rules: Pattern[] = [];
  for (const name of named) {
    if (name === "all" || name === "*") {
      throw new Error(`--autopilot has no "${name}": name each rule. The rules it can run today are ${AUTOPILOT_QUALIFYING.join(", ")}.`);
    }
    if (!(PATTERNS as readonly string[]).includes(name)) {
      throw new Error(`--autopilot: "${name}" is not a CloudPilot rule. The rules autopilot can run today are ${AUTOPILOT_QUALIFYING.join(", ")}; every rule is listed in the README.`);
    }
    const rule = AUTOPILOT_RULES[name as Pattern];
    if (!rule.ok) throw new Error(`--autopilot: autopilot can never run "${name}": ${rule.reason}`);
    if (rule.confidence < minConfidence) {
      throw new Error(`--autopilot: "${name}" is always reported at confidence ${rule.confidence}, below --autopilot-min-confidence ${minConfidence}, so autopilot would never run it.`);
    }
    if (!rules.includes(name as Pattern)) rules.push(name as Pattern);
  }
  return { rules, minConfidence, after, maxPerRound, maxTotal, dryRun: Boolean(options.dryRun) };
}

/** Why autopilot cannot be turned on for this watch, before anything runs; undefined when it can. */
export function autopilotRefusal(watching: { replay?: string; redactAccount?: boolean; kube?: boolean; inCluster: boolean }): string | undefined {
  if (watching.replay) return "--autopilot cannot be used with --replay: a recording is not the account as it is now, and a fix is never run from one.";
  if (watching.redactAccount) {
    return "--autopilot cannot be used with --redact-account: the account ID is hidden, so the record of what was changed would not say where, and the same resource could not be recognised the next time.";
  }
  if (watching.inCluster) return "--autopilot cannot be used inside a cluster: the watcher that runs in a cluster is read-only by design, and a fix is never run from it.";
  if (watching.kube) {
    return `--autopilot cannot be used with --kube: the rules it can run (${AUTOPILOT_QUALIFYING.join(", ")}) are AWS rules, and no rule that runs against a cluster can be run by autopilot.`;
  }
  return undefined;
}

const times = (n: number, noun: string) => `${n} ${n === 1 ? noun : noun === "fix" ? "fixes" : `${noun}s`}`;

/** What the watch says when it starts with autopilot on: plain words, before the first round. */
export function autopilotBanner(s: AutopilotSettings): string[] {
  const rules = s.rules.join(", ");
  return [
    s.dryRun
      ? `AUTOPILOT IS ON, AS A DRY RUN: nothing will be run. Each round it says what it would run for ${rules}, and only those, and sends that to --notify.`
      : `AUTOPILOT IS ON. This watch will RUN fixes, not only read: for ${rules}, and only those. A scan itself still only reads.`,
    `  Only fixes that can be undone are run. A permanent fix is never run by autopilot, whatever else is set, and nor is the gentler alternative to a permanent fix.`,
    `  A finding is fixed only at confidence ${s.minConfidence} or more, after it has been in ${times(s.after, "round")} of this watch in a row, once per resource (never again, even after a failure), at most ${s.maxPerRound} a round and ${s.maxTotal} in all.`,
    `  Every fix, and every one it holds back, refuses or fails, is written to .cloudpilot/audit.jsonl (see it with: cloudpilot audit) and, with --notify, sent with the way back. Ctrl+C lets a fix that has started finish.`,
  ];
}

/** One fix as a message and the round's output tell it. */
export interface AutopilotLine {
  /** "would-run" is a dry run's: nothing was run. */
  outcome: "applied" | "failed" | "held-back" | "refused" | "would-run";
  title: string;
  resourceIds: string[];
  region: string;
  monthlyCostUsd: number;
  commands: string[];
  wayBack: string;
  reason?: string;
  /** A fix of several commands failed after the first: the resource may be half changed. */
  halfDone?: boolean;
}

/** What one round came to. `notice` is set when there is something to tell: a fix run, held back, refused or failed. */
export interface AutopilotRound {
  notice?: Notice;
  /** A fix failed, or the audit log could not take its record. */
  failed: boolean;
}

export interface AutopilotIO {
  runner: Runner;
  audit: {
    /** Every entry. Throws when the log is there and cannot be read: then nothing can be known about earlier fixes. */
    read(): Promise<AuditEntry[]>;
    /** Throws unless a line can be added: checked before a fix runs, so none runs that cannot be recorded. */
    check(): Promise<void>;
    record(entry: AuditEntry): Promise<void>;
  };
  user: string;
  now: () => Date;
}

export interface Autopilot {
  settings: AutopilotSettings;
  /** One round, after its scan. `startedAt` is when the round began: a scan older than that is not this round's. */
  round(input: { scan: ScanResult; startedAt: Date; say: (line: string) => void; signal: AbortSignal }): Promise<AutopilotRound>;
  /** A round whose check failed: nothing was seen, so no finding has been in a run of rounds. */
  forget(): void;
}

/** What names a resource across rounds and runs: the same for a finding and for an audit entry about it. */
const resourceKey = (scope: string, target: string, region: string, ids: string[]) => `${scope}|${target}|${region}|${[...ids].sort().join(",")}`;
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim().slice(0, 300) || "unknown error";
const SKEW_MS = 5 * 60_000;

/** The line a recorded entry tells. */
export function lineOf(e: AuditEntry): AutopilotLine {
  const firstFailure = e.commands.findIndex((c) => c.exitCode !== undefined && c.exitCode !== 0);
  return {
    outcome: e.outcome === "applied" || e.outcome === "failed" || e.outcome === "held-back" ? e.outcome : "refused",
    title: e.finding.title,
    resourceIds: e.finding.resourceIds,
    region: e.finding.region,
    monthlyCostUsd: e.finding.monthlyCostUsd,
    commands: e.commands.map((c) => c.command),
    wayBack: e.wayBack,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.outcome === "failed" && firstFailure > 0 ? { halfDone: true } : {}),
  };
}

export function createAutopilot(settings: AutopilotSettings, io: AutopilotIO): Autopilot {
  /** Rounds in a row each finding has been in, by keyOf. */
  let streaks = new Map<string, number>();
  /** Resources a fix was started on in this process (or, in a dry run, would have been): the audit log may not have taken the record. */
  const attempted = new Set<string>();
  /** Fixes started in this process, against the total cap. */
  let total = 0;
  /** What has been said, so a refusal that lasts is said once, not every round. */
  const said = new Set<string>();

  return {
    settings,
    forget: () => void (streaks = new Map()),
    async round({ scan, startedAt, say, signal }) {
      const at = startedAt.toISOString();
      const pilot = (text: string) => say(`${at}  Autopilot${settings.dryRun ? " (dry run)" : ""}: ${text}`);
      const named = new Set<string>(settings.rules);
      const candidates = [...new Map(scan.findings.filter((f) => named.has(f.pattern)).map((f) => [keyOf(f), f] as const)).values()].sort(
        (a, b) => b.monthlyCostUsd - a.monthlyCostUsd || (keyOf(a) < keyOf(b) ? -1 : 1),
      );
      const seen = new Map<string, number>();
      for (const f of candidates) seen.set(keyOf(f), (streaks.get(keyOf(f)) ?? 0) + 1);
      streaks = seen;
      if (candidates.length === 0) {
        pilot(`nothing to do: no finding of ${settings.rules.join(" or ")}.`);
        return { failed: false };
      }

      const subject = subjectOf(scan);
      const tell = (lines: AutopilotLine[], problem?: string): Notice => ({ kind: "autopilot", subject, at, dryRun: settings.dryRun, rules: settings.rules, lines, ...(problem ? { problem } : {}) });

      // What was tried before, and (when fixes are to run) proof that a line can be added to the record.
      let before: AuditEntry[];
      try {
        before = await io.audit.read();
        if (!settings.dryRun) await io.audit.check();
      } catch (err) {
        const problem = `the audit log cannot be used (${reasonOf(err)}), so no fix can be run and recorded, and nothing was run`;
        pilot(`did nothing this round: ${problem}.`);
        if (said.has(`audit|${problem}`)) return { failed: true };
        said.add(`audit|${problem}`);
        return { notice: tell([], problem), failed: true };
      }
      const tried = new Map<string, AuditEntry>();
      for (const e of before) {
        if (e.outcome !== "applied" && e.outcome !== "failed") continue;
        const key = resourceKey(e.scope, e.target, e.finding.region, e.finding.resourceIds);
        if (!tried.has(key)) tried.set(key, e);
      }

      const lines: AutopilotLine[] = [];
      let auditBroken: string | undefined;
      let latest: AuditEntry | undefined;
      const record = async (entry: AuditEntry) => {
        latest = entry;
        if (settings.dryRun) return;
        try {
          await io.audit.record(entry);
        } catch (err) {
          auditBroken = reasonOf(err);
          say(`Could not write the audit log (${auditBroken}). This entry was NOT recorded: ${JSON.stringify(entry)}`);
        }
      };
      const base = (f: Finding) => ({ scan, finding: f, which: "fix" as const, fix: f.fix });
      /** Refused or held back: said and recorded once, however many rounds the reason lasts. */
      const leave = async (f: Finding, outcome: "refused" | "held-back", gates: string[], reason: string) => {
        const key = `${outcome}|${resourceKey("account", scan.accountId, f.region, f.resourceIds)}|${reason}`;
        if (said.has(key)) return;
        said.add(key);
        const entry = auditEntry(base(f), io, outcome, f.fix.commands.map((command) => ({ command })), reason, { gates });
        // A relabelled fix is recorded as the worst of what it says and what its commands are.
        const worst = f.fix.risk !== "caution" || f.fix.commands.some((c) => riskOf(c) === "dangerous") ? "dangerous" : "caution";
        await record({ ...entry, risk: worst });
        lines.push({ ...lineOf(entry), outcome });
        pilot(`${outcome === "refused" ? "refused" : "held back"} ${f.resourceIds.join(", ")} in ${f.region}: ${reason}`);
      };

      const waiting: string[] = [];
      const ready: Array<{ f: Finding; p: Plan; gates: string[] }> = [];
      /** Past a cap: said after the fixes that did run, so the record reads in the order things happened. */
      const capped: Array<{ f: Finding; gates: string[]; reason: string }> = [];
      const totalLeft = Math.max(0, settings.maxTotal - total);
      const slots = Math.min(settings.maxPerRound, totalLeft);
      const roundCap = settings.maxPerRound;
      const incomplete = regionsNotFullyScanned(scan.warnings);
      const unplaced = scan.warnings.find((w) => !/^\[[^\]]+\] /.test(w));

      for (const f of candidates) {
        const id = f.resourceIds.join(", ");
        const gates = ["rule named"];

        const problem = fixProblem(f);
        if (problem) {
          await leave(f, "refused", gates, problem);
          continue;
        }
        gates.push("fix can be undone");

        if (!(f.confidence >= settings.minConfidence)) {
          waiting.push(`${id} (confidence ${f.confidence}, needs ${settings.minConfidence})`);
          continue;
        }
        gates.push(`confidence ${f.confidence} (at least ${settings.minConfidence})`);

        const rounds = seen.get(keyOf(f))!;
        if (rounds < settings.after) {
          waiting.push(`${id} (in ${times(rounds, "round")} of the ${settings.after} it needs)`);
          continue;
        }
        gates.push(`in ${times(rounds, "round")} of this watch in a row (at least ${settings.after})`);

        const scannedAt = Date.parse(scan.scannedAt);
        const stale = !Number.isFinite(scannedAt)
          ? `The scan says it was taken at ${JSON.stringify(scan.scannedAt)}, which cannot be read as a time, so it cannot be shown to be from this round.`
          : scannedAt < startedAt.getTime()
            ? `The scan is from ${scan.scannedAt}, before this round began at ${at}, so it is not what this round saw.`
            : scannedAt > io.now().getTime() + SKEW_MS
              ? `The scan is from ${scan.scannedAt}, in the future, so a clock is wrong.`
              : undefined;
        const unread = !scan.regions.includes(f.region)
          ? `The scan did not read ${f.region}.`
          : incomplete.has(f.region)
            ? `The scan could not run every check in ${f.region} (${scan.warnings.find((w) => w.startsWith(`[${f.region}] `))}), so the finding may rest on a gap.`
            : unplaced !== undefined
              ? `The scan has a warning that does not say which region it is about (${unplaced}), so ${f.region} cannot be shown to have been read in full.`
              : undefined;
        if (stale ?? unread) {
          await leave(f, "refused", gates, (stale ?? unread)!);
          continue;
        }
        gates.push("scan taken in this round, region read in full");

        const key = resourceKey("account", scan.accountId, f.region, f.resourceIds);
        const earlier = tried.get(key);
        if (earlier) {
          await leave(f, "refused", gates, `A fix was already tried on this resource (${earlier.outcome} at ${earlier.at}${earlier.autopilot ? ", by autopilot" : ""}). Autopilot never tries a resource twice: run cloudpilot apply ${f.resourceIds[0]} to do it yourself.`);
          continue;
        }
        if (attempted.has(key)) {
          // In a dry run this is what the last round already said would run, not a refusal: nothing was tried.
          if (!settings.dryRun) await leave(f, "refused", gates, "A fix was already started on this resource earlier in this watch, and the audit log did not take its record. Autopilot never tries a resource twice.");
          continue;
        }
        gates.push("no earlier fix on this resource");

        // The same machinery apply uses: the allow-list and the arguments, never a shell.
        let p: Plan;
        try {
          p = plan([{ ...scan, findings: [f] }], [f.resourceIds[0]!], { maxAgeHours: 24, now: io.now() })[0]!;
          if (p.which !== "fix" || p.fix !== f.fix) throw new Error("the plan is not for the finding's own fix");
        } catch (err) {
          await leave(f, "refused", gates, `Apply would not run it: ${reasonOf(err)}`);
          continue;
        }

        if (ready.length >= slots) {
          const why = totalLeft <= roundCap ? `the cap of ${settings.maxTotal} fixes for this watch was reached` : `the cap of ${roundCap} fixes a round was reached`;
          capped.push({ f, gates, reason: `${why[0]!.toUpperCase()}${why.slice(1)}.` });
          continue;
        }
        gates.push(`within the caps (${ready.length + 1} of ${roundCap} this round, ${total + ready.length + 1} of ${settings.maxTotal} in all)`);
        ready.push({ f, p, gates });
      }

      // Run them, one at a time, through apply: no terminal to ask at, so only a fix that can be undone could ever run.
      let failed = false;
      const gatesOf = new Map(ready.map((r) => [r.p, r.gates] as const));
      for (const { f, p, gates } of ready) {
        const stop = failed ? "an earlier fix failed in this round" : signal.aborted ? "the watch was stopped" : auditBroken !== undefined ? "the audit log could not take the last record" : undefined;
        if (stop) {
          await leave(f, "held-back", gates, `Autopilot stopped for this round, because ${stop}.`);
          continue;
        }
        attempted.add(resourceKey("account", scan.accountId, f.region, f.resourceIds));
        total++;
        latest = undefined;
        let outcomes: Awaited<ReturnType<typeof apply>>;
        try {
          outcomes = await apply([p], {
            runner: io.runner,
            yes: true,
            dryRun: settings.dryRun,
            say,
            record,
            user: io.user,
            now: io.now,
            autopilot: (plan) => ({ gates: gatesOf.get(plan) ?? [] }),
          });
        } catch (err) {
          // The program could not even be started (not on the PATH): nothing ran, and that is a failure to say.
          const entry = auditEntry(p, io, "failed", p.commands.map((c) => ({ command: c.text })), `Not run: ${reasonOf(err)}`, { gates });
          say(`  Not run: ${reasonOf(err)}`);
          await record(entry);
          lines.push(lineOf(entry));
          failed = true;
          continue;
        }
        if (settings.dryRun) {
          lines.push({ outcome: "would-run", title: f.title, resourceIds: f.resourceIds, region: f.region, monthlyCostUsd: f.monthlyCostUsd, commands: p.commands.map((c) => c.text), wayBack: p.fix.rollback });
        } else if (latest) {
          lines.push(lineOf(latest));
        }
        if (outcomes[0] === "failed") failed = true;
      }

      for (const { f, gates, reason } of capped) await leave(f, "held-back", gates, reason);

      const count = (outcome: AutopilotLine["outcome"]) => lines.filter((l) => l.outcome === outcome).length;
      const parts = settings.dryRun
        ? [`${times(count("would-run"), "fix")} would run`]
        : [`${times(count("applied"), "fix")} run`, ...(count("failed") ? [`${count("failed")} failed`] : [])];
      if (count("held-back")) parts.push(`${count("held-back")} held back`);
      if (count("refused")) parts.push(`${count("refused")} refused`);
      if (waiting.length) parts.push(`waiting on ${waiting.join("; ")}`);
      pilot(`${parts.join(", ")}.`);

      const broken = auditBroken === undefined ? undefined : `the audit log could not take a record (${auditBroken}); what was run is above and in the message`;
      return { ...(lines.length > 0 || broken ? { notice: tell(lines, broken) } : {}), failed: failed || broken !== undefined };
    },
  };
}

/** The risk of one command; a command that is not one CloudPilot runs is the worst. */
function riskOf(command: string): "caution" | "dangerous" {
  try {
    return commandRisk(command);
  } catch {
    return "dangerous";
  }
}

/** Why a finding's fix is not one that can be undone and is the rule's own, or undefined when it is. */
function fixProblem(f: Finding): string | undefined {
  const rule = AUTOPILOT_RULES[f.pattern];
  if (!rule?.ok) return `Autopilot never runs this rule: ${rule?.reason ?? "it is not a rule CloudPilot has."}`;
  if (f.resourceIds.length !== 1) return "A finding of this rule names exactly one resource, and this one does not.";
  if (f.fix.risk === "dangerous") return "The finding marks its fix as permanent, and autopilot never runs a permanent fix.";
  if (f.fix.risk !== "caution") return "The finding does not say its fix can be undone, so it is not run.";
  for (const command of f.fix.commands) {
    if (riskOf(command) === "dangerous") return `A command in the fix cannot be undone, or is not one CloudPilot runs, whatever the scan calls the fix: ${command}`;
  }
  const expected = rule.commands(f);
  if (f.fix.commands.length !== expected.length || f.fix.commands.some((c, n) => c !== expected[n])) {
    return `The fix is not the one this rule prints for ${f.resourceIds[0]}. Expected: ${expected.join(" ; ")}`;
  }
  return undefined;
}
