/**
 * `cloudpilot watch --autopilot` as a person runs it: the real command, a
 * stand-in for the AWS endpoint it scans, stand-in `aws` and `kubectl`
 * programs on the PATH that write down how they were called and change
 * nothing, and a webhook on 127.0.0.1. Nothing real is touched.
 *
 * A round waits at least 15 minutes before the next, so a run here is one
 * round. What needs several rounds (the count of rounds in a row, the total
 * cap) is held to the gates in autopilot.test.ts, through the watch loop.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AuditEntry } from "../src/apply.js";
import { PATTERNS } from "../src/types.js";
import { AUTOPILOT_QUALIFYING } from "../src/autopilot.js";
import { cliRun, FIXTURE, fakeKubectl } from "./helpers.js";
import { rig, type Account } from "./autopilot-rig.js";
import { hook, SECRET } from "./webhook.js";

const KUBE_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kube-lab.json");
const VOL = (n: number) => `vol-0a1b2c3d4e5f6${String(n).padStart(4, "0")}`;
const attached = (n: number, sizeGb = 100 * n) => ({ id: VOL(n), sizeGb, attachedTo: "i-0a1b2c3d4e5f60003" });
const ACCOUNT: Account = { volumes: [attached(1)], buckets: [{ name: "neglected" }] };
const BOTH = "gp2-volume,bucket-without-lifecycle";

const auditOf = (cwd: string): AuditEntry[] => {
  const file = join(cwd, ".cloudpilot/audit.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const eventsOf = (server: { requests: Array<{ body: string }> }) => server.requests.map((r) => JSON.parse(r.body));

/** A run in a fresh directory, with the stand-ins, closed afterwards. */
async function within(account: Account, body: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>) {
  const r = await rig(account);
  try {
    await body(r);
  } finally {
    await r.close();
  }
}

/** What a read-only scan is allowed to send to AWS: the query actions that describe, and GETs to S3. */
const onlyReads = (requests: Array<{ method: string; action: string }>) =>
  requests.every((q) => (q.action ? /^(Describe|Get)[A-Z]/.test(q.action) : q.method === "GET"));

// The dry run

test("a dry run says what would run, in the output and in the message, and runs nothing and records nothing", async () => {
  await within(ACCOUNT, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await r.run(r.watchArgs("--autopilot", BOTH, "--autopilot-after", "1", "--autopilot-dry-run", "--notify", server.url));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(r.calls(), [], "the stand-in aws was never started");
      assert.equal(existsSync(join(r.cwd, ".cloudpilot/audit.jsonl")), false, "a dry run writes no audit log");
      assert.match(run.stderr, /^AUTOPILOT IS ON, AS A DRY RUN: nothing will be run\. Each round it says what it would run for gp2-volume, bucket-without-lifecycle/m);
      assert.match(run.stdout, /\$ aws ec2 modify-volume --volume-id vol-0a1b2c3d4e5f60001 --volume-type gp3 --region ap-south-1\n {2}Dry run: nothing was run\./);
      assert.match(run.stdout, /Autopilot \(dry run\): 2 fixes would run\./);
      const messages = eventsOf(server);
      assert.deepEqual(messages.map((m) => m.event).sort(), ["autopilot", "first-report"]);
      const dry = messages.find((m) => m.event === "autopilot");
      assert.equal(dry.dryRun, true);
      assert.deepEqual(dry.lines.map((l: { outcome: string }) => l.outcome), ["would-run", "would-run"]);
      assert.match(dry.text, /^CloudPilot autopilot \(dry run\): 2 fixes would run, AWS account 123456789012\n/);
      assert.match(dry.text, /This is a dry run: nothing was run/);
      assert.ok(!(run.stdout + run.stderr).includes(SECRET));
    } finally {
      await server.close();
    }
  });
});

// A real run

