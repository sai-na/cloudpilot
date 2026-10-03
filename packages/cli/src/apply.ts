/**
 * Running a fix the reader approved.
 *
 * This is the only part of CloudPilot that can change anything, so it is kept
 * apart from scanning in every way:
 *
 * - It is its own command. A scan never runs anything.
 * - It runs only commands that a saved scan holds, and of those only the kinds
 *   CloudPilot's own rules print. Anything else in the file is refused.
 * - Commands go to the aws or kubectl program as a list of arguments, never
 *   through a shell, with the caller's own credentials.
 * - A fix that cannot be undone needs --allow-permanent and the resource ID
 *   typed back, and is never run unattended.
 * - What was asked for is written to the audit log whether it ran, failed,
 *   was declined or was refused.
 */
import { execFile } from "node:child_process";
import type { Finding, Fix, ScanResult } from "./types.js";

export class ApplyError extends Error {}

/**
 * Split a printed command into its arguments the way a shell would for plain
 * commands, and refuse everything a shell would treat specially: this never
 * expands, pipes, redirects or chains.
 */
export function tokenize(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && ['"', "\\", "$", "`"].includes(command[i + 1] ?? "")) current += command[++i];
      else if (ch === "$" || ch === "`") throw new ApplyError(`Not a plain command (it has ${ch} inside double quotes): ${command}`);
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      if (started) args.push(current);
      current = "";
      started = false;
    } else if (/[;&|<>$`\\\n\r(){}[\]*?!#~]/.test(ch)) {
      throw new ApplyError(`Not a plain command (it has ${JSON.stringify(ch)} outside quotes): ${command}`);
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new ApplyError(`Not a plain command (a quote is never closed): ${command}`);
  if (started) args.push(current);
  return args;
}

/** Every kind of command a CloudPilot rule prints as a fix. Nothing else is ever run. */
const RUNNABLE = [
  "aws ec2 modify-volume",
  "aws ec2 delete-volume",
  "aws ec2 release-address",
  "aws ec2 terminate-instances",
  "aws ec2 delete-snapshot",
  "aws ec2 deregister-image",
  "aws ec2 stop-instances",
  "aws ec2 wait instance-stopped",
  "aws ec2 modify-instance-attribute",
  "aws ec2 start-instances",
  "aws s3api put-bucket-lifecycle-configuration",
  "aws s3api abort-multipart-upload",
  "aws rds delete-db-instance",
  "aws rds stop-db-instance",
  "kubectl set resources",
  "kubectl delete persistentvolumeclaim",
  "kubectl delete persistentvolume",
];

/** The command as arguments, if it is one CloudPilot may run. */
export function runnable(command: string): string[] {
  const args = tokenize(command);
  const ok = RUNNABLE.some((kind) => {
    const words = kind.split(" ");
    return words.every((word, n) => args[n] === word);
  });
  if (!ok) throw new ApplyError(`CloudPilot only runs the kinds of command its own rules print, and this is not one: ${command}`);
  return args;
}

/** One fix chosen to run: which finding, which of its fixes, and the commands as arguments. */
export interface Plan {
  scan: ScanResult;
  finding: Finding;
  /** The resource ID the reader named. */
  named: string;
  which: "fix" | "alternative";
  fix: Fix;
  commands: Array<{ text: string; args: string[] }>;
  monthlySavingUsd: number;
}

export interface PlanOptions {
  /** Take the permanent fix where a finding has one. Without it only fixes that can be undone are chosen. */
  allowPermanent?: boolean;
  /** Refuse a scan older than this: the account may have changed since. */
  maxAgeHours: number;
  now: Date;
}

const where = (scan: ScanResult, f: Finding) => `${scan.cluster ? "namespace" : "region"} ${f.region}`;

/**
 * Work out what to run for each resource the reader named, across the saved
 * scans. Throws before anything runs if any of it is unclear.
 */
export function plan(scans: ScanResult[], names: string[], options: PlanOptions): Plan[] {
  if (names.length === 0) throw new ApplyError("Name the resource whose fix you want to run, for example: cloudpilot apply vol-0123456789abcdef0");
  return names.map((named) => {
    const matches = scans.flatMap((scan) => scan.findings.filter((f) => f.resourceIds.includes(named) || f.resourceIds.some((id) => `${f.region}/${id}` === named)).map((finding) => ({ scan, finding })));
    if (matches.length === 0) {
      throw new ApplyError(`No finding for ${named} in the saved scans. Run a scan first, or name a resource ID exactly as the report shows it.`);
    }
    if (matches.length > 1) {
      const choices = matches.map((m) => `  ${m.finding.region}/${m.finding.resourceIds[0]}  (${m.finding.title})`).join("\n");
      throw new ApplyError(`${named} matches more than one finding. Name one of:\n${choices}`);
    }
    const { scan, finding } = matches[0]!;

    const ageHours = (options.now.getTime() - Date.parse(scan.scannedAt)) / 3_600_000;
    if (!Number.isFinite(ageHours) || Math.abs(ageHours) > options.maxAgeHours) {
      const when = ageHours < 0 ? `more than ${options.maxAgeHours} hours in the future, so a clock is wrong` : `more than ${options.maxAgeHours} hours ago`;
      throw new ApplyError(`The scan that found ${named} is from ${scan.scannedAt}, ${when}. Things may have changed since: scan again, then apply.`);
    }

    // The fix that can be undone, unless the permanent one was asked for.
    const alt = finding.alternative;
    let which: Plan["which"];
    if (options.allowPermanent) which = "fix";
    else if (finding.fix.risk === "caution") which = "fix";
    else if (alt && alt.risk === "caution") which = "alternative";
    else {
      throw new ApplyError(
        `The only fix for ${named} is permanent (${finding.title}). CloudPilot runs it only when asked to with --allow-permanent, and then only at a terminal, after you type the resource ID back.`,
      );
    }
    const fix = which === "fix" ? finding.fix : alt!;
    return {
      scan,
      finding,
      named,
      which,
      fix,
      commands: fix.commands.map((text) => ({ text, args: runnable(text) })),
      monthlySavingUsd: which === "fix" ? finding.monthlyCostUsd : alt!.monthlySavingUsd,
    };
  });
}

export type Outcome = "applied" | "failed" | "declined" | "refused";

/** One line of the audit log: what was asked for and what happened. */
export interface AuditEntry {
  at: string;
  user: string;
  scope: "account" | "cluster";
  /** The account ID or the kubectl context. */
  target: string;
  scannedAt: string;
  finding: { pattern: string; region: string; resourceIds: string[]; title: string; monthlyCostUsd: number };
  which: Plan["which"];
  risk: Fix["risk"];
  outcome: Outcome;
  /** Why it was refused or declined, when it was. */
  reason?: string;
  commands: Array<{ command: string; exitCode?: number; output?: string }>;
  wayBack: string;
}

export interface Runner {
  run(program: string, args: string[]): Promise<{ exitCode: number; output: string }>;
}

/** Runs the real aws or kubectl, with the caller's environment and nothing between. */
export function programRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  return {
    run: (program, args) =>
      new Promise((resolve, reject) => {
        execFile(program, args, { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(new ApplyError(`${program} was not found on your PATH. CloudPilot runs a fix through the ${program} command, with your own credentials.`));
          }
          const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ exitCode, output: `${stdout}${stderr}`.trim() });
        });
      }),
  };
}

export interface ApplyContext {
  runner: Runner;
  /** Ask a question and return what was typed. Absent when there is no terminal to ask at. */
  ask?: (question: string) => Promise<string>;
  /** Run fixes that can be undone without asking. Never applies to permanent fixes. */
  yes?: boolean;
  /** Show what would run and stop. */
  dryRun?: boolean;
  say: (line: string) => void;
  record: (entry: AuditEntry) => Promise<void>;
  user: string;
  now: () => Date;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const OUTPUT_KEPT = 2000;

/** Show each chosen fix, get the go-ahead it needs, run it and record what happened. Returns each outcome in order. */
export async function apply(plans: Plan[], ctx: ApplyContext): Promise<Array<Outcome | "dry-run">> {
  const outcomes: Array<Outcome | "dry-run"> = [];
  let stopped = false;
  for (const p of plans) {
    const permanent = p.fix.risk === "dangerous";
    ctx.say("");
    ctx.say(`${p.finding.title}`);
    ctx.say(`  ${p.finding.resourceIds.join(", ")} in ${where(p.scan, p.finding)}, saving ${money(p.monthlySavingUsd)} a month`);
    ctx.say(`  ${permanent ? "PERMANENT: this cannot be undone." : "Can be undone."} ${p.fix.rollback}`);
    for (const c of p.commands) ctx.say(`  $ ${c.text}`);

    if (ctx.dryRun) {
      ctx.say("  Dry run: nothing was run.");
      outcomes.push("dry-run");
      continue;
    }

    const entry = (outcome: Outcome, commands: AuditEntry["commands"], reason?: string): AuditEntry => ({
      at: ctx.now().toISOString(),
      user: ctx.user,
      scope: p.scan.cluster ? "cluster" : "account",
      target: p.scan.accountId,
      scannedAt: p.scan.scannedAt,
      finding: { pattern: p.finding.pattern, region: p.finding.region, resourceIds: p.finding.resourceIds, title: p.finding.title, monthlyCostUsd: p.finding.monthlyCostUsd },
      which: p.which,
      risk: p.fix.risk,
      outcome,
      ...(reason ? { reason } : {}),
      commands,
      wayBack: p.fix.rollback,
    });
    const notRun = p.commands.map((c) => ({ command: c.text }));
    const skip = async (outcome: Outcome, reason: string) => {
      ctx.say(`  ${reason}`);
      await ctx.record(entry(outcome, notRun, reason));
      outcomes.push(outcome);
    };

    if (stopped) {
      await skip("refused", "Not run: an earlier fix failed, so everything after it was left alone.");
      continue;
    }
    if (permanent) {
      if (!ctx.ask) {
        await skip("refused", "Not run: a permanent fix is never run unattended. Run this at a terminal.");
        continue;
      }
      const typed = (await ctx.ask(`  Type ${p.named} to run this permanent fix, or press Enter to leave it: `)).trim();
      if (typed !== p.named) {
        await skip("declined", "Left alone: the resource ID was not typed back.");
        continue;
      }
    } else if (!ctx.yes) {
      if (!ctx.ask) {
        await skip("refused", "Not run: there is no terminal to ask at. Pass --yes to run fixes that can be undone without asking.");
        continue;
      }
      const answer = (await ctx.ask("  Run it? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        await skip("declined", "Left alone.");
        continue;
      }
    }

    const ran: AuditEntry["commands"] = [];
    let failed = false;
    for (const c of p.commands) {
      if (failed) {
        ran.push({ command: c.text });
        continue;
      }
      const result = await ctx.runner.run(c.args[0]!, c.args.slice(1));
      ran.push({ command: c.text, exitCode: result.exitCode, output: result.output.slice(0, OUTPUT_KEPT) });
      if (result.output) ctx.say(result.output.split("\n").map((line) => `    ${line}`).join("\n"));
      if (result.exitCode !== 0) {
        failed = true;
        ctx.say(`  Failed with exit code ${result.exitCode}. Nothing after this was run.`);
      }
    }
    await ctx.record(entry(failed ? "failed" : "applied", ran));
    outcomes.push(failed ? "failed" : "applied");
    if (failed) stopped = true;
    else ctx.say("  Done. Scan again to see it gone from the findings.");
  }
  return outcomes;
}

/** The audit log as a list a person can read, newest last. */
export function renderAudit(entries: AuditEntry[]): string {
  if (entries.length === 0) return "No fix has been run, declined or refused from this directory yet.";
  return entries
    .map((e) => {
      const head = `${e.at}  ${e.outcome.toUpperCase().padEnd(8)}  ${e.finding.resourceIds.join(", ")}  (${e.scope} ${e.target}, ${e.finding.region})  by ${e.user}`;
      const lines = [head, `    ${e.finding.title}${e.risk === "dangerous" ? "  [permanent]" : ""}`];
      if (e.reason) lines.push(`    ${e.reason}`);
      for (const c of e.commands) lines.push(`    ${c.exitCode === undefined ? "not run" : `exit ${c.exitCode}`.padEnd(7)}  ${c.command}`);
      if (e.outcome === "applied") lines.push(`    Way back: ${e.wayBack}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