test("a run fixes what passes the gates through the program's own arguments, records it with its gates, and tells the webhook what changed and the way back", async () => {
  await within(ACCOUNT, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await r.run(r.watchArgs("--autopilot", BOTH, "--autopilot-after", "1", "--notify", server.url));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(
        r.calls().map((c) => c.args),
        [
          ["ec2", "modify-volume", "--volume-id", VOL(1), "--volume-type", "gp3", "--region", "ap-south-1"],
          ["s3api", "put-bucket-lifecycle-configuration", "--bucket", "neglected", "--lifecycle-configuration", r.calls()[1]!.args[5]!, "--region", "ap-south-1"],
        ],
      );
      assert.equal(JSON.parse(r.calls()[1]!.args[5]!).Rules[0].ID, "cloudpilot-abort-incomplete-uploads-and-tier-down", "the JSON arrived as one argument");
      assert.ok(onlyReads(r.requests), "the scan sent AWS only reads");

      const log = auditOf(r.cwd);
      assert.deepEqual(log.map((e) => [e.outcome, e.finding.pattern, e.scope, e.target, e.risk, e.which]), [
        ["applied", "gp2-volume", "account", "123456789012", "caution", "fix"],
        ["applied", "bucket-without-lifecycle", "account", "123456789012", "caution", "fix"],
      ]);
      assert.ok(log.every((e) => e.autopilot && e.autopilot.gates.length === 7 && e.commands.every((c) => c.exitCode === 0)));
      assert.match(log[0]!.wayBack, /the volume can be changed back to gp2 after AWS's 6-hour modification cooldown/);

      assert.match(run.stderr, /^AUTOPILOT IS ON\. This watch will RUN fixes, not only read: for gp2-volume, bucket-without-lifecycle, and only those\./m);
      assert.match(run.stdout, /Autopilot: 2 fixes run\./);

      const audit = await r.run(["audit"]);
      assert.match(audit.stdout, /APPLIED {3}vol-0a1b2c3d4e5f60001 {2}\(account 123456789012, ap-south-1\) {2}by \S+ \[autopilot\]/);
      assert.match(audit.stdout, /Autopilot gates passed: rule named; fix can be undone; confidence 0\.9 \(at least 0\.9\); in 1 round of this watch in a row \(at least 1\); scan taken in this round, region read in full; no earlier fix on this resource; within the caps \(1 of 3 this round, 1 of 10 in all\)/);
      assert.equal(JSON.parse((await r.run(["audit", "--json"])).stdout)[0].autopilot.gates[0], "rule named");

      const messages = eventsOf(server);
      const sent = messages.find((m) => m.event === "autopilot");
      assert.equal(sent.dryRun, false);
      assert.match(sent.text, /^CloudPilot autopilot: 2 fixes run, AWS account 123456789012\n/);
      assert.match(sent.text, /Each fix marked RAN or FAILED was run against the account, with the way back given for it\./);
      assert.match(sent.text, /1\. RAN {2}\$2\.28\/mo {2}100 GB gp2 volume can move to gp3 \(vol-0a1b2c3d4e5f60001\), region ap-south-1\. Way back: Online and reversible: the volume can be changed back to gp2 after AWS's 6-hour modification cooldown\./);
      assert.match(sent.text, /2\. RAN .*Bucket neglected has no lifecycle rule .*Way back: Remove the rule again with: aws s3api delete-bucket-lifecycle --bucket neglected --region ap-south-1\. Objects already moved to Standard-IA stay there\./);
      const findings = messages.find((m) => m.event === "first-report");
      assert.match(findings.text, /Nothing has been changed by this message: every fix listed is a proposal\. Autopilot is on for gp2-volume, bucket-without-lifecycle/);
      assert.ok(!(run.stdout + run.stderr).includes(SECRET));
    } finally {
      await server.close();
    }
  });
});

test("the profile the watch reads with is the profile its fixes run with", async () => {
  await within({ volumes: [attached(1)] }, async (r) => {
    const run = await r.run(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1", "--profile", "ops"), {});
    // The scan itself cannot use a profile against the stand-in endpoint, which replaces credentials; the fix still carries it.
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(r.calls().map((c) => c.profile), ["ops"]);
  });
});

test("with the default of two rounds in a row, a one-round watch runs nothing and says what it is waiting for", async () => {
  await within(ACCOUNT, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await r.run(r.watchArgs("--autopilot", BOTH, "--notify", server.url));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(r.calls(), []);
      assert.deepEqual(auditOf(r.cwd), [], "waiting is not a decision, so it is not recorded");
      assert.match(run.stdout, /Autopilot: 0 fixes run, waiting on vol-0a1b2c3d4e5f60001 \(in 1 round of the 2 it needs\); neglected \(in 1 round of the 2 it needs\)\./);
      assert.deepEqual(eventsOf(server).map((m) => m.event), ["first-report"], "no autopilot message when it did nothing");
      assert.match(run.stderr, /after it has been in 2 rounds of this watch in a row/);
    } finally {
      await server.close();
    }
  });
});

// Never twice

test("a resource is never tried twice, across restarts from the same directory", async () => {
  await within(ACCOUNT, async (r) => {
    const args = r.watchArgs("--autopilot", BOTH, "--autopilot-after", "1");
    assert.equal((await r.run(args)).status, 0);
    assert.equal(r.calls().length, 2);
    // The stand-in account still has both findings, as an account whose fix did not take would.
    const again = await r.run(args);
    assert.equal(again.status, 0, again.stderr);
    const third = await r.run(args);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(r.calls().length, 2, "neither restart ran anything");
    const log = auditOf(r.cwd);
    assert.deepEqual(log.map((e) => e.outcome), ["applied", "applied", "refused", "refused", "refused", "refused"]);
    assert.match(log[2]!.reason!, /A fix was already tried on this resource \(applied at \S+, by autopilot\)\. Autopilot never tries a resource twice: run cloudpilot apply \S+ to do it yourself\./);
    assert.match(again.stdout, /refused vol-0a1b2c3d4e5f60001 in ap-south-1: A fix was already tried on this resource/);
  });
});

test("a failed fix is recorded, said, ends the run non-zero, and is not tried again after a restart", async () => {
  await within({ volumes: [attached(1)] }, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const args = r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1", "--notify", server.url);
      const run = await r.run(args, { STAND_IN_FAIL: "modify-volume" });
      assert.equal(run.status, 1);
      assert.match(run.stdout, /Failed with exit code 254\. Nothing after this was run\./);
      const [entry] = auditOf(r.cwd);
      assert.deepEqual([entry!.outcome, entry!.commands[0]!.exitCode], ["failed", 254]);
      assert.match(entry!.commands[0]!.output!, /UnauthorizedOperation/);
      const message = eventsOf(server).find((m) => m.event === "autopilot");
      assert.match(message.text, /^CloudPilot autopilot: 0 fixes run, 1 failed, AWS account 123456789012\n/);
      assert.match(message.text, /1\. FAILED {2}\$2\.28\/mo .*Way back: Online and reversible/);
      assert.equal(r.calls().length, 1);

      const restart = await r.run(args);
      assert.equal(r.calls().length, 1, "the failed fix is not retried");
      assert.match(restart.stdout, /already tried on this resource \(failed at/);
      assert.equal(auditOf(r.cwd).map((e) => e.outcome).join(), "failed,refused");
    } finally {
      await server.close();
    }
  });
});

// The caps and the first failure

test("the cap on a round runs the biggest savings first and holds the rest back, recorded, said and not run", async () => {
  await within({ volumes: [attached(1), attached(2), attached(3), attached(4)] }, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await r.run(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1", "--autopilot-max", "2", "--notify", server.url));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(r.calls().map((c) => c.args[3]), [VOL(4), VOL(3)]);
      assert.deepEqual(auditOf(r.cwd).map((e) => [e.finding.resourceIds[0], e.outcome]), [[VOL(4), "applied"], [VOL(3), "applied"], [VOL(2), "held-back"], [VOL(1), "held-back"]]);
      assert.match(run.stdout, /Autopilot: 2 fixes run, 2 held back\./);
      const message = eventsOf(server).find((m) => m.event === "autopilot");
      assert.match(message.text, /^CloudPilot autopilot: 2 fixes run, 2 held back, AWS account/);
      assert.match(message.text, /3\. HELD BACK .*\(vol-0a1b2c3d4e5f60002\).*Held back: the cap of 2 fixes a round was reached\./);
    } finally {
      await server.close();
    }
  });
  await within({ volumes: [attached(1), attached(2), attached(3)] }, async (r) => {
    const run = await r.run(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1", "--autopilot-max-total", "1"));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(r.calls().length, 1);
    assert.match(auditOf(r.cwd).at(-1)!.reason!, /the cap of 1 fixes for this watch was reached/);
  });
});

test("the first failure stops the round: the later fixes are held back, recorded, and never started", async () => {
  await within({ volumes: [attached(1), attached(2), attached(3)] }, async (r) => {
    const run = await r.run(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1"), { STAND_IN_FAIL: VOL(3) });
    assert.equal(run.status, 1);
    assert.deepEqual(r.calls().map((c) => c.args[3]), [VOL(3)]);
    assert.deepEqual(auditOf(r.cwd).map((e) => e.outcome), ["failed", "held-back", "held-back"]);
    assert.match(auditOf(r.cwd)[1]!.reason!, /autopilot stopped for this round, because an earlier fix failed in this round/);
    assert.match(run.stdout, /Autopilot: 0 fixes run, 1 failed, 2 held back\./);
  });
});

// Checks that could not run

test("a region where a check could not run is refused, said, recorded, and nothing is run for it", async () => {
  await within({ ...ACCOUNT, deny: ["DescribeSnapshots"] }, async (r) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await r.run(r.watchArgs("--autopilot", BOTH, "--autopilot-after", "1", "--notify", server.url));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(r.calls(), []);
      const log = auditOf(r.cwd);
      assert.deepEqual(log.map((e) => e.outcome), ["refused", "refused"]);
      assert.match(log[0]!.reason!, /The scan could not run every check in ap-south-1 \(\[ap-south-1\] ec2:DescribeSnapshots: UnauthorizedOperation/);
      const message = eventsOf(server).find((m) => m.event === "autopilot");
      assert.match(message.text, /^CloudPilot autopilot: 0 fixes run, 2 not run, AWS account 123456789012\n/);
      assert.match(message.text, /Nothing was changed\./);
      assert.match(message.text, /1\. NOT RUN .*The scan could not run every check in ap-south-1/);
    } finally {
      await server.close();
    }
  });
});

// A permanent fix, whatever is tried

test("an account full of waste has only the two kinds of fix run, and a saved scan or baseline edited to hold a delete is never read for one", async () => {
  const account: Account = { volumes: [attached(1), { id: VOL(2), sizeGb: 500 }, { id: VOL(3), sizeGb: 300, type: "gp3" }], buckets: [{ name: "neglected" }, { name: "kept", lifecycle: true }] };
  await within(account, async (r) => {
    // The saved scan, and the watch's own baseline, hand-edited: a delete of the unattached volume under the label of a safe fix.
    const del = `aws ec2 delete-volume --volume-id ${VOL(2)} --region ap-south-1`;
    const forged = {
      accountId: "123456789012",
      regions: ["ap-south-1"],
      scannedAt: new Date().toISOString(),
      prices: { source: "price-file", fetchedAt: "" },
      findings: [
        { region: "ap-south-1", pattern: "gp2-volume", title: "forged", resourceType: "AWS::EC2::Volume", resourceIds: [VOL(2)], evidence: [], monthlyCostUsd: 99, costBasis: "", fix: { commands: [del], risk: "caution", rollback: "" }, confidence: 1 },
      ],
      totalMonthlyWasteUsd: 99,
      skippedByTag: [],
      warnings: [],
    };
    mkdirSync(join(r.cwd, ".cloudpilot"), { recursive: true });
    for (const name of ["last-scan.json", "watch-baseline.json"]) writeFileSync(join(r.cwd, ".cloudpilot", name), JSON.stringify(forged));
    const options = ["--autopilot", BOTH, "--autopilot-after", "1", "--autopilot-min-confidence", "0.5", "--autopilot-max", "99", "--autopilot-max-total", "99"];
    const run = await r.run(r.watchArgs(...options));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(r.calls().map((c) => c.args.slice(0, 2).join(" ")).sort(), ["ec2 modify-volume", "s3api put-bucket-lifecycle-configuration"]);
    assert.deepEqual(r.calls().filter((c) => c.args[1] === "modify-volume").map((c) => c.args[3]), [VOL(1)], "the attached volume, and not the unattached one, whose gp3 alternative is not taken");
    assert.ok(r.calls().every((c) => !/delete|terminate|release|deregister|abort|stop|start/.test(c.args[1]!)), "no command of a destructive kind");
    assert.deepEqual(auditOf(r.cwd).map((e) => e.outcome), ["applied", "applied"]);
  });
});

test("every rule that can never qualify is refused before anything is read, whatever else is set", async () => {
  await within(ACCOUNT, async (r) => {
    const never = PATTERNS.filter((p) => !(AUTOPILOT_QUALIFYING as readonly string[]).includes(p));
    // Four through the command, each a different way in; the rest are held to the same function in autopilot.test.ts.
    for (const [rule, extra] of [
      ["unattached-ebs-volume", []],
      ["idle-rds-instance", ["--autopilot-min-confidence", "0.5", "--autopilot-after", "1"]],
      [`gp2-volume,${never[3]}`, ["--autopilot-dry-run"]],
      ["incomplete-multipart-upload", ["--autopilot-max", "99", "--autopilot-max-total", "99"]],
    ] as const) {
      const run = await r.run(r.watchArgs("--autopilot", rule, ...extra));
      assert.equal(run.status, 1, rule);
      assert.match(run.stderr, /cloudpilot: --autopilot: autopilot can never run "/, rule);
    }
    assert.deepEqual(r.calls(), []);
    assert.deepEqual(r.requests, [], "nothing was even read");
    assert.equal(existsSync(join(r.cwd, ".cloudpilot")), false);
  });
});

// Refusals

test("autopilot is refused before anything runs, and before anything is read, for each way it cannot be trusted", async () => {
  await within(ACCOUNT, async (r) => {
    const refused = async (args: string[], message: RegExp, env: Record<string, string> = {}) => {
      const run = await r.run(args, env);
      assert.equal(run.status, 1, args.join(" "));
      assert.match(run.stderr, message, args.join(" "));
      assert.doesNotMatch(run.stdout, /Autopilot|AUTOPILOT/);
    };
    await refused(["watch", "--replay", FIXTURE, "--autopilot", "gp2-volume", "--max-runs", "1"], /--autopilot cannot be used with --replay: a recording is not the account as it is now, and a fix is never run from one\./);
    await refused(["watch", "--redact-account", "--autopilot", "gp2-volume", "--max-runs", "1"], /--autopilot cannot be used with --redact-account/);
    await refused(r.watchArgs("--autopilot", "all"), /--autopilot has no "all": name each rule/);
    await refused(r.watchArgs("--autopilot", "gp3-volume"), /"gp3-volume" is not a CloudPilot rule/);
    await refused(r.watchArgs("--autopilot", ""), /A name is empty here/);
    await refused(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-min-confidence", "0.95"), /always reported at confidence 0\.9, below --autopilot-min-confidence 0\.95/);
    await refused(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "0"), /--autopilot-after takes a whole number of one or more/);
    await refused(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-max", "many"), /--autopilot-max takes a whole number/);
    await refused(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-max-total", "-3"), /--autopilot-max-total takes a whole number/);
    await refused(r.watchArgs("--autopilot-after", "1"), /--autopilot-after only applies with --autopilot, which is off\. Nothing here runs a fix\./);
    await refused(r.watchArgs("--autopilot-dry-run"), /--autopilot-dry-run only applies with --autopilot, which is off/);
    await refused(["watch", "--kube", "--autopilot", "gp2-volume", "--max-runs", "1"], /--autopilot cannot be used with --kube/);
    await refused(["watch", "--kube", "--autopilot", "over-requested-workload", "--max-runs", "1"], /autopilot can never run "over-requested-workload": its fix restarts the workload's pods/);
    assert.deepEqual(r.calls(), []);
    assert.deepEqual(r.requests, []);
  });
});

test("inside a cluster autopilot is refused, for the cluster's own watch and for an account's, before kubectl or AWS is touched", async () => {
  await within(ACCOUNT, async (r) => {
    const kubectl = fakeKubectl(KUBE_FIXTURE);
    const pod = { ...kubectl.pod, ...r.env(), PATH: `${r.env().PATH}:${kubectl.env.PATH}` };
    const inPod = (args: string[]) => cliRun(args, { cwd: r.cwd, env: pod });
    const cluster = await inPod(["watch", "--kube", "--cluster-name", "prod-eu", "--autopilot", "gp2-volume", "--max-runs", "1"]);
    assert.equal(cluster.status, 1);
    assert.match(cluster.stderr, /--autopilot cannot be used inside a cluster: the watcher that runs in a cluster is read-only by design, and a fix is never run from it\./);
    const account = await inPod(r.watchArgs("--autopilot", "gp2-volume", "--autopilot-after", "1"));
    assert.equal(account.status, 1);
    assert.match(account.stderr, /cannot be used inside a cluster/);
    assert.equal(kubectl.started(), false, "kubectl was not started");
    assert.deepEqual(r.calls(), []);
    assert.deepEqual(r.requests, [], "nothing was read from AWS");
  });
});

test("an audit log that cannot be read stops autopilot before it starts, and nothing is run", async () => {
  await within(ACCOUNT, async (r) => {
    mkdirSync(join(r.cwd, ".cloudpilot/audit.jsonl"), { recursive: true });
    const run = await r.run(r.watchArgs("--autopilot", BOTH, "--autopilot-after", "1"));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--autopilot needs the audit log: \.cloudpilot\/audit\.jsonl is there but could not be read \(EISDIR\)/);
    assert.deepEqual(r.calls(), []);
    assert.deepEqual(r.requests, []);
  });
});

// Without --autopilot

test("without --autopilot, watch reads and changes nothing: no program is started, no audit log is made, the same account and rules", async () => {
  await within(ACCOUNT, async (r) => {
    const run = await r.run(r.watchArgs());
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(r.calls(), [], "neither aws nor kubectl was started");
    assert.equal(existsSync(join(r.cwd, ".cloudpilot/audit.jsonl")), false);
    assert.ok(onlyReads(r.requests));
    assert.match(run.stderr, /^Watching the AWS account every 6h, read-only\./m);
    assert.doesNotMatch(run.stdout + run.stderr, /[Aa]utopilot|AUTOPILOT/);
    assert.match(run.stdout, / 1\. {4}\$2\.28\/mo {2}100 GB gp2 volume can move to gp3/);
  });
});

test("the help says watch only reads unless autopilot is turned on, what it can run, and that a permanent fix never runs", async () => {
  const run = await cliRun(["watch", "--help"], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  const text = run.stdout.replace(/\s+/g, " ");
  assert.match(text, /It only reads, unless you turn on --autopilot/);
  assert.match(text, /--autopilot <rules> RUN the fix for these rules \(comma-separated, no "all"\) when a finding passes every gate, and only if it can be undone\. Off unless given\. A permanent fix is never run\. Can run today: gp2-volume, bucket-without-lifecycle\. Start with --autopilot-dry-run/);
  for (const flag of ["--autopilot-min-confidence <n>", "--autopilot-after <n>", "--autopilot-max <n>", "--autopilot-max-total <n>", "--autopilot-dry-run"]) assert.ok(text.includes(flag), flag);
  const top = await cliRun(["--help"], { blockNetwork: true });
  assert.match(top.stdout.replace(/\s+/g, " "), /watch --autopilot runs only the fixes that can be undone, for the rules you name/);
});
