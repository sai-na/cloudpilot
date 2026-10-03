/**
 * Autopilot's gates, one at a time and together, on the real engine and the
 * real apply machinery. The findings come from running the real rules; the
 * only stand-ins are the program that would run a fix (it writes down what it
 * was asked to run) and the audit log (a list in memory). The same gates run
 * through the command, with stand-in aws and kubectl programs on the PATH, in
 * autopilot-cli.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readAuditWhole } from "../src/audit.js";
import { apply, commandRisk, isAuditEntry, plan, renderAudit, type AuditEntry, type Runner } from "../src/apply.js";
import { AUTOPILOT_DEFAULTS, AUTOPILOT_QUALIFYING, AUTOPILOT_RULES, autopilotBanner, autopilotRefusal, createAutopilot, lineOf, parseAutopilot, type AutopilotIO, type AutopilotSettings } from "../src/autopilot.js";
import { detect, gp3Command, lifecycleCommand } from "../src/detect.js";
import { collectCluster, type KubeReader } from "../src/kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { compose, plainText, parseTargets, type Notice } from "../src/notify.js";
import { PATTERNS, type BucketInfo, type Finding, type Inventory, type ScanResult, type VolumeInfo } from "../src/types.js";
import { watch, type WatchDeps } from "../src/watch.js";
import { everyAwsFinding, everyRuleBook, everyRuleInventory, scan } from "./scans.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-03T12:00:00Z");
const ROUND = new Date(NOW - 60_000);

// Findings from the real rules

const gp2 = (n: number, attached = true): VolumeInfo => ({ id: `vol-0a1b2c3d4e5f6${String(n).padStart(4, "0")}`, type: "gp2", sizeGb: 100 * n, state: attached ? "in-use" : "available", attachedTo: attached ? ["i-0a1b2c3d4e5f60003"] : [] });
const bucket = (name: string, gib = 1): BucketInfo => ({ name, hasLifecycle: false, objectCount: 3, bytes: gib * 1024 ** 3, truncated: false, multipartUploads: [] });
const inventory = (volumes: VolumeInfo[], buckets: BucketInfo[] = []): Inventory => ({ ...everyRuleInventory, volumes, snapshots: [], images: [], instances: [], rdsInstances: [], addresses: [], natGateways: [], loadBalancers: [], buckets });
/** A scan of this round, with the findings the real rules make for these volumes and buckets, biggest saving first. */
const account = (volumes: VolumeInfo[], buckets: BucketInfo[] = [], extra: Partial<ScanResult> = {}) => scan(detect(inventory(volumes, buckets), everyRuleBook), { scannedAt: new Date(NOW).toISOString(), ...extra });

const kubeFixture = JSON.parse(readFileSync(resolve(here, "fixtures/kube-lab.json"), "utf8"));
const kubeReader: KubeReader = { identity: async () => kubeFixture.identity, get: async (path) => kubeFixture.responses[path] };
const clusterScan: ScanResult = { ...detectCluster(await collectCluster(kubeReader, { lookbackHours: kubeFixture.lookbackHours, now: new Date(kubeFixture.recordedAt) }), OPENCOST_DEFAULTS), scannedAt: new Date(NOW).toISOString() };
const everyScan = scan(everyAwsFinding(), { scannedAt: new Date(NOW).toISOString() });
const every = [...everyScan.findings, ...clusterScan.findings];

const settings = (over: Partial<AutopilotSettings> = {}): AutopilotSettings => ({ rules: ["gp2-volume", "bucket-without-lifecycle"], minConfidence: 0.9, after: 1, maxPerRound: 3, maxTotal: 10, dryRun: false, ...over });

// The engine, with a runner that writes down what it was asked to run, and an audit log in memory

function pilot(over: Partial<AutopilotSettings> = {}, opts: { failOn?: string; log?: AuditEntry[]; unreadable?: boolean; unwritable?: boolean; failRecord?: boolean; missingProgram?: boolean; auditFile?: string; now?: () => Date } = {}) {
  const log: AuditEntry[] = opts.log ?? [];
  const ran: string[][] = [];
  const runner: Runner = {
    run: async (program, args) => {
      if (opts.missingProgram) throw new Error(`${program} was not found on your PATH.`);
      ran.push([program, ...args]);
      return opts.failOn && args.includes(opts.failOn) ? { exitCode: 254, output: "An error occurred (UnauthorizedOperation)" } : { exitCode: 0, output: "" };
    },
  };
  const io: AutopilotIO = {
    runner,
    audit: {
      read: async () => {
        // The real reader, over a real file, when a test gives one.
        if (opts.auditFile) return readAuditWhole(opts.auditFile);
        if (opts.unreadable) throw new Error(".cloudpilot/audit.jsonl is there but could not be read (EISDIR).");
        return [...log];
      },
      check: async () => {
        if (opts.unwritable) throw new Error("EROFS: read-only file system");
      },
      record: async (entry) => {
        if (opts.failRecord) throw new Error("ENOSPC: no space left on device");
        log.push(entry);
      },
    },
    user: "sai",
    now: opts.now ?? (() => new Date(NOW)),
  };
  const engine = createAutopilot(settings(over), io);
  const said: string[] = [];
  return {
    engine,
    log,
    ran,
    said,
    round: (scanned: ScanResult, signal = new AbortController().signal) => engine.round({ scan: scanned, startedAt: ROUND, say: (line) => said.push(line), signal }),
  };
}

const ids = (calls: string[][]) => calls.map((c) => (c.includes("--volume-id") ? c[c.indexOf("--volume-id") + 1] : c[c.indexOf("--bucket") + 1]));

// The table

test("the table covers every rule, and exactly the conversion to gp3 and the lifecycle rule can qualify", () => {
  assert.deepEqual(Object.keys(AUTOPILOT_RULES).sort(), [...PATTERNS].sort());
  assert.deepEqual(AUTOPILOT_QUALIFYING, ["gp2-volume", "bucket-without-lifecycle"]);
  for (const pattern of PATTERNS) {
    const rule = AUTOPILOT_RULES[pattern];
    if (!rule.ok) assert.match(rule.reason, /.{40}/, `${pattern} says why it never qualifies`);
  }
});

test("the table is true of the real rules: what qualifies is undoable, at its stated confidence and the exact commands; the rest is permanent or named as another kind of risk", () => {
  // Every finding every rule can make, with a lower bound on each rule's confidence (the cluster lab's findings have what they have).
  const byRule = (pattern: string) => every.filter((f) => f.pattern === pattern);
  assert.deepEqual([...new Set(every.map((f) => f.pattern))].sort(), [...PATTERNS].sort());
  for (const pattern of PATTERNS) {
    const rule = AUTOPILOT_RULES[pattern];
    for (const f of byRule(pattern)) {
      const commandsAreUndoable = f.fix.commands.every((c) => commandRisk(c) === "caution");
      if (rule.ok) {
        assert.equal(f.fix.risk, "caution", pattern);
        assert.ok(commandsAreUndoable, pattern);
        assert.equal(f.confidence, rule.confidence, pattern);
        assert.deepEqual(rule.commands(f), f.fix.commands, `${pattern}: the table's commands are the rule's`);
        assert.equal(f.alternative, undefined, pattern);
      } else if (["oversized-instance", "over-requested-workload"].includes(pattern)) {
        // Marked as one that can be undone, and left out for what undoing it costs, which the reason says.
        assert.equal(f.fix.risk, "caution", pattern);
      } else {
        assert.equal(f.fix.risk, "dangerous", `${pattern}: a rule that never qualifies is permanent (else say what else is wrong with it)`);
        // A permanent main fix with a gentler alternative says that autopilot does not take the alternative.
        if (f.alternative) assert.match(rule.reason, /never takes an alternative/, pattern);
      }
    }
  }
  assert.match((AUTOPILOT_RULES["incomplete-multipart-upload"] as { reason: string }).reason, /which is permanent, and autopilot never runs a permanent fix/);
  assert.match((AUTOPILOT_RULES["incomplete-multipart-upload"] as { reason: string }).reason, /discarded for good/);
  assert.match((AUTOPILOT_RULES["oversized-instance"] as { reason: string }).reason, /outage/);
  assert.match((AUTOPILOT_RULES["over-requested-workload"] as { reason: string }).reason, /restarts/);
});

test("the two commands are built in one place: the rules print what autopilot checks them against", () => {
  const found = account([gp2(1)], [bucket("neglected")]);
  assert.equal(found.findings.find((f) => f.pattern === "gp2-volume")!.fix.commands[0], gp3Command("ap-south-1", gp2(1).id));
  assert.equal(found.findings.find((f) => f.pattern === "bucket-without-lifecycle")!.fix.commands[0], lifecycleCommand("ap-south-1", "neglected"));
});

// The options

test("the options have the defaults, and a rule name that is unknown, empty, \"all\", or never qualifies is refused before anything runs", () => {
  assert.deepEqual(parseAutopilot({ autopilot: "gp2-volume" }), { rules: ["gp2-volume"], minConfidence: 0.9, after: 2, maxPerRound: 3, maxTotal: 10, dryRun: false });
  assert.deepEqual(AUTOPILOT_DEFAULTS, { minConfidence: 0.9, after: 2, maxPerRound: 3, maxTotal: 10 });
  assert.deepEqual(parseAutopilot({ autopilot: " gp2-volume , bucket-without-lifecycle,gp2-volume ", dryRun: true, after: "3", max: "1", maxTotal: "4", minConfidence: "0.9" }), {
    rules: ["gp2-volume", "bucket-without-lifecycle"],
    minConfidence: 0.9,
    after: 3,
    maxPerRound: 1,
    maxTotal: 4,
    dryRun: true,
  });
  assert.throws(() => parseAutopilot({ autopilot: "all" }), /has no "all": name each rule\. The rules it can run today are gp2-volume, bucket-without-lifecycle\./);
  assert.throws(() => parseAutopilot({ autopilot: "*" }), /has no "\*"/);
  assert.throws(() => parseAutopilot({ autopilot: "gp3-volume" }), /"gp3-volume" is not a CloudPilot rule/);
  for (const empty of ["", ",", "gp2-volume,", " "]) assert.throws(() => parseAutopilot({ autopilot: empty }), /A name is empty here/, JSON.stringify(empty));
  for (const bad of ["0", "-1", "1.5", "many", "", "1e3"]) {
    assert.throws(() => parseAutopilot({ autopilot: "gp2-volume", after: bad }), /--autopilot-after takes a whole number of one or more/, bad);
    assert.throws(() => parseAutopilot({ autopilot: "gp2-volume", max: bad }), /--autopilot-max takes a whole number/, bad);
    assert.throws(() => parseAutopilot({ autopilot: "gp2-volume", maxTotal: bad }), /--autopilot-max-total takes a whole number/, bad);
  }
  for (const bad of ["0", "-0.5", "1.1", "high", "", "NaN"]) assert.throws(() => parseAutopilot({ autopilot: "gp2-volume", minConfidence: bad }), /--autopilot-min-confidence takes a number above 0 and up to 1/, bad);
  // A rule that is reported at 0.9 and never higher cannot be asked for at a higher bar.
  assert.throws(() => parseAutopilot({ autopilot: "gp2-volume", minConfidence: "0.95" }), /always reported at confidence 0.9, below --autopilot-min-confidence 0.95, so autopilot would never run it/);
});

test("a rule that can never qualify is refused up front with its reason, whatever else is set: no option makes autopilot run a permanent fix", () => {
  const never = PATTERNS.filter((p) => !AUTOPILOT_QUALIFYING.includes(p as never));
  assert.equal(never.length, 14);
  const sets = [
    {},
    { minConfidence: "0.01" },
    { after: "1", max: "1000", maxTotal: "1000" },
    { dryRun: true, after: "1" },
    { minConfidence: "0.5", after: "1", max: "5", maxTotal: "50" },
  ];
  for (const pattern of never) {
    for (const extra of sets) {
      // Alone, and next to a rule that does qualify, which must not carry it in.
      for (const named of [pattern, `gp2-volume,${pattern}`, `${pattern},bucket-without-lifecycle`]) {
        assert.throws(() => parseAutopilot({ autopilot: named, ...extra }), (err: Error) => err.message.startsWith(`--autopilot: autopilot can never run "${pattern}": `) && err.message.includes((AUTOPILOT_RULES[pattern] as { reason: string }).reason), `${named} ${JSON.stringify(extra)}`);
      }
    }
  }
  // The permanent ones say so, and one with a gentler alternative says that it is not taken.
  assert.throws(() => parseAutopilot({ autopilot: "unattached-ebs-volume" }), /deletes the volume, which is permanent, and autopilot never runs a permanent fix\. It has a fix that can be undone \(convert it from gp2 to gp3\), but autopilot never takes an alternative in place of the fix a finding proposes/);
  assert.throws(() => parseAutopilot({ autopilot: "idle-rds-instance" }), /deletes the database.*never takes an alternative/);
});

test("autopilot is refused for a replay, a hidden account, a cluster and a watch inside one, with the reason", () => {
  assert.equal(autopilotRefusal({ inCluster: false }), undefined);
  assert.match(autopilotRefusal({ replay: "dir", inCluster: false })!, /cannot be used with --replay: a recording is not the account as it is now/);
  assert.match(autopilotRefusal({ redactAccount: true, inCluster: false })!, /cannot be used with --redact-account/);
  assert.match(autopilotRefusal({ inCluster: true })!, /cannot be used inside a cluster: the watcher that runs in a cluster is read-only by design/);
  assert.match(autopilotRefusal({ kube: true, inCluster: false })!, /cannot be used with --kube/);
  assert.match(autopilotRefusal({ kube: true, inCluster: true })!, /inside a cluster/);
});

test("the banner says in plain words that it runs fixes, which rules, the gates and the caps, and that a permanent fix never runs", () => {
  const text = autopilotBanner(settings({ after: 2, rules: ["gp2-volume", "bucket-without-lifecycle"] })).join("\n");
  assert.match(text, /^AUTOPILOT IS ON\. This watch will RUN fixes, not only read: for gp2-volume, bucket-without-lifecycle, and only those\./);
  assert.match(text, /A permanent fix is never run by autopilot, whatever else is set, and nor is the gentler alternative/);
  assert.match(text, /confidence 0\.9 or more, after it has been in 2 rounds of this watch in a row, once per resource .* at most 3 a round and 10 in all/);
  assert.match(text, /written to \.cloudpilot\/audit\.jsonl/);
  const dry = autopilotBanner(settings({ dryRun: true })).join("\n");
  assert.match(dry, /^AUTOPILOT IS ON, AS A DRY RUN: nothing will be run\./);
  // A dry run writes no audit log, so the banner must not send anyone there.
  assert.match(dry, /A dry run writes nothing to \.cloudpilot\/audit\.jsonl\. What it would run, and what it would hold back or refuse, is printed here each round/);
  assert.doesNotMatch(dry, /is written to \.cloudpilot\/audit\.jsonl/);
  assert.doesNotMatch(dry, /cloudpilot audit/);
});

// Gate 1: only the rules named

test("a finding of a rule that was not named is left alone, however well it would pass the rest", async () => {
  const p = pilot({ rules: ["gp2-volume"] });
  const result = await p.round(account([gp2(1)], [bucket("neglected")]));
  assert.deepEqual(ids(p.ran), [gp2(1).id], "the bucket's lifecycle rule was not asked for");
  assert.equal(p.log.length, 1);
  assert.equal(result.failed, false);
});

// Gate 2: only a fix that can be undone

test("what runs is the finding's own fix, as a list of arguments: a conversion to gp3 and a lifecycle rule, and nothing else on an account full of findings", async () => {
  const p = pilot({ maxPerRound: 10 });
  await p.round(everyScan);
  assert.deepEqual(
    p.ran.map((c) => c.slice(0, 3).join(" ")).sort(),
    ["aws ec2 modify-volume", "aws s3api put-bucket-lifecycle-configuration"],
    "of every finding the rules make, only these two kinds of fix ran: no delete, no stop, no terminate, no abort",
  );
  // The unattached volume has a gp3 alternative, and it is not taken in place of the delete: only the attached volume was converted.
  assert.deepEqual(ids(p.ran).sort(), ["neglected", "vol-0a1b2c3d4e5f60003"]);
  assert.ok(p.ran.every((c) => c[0] === "aws"));
});

/** Ways a finding can be made to look like one autopilot may run, when it is not. */
function forgeries(f: Finding): Array<[string, Finding]> {
  const del = ["aws ec2 delete-volume --volume-id vol-0a1b2c3d4e5f60001 --region ap-south-1"];
  const variants: Array<[string, Finding]> = [];
  for (const pattern of AUTOPILOT_QUALIFYING) {
    const id = f.resourceIds[0]!;
    variants.push([`${f.pattern} as ${pattern}, risk relabelled`, { ...f, pattern, fix: { ...f.fix, risk: "caution" }, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, risk kept`, { ...f, pattern, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, a delete with a caution label`, { ...f, pattern, resourceIds: [id], fix: { commands: del, risk: "caution", rollback: "" }, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, the right fix with a delete after it`, { ...f, pattern, fix: { commands: [...AUTOPILOT_RULES[pattern].ok ? (AUTOPILOT_RULES[pattern] as { commands: (f: Finding) => string[] }).commands({ ...f, pattern, resourceIds: [id] }) : [], ...del], risk: "caution", rollback: "" }, resourceIds: [id], confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, the right fix for another resource`, { ...f, pattern, resourceIds: ["vol-0a1b2c3d4e5f60009"], fix: { commands: [gp3Command(f.region, id)], risk: "caution", rollback: "" }, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, a gp3 change that also asks for provisioned IOPS`, { ...f, pattern, resourceIds: [id], fix: { commands: [`${gp3Command(f.region, id)} --iops 64000`], risk: "caution", rollback: "" }, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, the alternative made the fix`, { ...f, pattern, resourceIds: [id], fix: f.alternative ? { commands: f.alternative.commands, risk: "caution", rollback: "" } : f.fix, confidence: 1 }]);
    variants.push([`${f.pattern} as ${pattern}, two resources`, { ...f, pattern, resourceIds: [id, "vol-0a1b2c3d4e5f60009"], confidence: 1 }]);
  }
  variants.push([`${f.pattern} with a pattern no rule has`, { ...f, pattern: "delete-everything" as never, confidence: 1 }]);
  return variants;
}

test("no finding the rules make, and no forgery of one, gets a permanent fix run: a relabelled delete, a delete on the end, another resource, a command of another kind", async () => {
  let tried = 0;
  for (const f of every) {
    for (const [label, forged] of forgeries(f)) {
      const p = pilot({ maxPerRound: 100, maxTotal: 100 });
      const result = await p.round(scan([forged], { scannedAt: new Date(NOW).toISOString(), regions: ["ap-south-1", forged.region] }));
      tried++;
      // A forgery that happens to be exactly what a real finding of that rule is has nothing wrong with it.
      const genuine = AUTOPILOT_RULES[forged.pattern]?.ok && (AUTOPILOT_RULES[forged.pattern] as { commands: (f: Finding) => string[] }).commands(forged).join("\n") === forged.fix.commands.join("\n") && forged.fix.risk === "caution" && forged.resourceIds.length === 1;
      if (genuine) continue;
      assert.deepEqual(p.ran, [], label);
      assert.ok(p.log.every((e) => e.outcome === "refused" && e.autopilot), label);
      // A pattern that is not one of the rules named is not autopilot's business at all.
      const named = (p.engine.settings.rules as string[]).includes(forged.pattern);
      assert.equal(p.log.length, named ? 1 : 0, label);
      assert.equal(result.failed, false, label);
      assert.equal(result.notice?.kind, named ? "autopilot" : undefined, label);
    }
  }
  assert.ok(tried > 200, `${tried} forgeries`);
});

test("a finding whose fix says it is permanent, or says nothing, is refused and recorded as such", async () => {
  const [f] = account([gp2(1)]).findings;
  for (const [risk, reason] of [["dangerous", /marks its fix as permanent/], [undefined, /does not say its fix can be undone/], ["safe", /does not say its fix can be undone/]] as const) {
    const p = pilot();
    await p.round(scan([{ ...f!, fix: { ...f!.fix, risk: risk as never } }], { scannedAt: new Date(NOW).toISOString() }));
    assert.deepEqual(p.ran, []);
    assert.match(p.log[0]!.reason!, reason);
    assert.equal(p.log[0]!.risk, "dangerous", "a fix that does not say it can be undone is recorded as the worst");
  }
});

test("apply itself still refuses a permanent fix with nobody to type the ID: the second lock behind autopilot's gate", async () => {
  const del = everyScan.findings.find((x) => x.pattern === "unattached-ebs-volume")!;
  const [permanent] = plan([{ ...everyScan, findings: [del] }], [del.resourceIds[0]!], { maxAgeHours: 24, now: new Date(NOW), allowPermanent: true });
  const ran: string[][] = [];
  const log: AuditEntry[] = [];
  // What autopilot hands apply: yes, and no way to ask.
  const out = await apply([permanent!], { runner: { run: async (p, a) => (ran.push([p, ...a]), { exitCode: 0, output: "" }) }, yes: true, say: () => {}, record: async (e) => void log.push(e), user: "x", now: () => new Date(NOW), autopilot: () => ({ gates: [] }) });
  assert.deepEqual(out, ["refused"]);
  assert.deepEqual(ran, []);
  assert.match(log[0]!.reason!, /a permanent fix is never run unattended/);
});

// Gate 3: confidence

test("a finding below the confidence bar waits and is not run, and one at the bar runs", async () => {
  const [f] = account([gp2(1)]).findings;
  for (const [confidence, runs] of [[0.9, true], [0.9001, true], [0.89, false], [0.5, false], [Number.NaN, false], [undefined as never, false]] as const) {
    const p = pilot();
    await p.round(scan([{ ...f!, confidence }], { scannedAt: new Date(NOW).toISOString() }));
    assert.equal(p.ran.length, runs ? 1 : 0, String(confidence));
    if (!runs) {
      assert.deepEqual(p.log, [], "waiting is not a decision about the fix, so it is not recorded");
      assert.match(p.said.at(-1)!, /Autopilot: 0 fixes run, waiting on vol-\S+ \(confidence (0\.\d+|NaN|undefined), needs 0\.9\)\./);
    }
  }
  // A higher bar than the rule ever reaches runs nothing: asked for at 0.9, a finding at 0.89 waits; the option cannot lower what a rule says.
  const strict = pilot({ minConfidence: 0.95 });
  await strict.round(account([gp2(1)]));
  assert.deepEqual(strict.ran, []);
});

// Gate 4: rounds in a row

test("a finding has to be in the number of rounds in a row asked for: a blip never runs, a failed check starts the count again, and it runs on the round it has been there long enough", async () => {
  const there = account([gp2(1)]);
  const gone = account([]);
  const p = pilot({ after: 3 });
  await p.round(there);
  assert.equal(p.ran.length, 0);
  assert.match(p.said.at(-1)!, /waiting on vol-\S+ \(in 1 round of the 3 it needs\)/);
  await p.round(there);
  assert.match(p.said.at(-1)!, /in 2 rounds of the 3 it needs/);
  await p.round(gone);
  assert.match(p.said.at(-1)!, /nothing to do/);
  await p.round(there);
  assert.match(p.said.at(-1)!, /in 1 round of the 3 it needs/, "it went away for a round: that was a blip, and the count starts again");
  await p.round(there);
  p.engine.forget();
  await p.round(there);
  assert.match(p.said.at(-1)!, /in 1 round of the 3/, "a round whose check failed saw nothing, so it breaks a run of rounds");
  assert.deepEqual(p.ran, []);
  await p.round(there);
  assert.equal(p.ran.length, 0, "two rounds in a row of the three is not three");
  await p.round(there);
  assert.deepEqual(ids(p.ran), [gp2(1).id]);
  assert.match(p.log[0]!.autopilot!.gates.join(";"), /in 3 rounds of this watch in a row \(at least 3\)/);

  // The default is two, and one round is enough only when asked for.
  const first = pilot({ after: AUTOPILOT_DEFAULTS.after });
  await first.round(there);
  assert.equal(first.ran.length, 0);
  await first.round(there);
  assert.equal(first.ran.length, 1);
});

// Gate 5: this round's scan, read in full

test("a scan older than the round, from the future or with no readable time is refused, and the refusal is recorded once", async () => {
  for (const [scannedAt, reason] of [
    [new Date(ROUND.getTime() - 1).toISOString(), /is from \S+, before this round began at \S+, so it is not what this round saw/],
    ["2026-01-01T00:00:00Z", /before this round began/],
    [new Date(NOW + 3_600_000).toISOString(), /in the future, so a clock is wrong/],
    ["not a date", /cannot be read as a time, so it cannot be shown to be from this round/],
    ["", /cannot be read as a time/],
  ] as const) {
    const p = pilot();
    const old = account([gp2(1)], [], { scannedAt });
    await p.round(old);
    assert.deepEqual(p.ran, [], scannedAt);
    assert.match(p.log[0]!.reason!, reason, scannedAt);
    assert.equal(p.log[0]!.outcome, "refused");
    await p.round(old);
    assert.equal(p.log.length, 1, "the same refusal is not written every round");
  }
  // At the round's own start it is this round's.
  const exact = pilot();
  await exact.round(account([gp2(1)], [], { scannedAt: ROUND.toISOString() }));
  assert.equal(exact.ran.length, 1);
});

test("a finding in a region where a check could not run is refused, and so is any finding when a warning does not say where it is from", async () => {
  const blind = pilot();
  await blind.round(account([gp2(1)], [], { warnings: ["[ap-south-1] ec2:DescribeInstances: UnauthorizedOperation - not authorized"] }));
  assert.deepEqual(blind.ran, []);
  assert.match(blind.log[0]!.reason!, /could not run every check in ap-south-1 \(\[ap-south-1\] ec2:DescribeInstances: UnauthorizedOperation - not authorized\), so the finding may rest on a gap/);

  // A warning about another region leaves this one alone.
  const other = pilot();
  await other.round(account([gp2(1)], [], { regions: ["ap-south-1", "us-east-1"], warnings: ["[us-east-1] ec2:DescribeSnapshots: denied"] }));
  assert.equal(other.ran.length, 1);

  const unplaced = pilot();
  await unplaced.round(account([gp2(1)], [], { warnings: ["prices: the price list did not answer"] }));
  assert.deepEqual(unplaced.ran, []);
  assert.match(unplaced.log[0]!.reason!, /has a warning that does not say which region it is about/);

  const unread = pilot();
  await unread.round(account([gp2(1)], [], { regions: ["us-east-1"] }));
  assert.deepEqual(unread.ran, []);
  assert.match(unread.log[0]!.reason!, /did not read ap-south-1/);
});

// Gate 6: never twice

test("a resource is never tried twice: not in the next round, not after a restart from the same directory, not after a failure, and a person's apply counts too", async () => {
  const there = account([gp2(1)]);
  const first = pilot();
  await first.round(there);
  assert.equal(first.ran.length, 1);
  await first.round(there);
  await first.round(there);
  assert.equal(first.ran.length, 1, "the finding is still there next round, and is not tried again");
  assert.equal(first.log.filter((e) => e.outcome === "refused").length, 1, "and the refusal is recorded once");
  assert.match(first.log.at(-1)!.reason!, /A fix was already tried on this resource \(applied at \S+, by autopilot\)\. Autopilot never tries a resource twice: run cloudpilot apply vol-\S+ to do it yourself\./);

  // A restart: a new process with the same directory, so the same audit log.
  const restarted = pilot({}, { log: first.log });
  await restarted.round(there);
  assert.deepEqual(restarted.ran, []);
  assert.equal(first.log.filter((e) => e.outcome === "applied").length, 1);

  // A fix that failed is not tried again either.
  const failing = pilot({}, { failOn: gp2(1).id });
  const failed = await failing.round(there);
  assert.equal(failed.failed, true);
  const again = pilot({}, { log: failing.log });
  await again.round(there);
  assert.deepEqual(again.ran, []);
  assert.match(again.log.at(-1)!.reason!, /already tried on this resource \(failed at/);

  // So does one a person ran with apply, and one that was only declined or refused does not.
  const [chosen] = plan([there], [gp2(1).id], { maxAgeHours: 24, now: new Date(NOW) });
  const byHand: AuditEntry[] = [];
  await apply([chosen!], { runner: { run: async () => ({ exitCode: 0, output: "" }) }, yes: true, say: () => {}, record: async (e) => void byHand.push(e), user: "ana", now: () => new Date(NOW) });
  const afterHand = pilot({}, { log: byHand });
  await afterHand.round(there);
  assert.deepEqual(afterHand.ran, []);
  assert.match(afterHand.log.at(-1)!.reason!, /already tried on this resource \(applied at \S+\)\./);
  const declined = pilot({}, { log: byHand.map((e) => ({ ...e, outcome: "declined" as const })) });
  await declined.round(there);
  assert.equal(declined.ran.length, 1, "a fix that was only declined was never tried");

  // The same ID in another account, another region or another resource is another resource.
  const elsewhere = pilot({}, { log: byHand.map((e) => ({ ...e, target: "999999999999" })) });
  await elsewhere.round(there);
  assert.equal(elsewhere.ran.length, 1);
  const otherRegion = pilot({}, { log: byHand.map((e) => ({ ...e, finding: { ...e.finding, region: "us-east-1" } })) });
  await otherRegion.round(there);
  assert.equal(otherRegion.ran.length, 1);
});

test("a fix whose record could not be written is still never tried again in this process, and nothing more runs after it", async () => {
  const p = pilot({}, { failRecord: true });
  const there = account([gp2(1), gp2(2)]);
  const first = await p.round(there);
  assert.equal(p.ran.length, 1, "the first fix ran, and then the log could not take it: the rest is not started");
  assert.equal(first.failed, true);
  assert.match(p.said.join("\n"), /Could not write the audit log \(ENOSPC: no space left on device\)\. This entry was NOT recorded: \{.*"outcome":"applied"/);
  assert.match(JSON.stringify(first.notice), /the audit log could not take a record \(ENOSPC/);
  await p.round(there);
  assert.deepEqual(ids(p.ran), [gp2(2).id], "the volume that was done is not touched again; the other waited its turn");
});

// Gate 7: the caps

test("at most the cap a round, biggest saving first, and what is left is held back, recorded and not run", async () => {
  const p = pilot({ maxPerRound: 2 });
  const result = await p.round(account([gp2(1), gp2(2), gp2(3), gp2(4)]));
  assert.deepEqual(ids(p.ran), [gp2(4).id, gp2(3).id]);
  const held = p.log.filter((e) => e.outcome === "held-back");
  assert.deepEqual(held.map((e) => e.finding.resourceIds[0]), [gp2(2).id, gp2(1).id]);
  assert.match(held[0]!.reason!, /The cap of 2 fixes a round was reached\./);
  assert.ok(held.every((e) => e.commands.every((c) => c.exitCode === undefined)), "none of their commands ran");
  assert.deepEqual(held[0]!.autopilot!.gates.slice(-1), ["no earlier fix on this resource"], "the gates it did pass, and not the cap");
  assert.match(p.log[0]!.autopilot!.gates.at(-1)!, /within the caps \(1 of 2 this round, 1 of 10 in all\)/);
  assert.equal(result.notice?.kind === "autopilot" && result.notice.lines.map((l) => l.outcome).join(), "applied,applied,held-back,held-back");

  // The next round takes up what was left: it was only held back for the cap.
  await p.round(account([gp2(1), gp2(2), gp2(3), gp2(4)]));
  assert.deepEqual(ids(p.ran), [gp2(4).id, gp2(3).id, gp2(2).id, gp2(1).id]);
  assert.equal(p.log.filter((e) => e.outcome === "held-back").length, 2, "and the hold-back is not written again");
});

test("the total for the whole watch holds across rounds, and everything past it is held back", async () => {
  const p = pilot({ maxPerRound: 3, maxTotal: 4 });
  const there = account([gp2(1), gp2(2), gp2(3), gp2(4), gp2(5), gp2(6)]);
  await p.round(there);
  assert.equal(p.ran.length, 3);
  await p.round(there);
  assert.equal(p.ran.length, 4, "one more is all the total allows");
  assert.match(p.log.filter((e) => e.outcome === "held-back").at(-1)!.reason!, /The cap of 4 fixes for this watch was reached\./);
  await p.round(there);
  await p.round(there);
  assert.equal(p.ran.length, 4, "no round after that runs anything");
  const none = pilot({ maxTotal: 1, maxPerRound: 5 });
  await none.round(account([gp2(1), gp2(2)]));
  assert.equal(none.ran.length, 1);
});

// The first failure

test("the first failure stops the round: the rest are held back and recorded, the failure is recorded with its output, and the round is reported failed", async () => {
  const p = pilot({}, { failOn: gp2(3).id });
  const result = await p.round(account([gp2(1), gp2(2), gp2(3)]));
  assert.deepEqual(ids(p.ran), [gp2(3).id], "the biggest saving went first, failed, and nothing after it was started");
  assert.deepEqual(p.log.map((e) => [e.finding.resourceIds[0], e.outcome]), [[gp2(3).id, "failed"], [gp2(2).id, "held-back"], [gp2(1).id, "held-back"]]);
  assert.equal(p.log[0]!.commands[0]!.exitCode, 254);
  assert.match(p.log[0]!.commands[0]!.output!, /UnauthorizedOperation/);
  assert.match(p.log[1]!.reason!, /Autopilot stopped for this round, because an earlier fix failed in this round\./);
  assert.equal(result.failed, true);
  const notice = result.notice as Extract<Notice, { kind: "autopilot" }>;
  assert.deepEqual(notice.lines.map((l) => l.outcome), ["failed", "held-back", "held-back"]);
  assert.match(plainText(notice), /FAILED/);

  // A restart picks up where it left off: the failed one is not retried, the held ones are fixed.
  const next = pilot({}, { log: p.log });
  await next.round(account([gp2(1), gp2(2), gp2(3)]));
  assert.deepEqual(ids(next.ran), [gp2(2).id, gp2(1).id]);
});

test("a fix of several commands that failed after the first says it may be half done, in the line and in the message", () => {
  const entry: AuditEntry = {
    at: "2026-10-03T12:00:00.000Z",
    user: "sai",
    scope: "account",
    target: "123456789012",
    scannedAt: "2026-10-03T12:00:00.000Z",
    finding: { pattern: "gp2-volume", region: "ap-south-1", resourceIds: ["vol-0a1b2c3d4e5f60001"], title: "Two commands", monthlyCostUsd: 1 },
    which: "fix",
    risk: "caution",
    outcome: "failed",
    commands: [{ command: "aws ec2 stop-instances", exitCode: 0 }, { command: "aws ec2 modify-instance-attribute", exitCode: 254 }, { command: "aws ec2 start-instances" }],
    wayBack: "run them again with the old size",
    autopilot: { gates: [] },
  };
  assert.equal(lineOf(entry).halfDone, true);
  assert.equal(lineOf({ ...entry, commands: [{ command: "x", exitCode: 254 }] }).halfDone, undefined, "a failure of the first command has nothing before it");
  const text = plainText({ kind: "autopilot", subject: "AWS account 1", at: entry.at, dryRun: false, rules: ["gp2-volume"], lines: [lineOf(entry)] });
  assert.match(text, /1\. FAILED {2}\$1\.00\/mo {2}Two commands \(.*\), region ap-south-1\. It may be half done: check the resource\. Way back: run them again with the old size/);
});

test("a fix whose program is not on the PATH is recorded as failed, not run, and stops the round", async () => {
  const p = pilot({}, { missingProgram: true });
  const result = await p.round(account([gp2(1), gp2(2)]));
  assert.deepEqual(p.log.map((e) => e.outcome), ["failed", "held-back"]);
  assert.match(p.log[0]!.reason!, /Not run: aws was not found on your PATH/);
  assert.equal(result.failed, true);
});

// The audit log

test("with an audit log that cannot be read, or cannot take a line, nothing runs, and it is said once", async () => {
  for (const [opts, reason] of [[{ unreadable: true }, /could not be read \(EISDIR\)/], [{ unwritable: true }, /EROFS/]] as const) {
    const p = pilot({}, opts);
    const first = await p.round(account([gp2(1)]));
    assert.deepEqual(p.ran, []);
    assert.equal(first.failed, true);
    const notice = first.notice as Extract<Notice, { kind: "autopilot" }>;
    assert.match(notice.problem!, reason);
    assert.match(plainText(notice), /could not run anything/);
    assert.match(plainText(notice), /Nothing was run: the audit log cannot be used/);
    const second = await p.round(account([gp2(1)]));
    assert.equal(second.notice, undefined, "the same problem is not sent every round");
    assert.equal(second.failed, true);
  }
  // A dry run records nothing, so it does not need a log it can write to.
  const dry = pilot({ dryRun: true }, { unwritable: true });
  await dry.round(account([gp2(1)]));
  assert.equal(dry.said.some((l) => /Dry run: nothing was run/.test(l)), true);
});

test("an audit log with a line that cannot be read stops autopilot, through the real reader, so a damaged record never lets a resource be fixed again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-audit-"));
  const file = join(dir, "audit.jsonl");
  // The record of a fix on vol 1, with its line cut short as if the process was killed while writing it.
  const seed = pilot();
  await seed.round(account([gp2(1)]));
  const done = seed.log[0]!;
  const line = JSON.stringify(done);
  writeFileSync(file, `${line.slice(0, line.length - 20)}\n`);

  const p = pilot({}, { auditFile: file });
  const round = await p.round(account([gp2(1)]));
  assert.deepEqual(p.ran, [], "nothing is run on a resource whose record may be the damaged line");
  assert.equal(round.failed, true);
  const notice = round.notice as Extract<Notice, { kind: "autopilot" }>;
  assert.ok(notice.problem!.includes(file), notice.problem);
  assert.match(notice.problem!, /1 line that cannot be read/);
  assert.match(notice.problem!, /Repair or remove it\. Apply by hand is not affected\./);
  assert.deepEqual(p.log, [], "and nothing is written");

  // Mended, the same file is read and the resource is seen as tried: this is the gate working, not the stop.
  writeFileSync(file, `${line}\n`);
  const mended = pilot({}, { auditFile: file });
  await mended.round(account([gp2(1)]));
  assert.deepEqual(mended.ran, []);
  assert.match(mended.log[0]!.reason!, /already tried/);
});

test("an entry autopilot writes is an entry the audit log reads back, and the audit shows that it was autopilot's and which gates it passed", async () => {
  const p = pilot({ maxPerRound: 1 });
  await p.round(account([gp2(1), gp2(2)]));
  assert.equal(p.log.length, 2);
  for (const e of p.log) {
    assert.ok(isAuditEntry(JSON.parse(JSON.stringify(e))));
    assert.equal(e.autopilot!.gates[0], "rule named");
    assert.equal(e.user, "sai");
  }
  assert.deepEqual(p.log.map((e) => e.outcome), ["applied", "held-back"]);
  const text = renderAudit(p.log);
  assert.match(text, /APPLIED {3}vol-\S+ {2}\(account 123456789012, ap-south-1\) {2}by sai \[autopilot\]/);
  assert.match(text, /Autopilot gates passed: rule named; fix can be undone; confidence 0\.9 \(at least 0\.9\); in 1 round of this watch in a row \(at least 1\); scan taken in this round, region read in full; no earlier fix on this resource; within the caps \(1 of 1 this round, 1 of 10 in all\)/);
  assert.match(text, /HELD-BACK {2}vol-\S+/);
  assert.match(text, /The cap of 1 fixes a round was reached\./);
  assert.match(text, /Way back: Online and reversible/);
  // An entry whose autopilot field is not a list of gates is not an entry.
  assert.equal(isAuditEntry({ ...p.log[0]!, autopilot: { gates: "all" } }), false);
  assert.equal(isAuditEntry({ ...p.log[0]!, autopilot: null }), false);
});

// A dry run

test("a dry run runs nothing and records nothing, says what would run, counts against the caps, and does not say the same again next round", async () => {
  const p = pilot({ dryRun: true, maxPerRound: 2, maxTotal: 3 });
  const there = account([gp2(1), gp2(2), gp2(3), gp2(4)]);
  const first = await p.round(there);
  assert.deepEqual(p.ran, []);
  assert.deepEqual(p.log, [], "a dry run writes nothing to the audit log, as apply --dry-run does not");
  const notice = first.notice as Extract<Notice, { kind: "autopilot" }>;
  assert.equal(notice.dryRun, true);
  assert.deepEqual(notice.lines.map((l) => l.outcome), ["would-run", "would-run", "held-back", "held-back"]);
  assert.match(p.said.join("\n"), /\$ aws ec2 modify-volume --volume-id vol-0a1b2c3d4e5f60004 .*\n {2}Dry run: nothing was run\./);
  assert.match(p.said.at(-1)!, /Autopilot \(dry run\): 2 fixes would run, 2 held back\./);
  const second = await p.round(there);
  // The two said already are not said again. One more would run, and the last is now held by the total, a new reason.
  assert.deepEqual(second.notice && (second.notice as Extract<Notice, { kind: "autopilot" }>).lines.map((l) => l.outcome), ["would-run", "held-back"]);
  assert.match((second.notice as Extract<Notice, { kind: "autopilot" }>).lines[1]!.reason!, /The cap of 3 fixes for this watch was reached/);
  assert.deepEqual(p.ran, []);
  assert.match(plainText(notice), /^CloudPilot autopilot \(dry run\): 2 fixes would run, 2 held back, AWS account 123456789012\n/);
  assert.match(plainText(notice), /This is a dry run: nothing was run, and the lines below are what a real run would have run\./);
});

test("a dry run's message does not send the reader to an audit log it never wrote, whole or cut off", async () => {
  const p = pilot({ dryRun: true, maxPerRound: 99 });
  const many = account(Array.from({ length: 40 }, (_, n) => gp2(n + 1)));
  const round = await p.round(many);
  const notice = round.notice as Extract<Notice, { kind: "autopilot" }>;
  assert.equal(notice.lines.length, 40);
  assert.deepEqual(p.log, []);

  const whole = plainText(notice);
  assert.match(whole, /A dry run writes nothing to the audit log\. What it would have run is in this message and in the watch's own output, on the machine that runs the watch\./);
  assert.doesNotMatch(whole, /cloudpilot audit|audit\.jsonl/);

  // Cut to fit a Slack message: the line that says how many were left out is true of a dry run too.
  const slack = JSON.parse(compose(notice, { kind: "slack" })).text as string;
  assert.match(slack, /\.\.\. and \d+ more not listed here\. A dry run writes nothing to the audit log: they are in the watch's own output/);
  assert.doesNotMatch(slack, /cloudpilot audit|audit\.jsonl/);

  // A real run still points at the log it wrote.
  const real = pilot({ maxPerRound: 99, maxTotal: 99 });
  const ran = (await real.round(many)).notice as Extract<Notice, { kind: "autopilot" }>;
  assert.match(plainText(ran), /Every command and its result is in \.cloudpilot\/audit\.jsonl/);
  assert.match(JSON.parse(compose(ran, { kind: "slack" })).text, /not listed here: they are in the audit log\. Run cloudpilot audit\./);
});

test("when a dry-run round stops, the watch does not point at an audit log that a dry run never wrote", async () => {
  for (const dryRun of [true, false]) {
    const err: string[] = [];
    const engine = { settings: settings({ dryRun }), round: async () => { throw new Error("the audit log went away"); }, forget: () => {} };
    const deps: WatchDeps = {
      scan: async () => ({ result: account([gp2(1)]) }),
      baseline: { load: async () => undefined, save: async () => {} },
      send: async () => {},
      clock: () => new Date(NOW),
      sleep: async () => {},
      out: () => {},
      err: (line) => err.push(line),
      autopilot: engine,
    };
    await watch({ everyMs: 6 * 3_600_000, maxRuns: 1, targets: [], subject: "the AWS account" }, deps, new AbortController().signal);
    const line = err.find((l) => l.includes("Autopilot stopped this round"))!;
    assert.match(line, /the audit log went away/);
    if (dryRun) {
      assert.match(line, /A dry run records nothing/);
      assert.doesNotMatch(line, /audit\.jsonl/);
    } else {
      assert.match(line, /What it did before that is in \.cloudpilot\/audit\.jsonl\./);
    }
  }
});

// Stopping

test("a watch that is stopped lets no further fix start, and says so", async () => {
  const p = pilot();
  const stop = new AbortController();
  stop.abort();
  const result = await p.round(account([gp2(1)]), stop.signal);
  assert.deepEqual(p.ran, []);
  assert.match(p.log[0]!.reason!, /Autopilot stopped for this round, because the watch was stopped/);
  assert.equal(p.log[0]!.outcome, "held-back");
  assert.equal(result.failed, false);
});

// Inside the watch loop

/** The loop with the real autopilot, a webhook that can be down, and a clock that moves six hours a round. */
function loop(rounds: Array<ScanResult | Error>, opts: Parameters<typeof pilot>[1] & { over?: Partial<AutopilotSettings>; noPilot?: boolean; afterRound?: (n: number) => void } = {}) {
  let clock = NOW - 6 * 3_600_000;
  const p = pilot(opts.over ?? {}, { ...opts, now: () => new Date(clock + 2000) });
  let round = 0;
  let slept = 0;
  const out: string[] = [];
  const err: string[] = [];
  const sent: any[] = [];
  const down = new Set<string>();
  const deps: WatchDeps = {
    scan: async () => {
      const step = rounds[Math.min(round++, rounds.length - 1)]!;
      if (step instanceof Error) throw step;
      // The scan is of this round: taken just after the round began.
      return { result: { ...step, scannedAt: new Date(clock + 1000).toISOString() } };
    },
    baseline: { load: async () => undefined, save: async () => {} },
    send: async (target, body) => {
      if (down.has(target.host)) throw new Error(`${target.host} answered 500`);
      sent.push(JSON.parse(body));
    },
    clock: () => new Date((clock += 6 * 3_600_000)),
    sleep: async () => void opts.afterRound?.(++slept),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(opts.noPilot ? {} : { autopilot: p.engine }),
  };
  return { p, out, err, sent, down, run: (maxRuns = rounds.length) => watch({ everyMs: 6 * 3_600_000, maxRuns, targets: parseTargets(["http://127.0.0.1:9/hook"]), subject: "the AWS account" }, deps, new AbortController().signal) };
}

test("in a watch, a finding that stays is fixed on the round it has been there long enough, and one message tells it, with the way back", async () => {
  const there = account([gp2(1)]);
  const l = loop([there, there, there], { over: { after: 2 } });
  // The loop's clock is its own; the engine's entries are stamped by the engine's, which is fixed. The round start is what the gates use.
  const end = await l.run();
  assert.equal(l.p.ran.length, 1, "run once, on the second round, and never again");
  const autopilot = l.sent.filter((m) => m.event === "autopilot");
  assert.equal(autopilot.length, 2, "one message for the round that ran it, one for the refusal when the third round saw it again: none for the round it waited");
  assert.deepEqual(autopilot.map((m) => m.lines.map((x: { outcome: string }) => x.outcome)), [["applied"], ["refused"]]);
  assert.match(autopilot[0].text, /^CloudPilot autopilot: 1 fix run, AWS account 123456789012\n/);
  assert.match(autopilot[0].text, /Autopilot is on for gp2-volume, bucket-without-lifecycle\. It runs only fixes that can be undone, and never a permanent one\./);
  assert.match(autopilot[0].text, /1\. RAN {2}\$2\.28\/mo {2}100 GB gp2 volume can move to gp3 \(vol-0a1b2c3d4e5f60001\), region ap-south-1\. Way back: Online and reversible: the volume can be changed back to gp2 after AWS's 6-hour modification cooldown\./);
  assert.match(autopilot[0].text, /Every command and its result is in \.cloudpilot\/audit\.jsonl/);
  assert.equal(end.exitCode, 0);
});

test("the message the findings get stays true: without autopilot it says nothing has been changed, with it, that autopilot's changes are in a message of their own", async () => {
  const there = account([gp2(1)]);
  const without = loop([there], { noPilot: true });
  await without.run();
  assert.match(without.sent[0].text, /Nothing has been changed: every fix is a proposal for a person to review and run\./);
  assert.deepEqual(without.p.ran, []);
  assert.deepEqual(without.p.log, []);

  const withPilot = loop([there], { over: { after: 2 } });
  await withPilot.run();
  assert.match(withPilot.sent[0].text, /Nothing has been changed by this message: every fix listed is a proposal\. Autopilot is on for gp2-volume, bucket-without-lifecycle: whatever it changed is in its own message, with the way back for each\./);
  assert.doesNotMatch(withPilot.sent[0].text, /Nothing has been changed: every fix/);
});

test("a round whose check failed starts the count again, and says, with autopilot on, that it changed nothing", async () => {
  const there = account([gp2(1)]);
  const l = loop([there, new Error("The security token included in the request is expired"), there, there], { over: { after: 2 } });
  await l.run();
  const kinds = l.sent.map((m) => m.event);
  assert.deepEqual(kinds.filter((k) => k === "autopilot").length, 1, "only the last round, the second of two in a row after the failure, ran it");
  assert.equal(l.p.ran.length, 1);
  const failed = l.sent.find((m) => m.event === "check-failed");
  assert.match(failed.text, /Nothing was changed in this round: autopilot runs only after a check that finished\. Autopilot is on for gp2-volume/);
});

test("the message of a round is retried when the webhook is down, then sent in order, and the audit log has the record either way", async () => {
  const there = account([gp2(1), gp2(2)]);
  const down = loop([there], { over: { after: 1, maxPerRound: 1 } });
  down.down.add("127.0.0.1:9");
  const failed = await down.run();
  assert.equal(down.sent.length, 0);
  assert.match(down.err.join("\n"), /Could not send the autopilot message: 127\.0\.0\.1:9 answered 500\. It will be sent again next round\./);
  assert.equal(failed.exitCode, 1, "a message nobody got is a failed run");
  assert.equal(down.p.log.length, 2, "the record does not wait for the message");

  // The webhook is back for the second round: the first round's message goes first, then the second's.
  const back = loop([there, there], { over: { after: 1, maxPerRound: 1 }, afterRound: () => void back.down.delete("127.0.0.1:9") });
  back.down.add("127.0.0.1:9");
  const delivered = await back.run();
  const messages = back.sent.filter((m) => m.event === "autopilot");
  assert.deepEqual(messages.map((m) => m.lines.map((x: { outcome: string }) => x.outcome)), [["applied", "held-back"], ["refused", "applied"]]);
  assert.equal(delivered.exitCode, 0);
});

test("a fix that failed makes the watch end non-zero even when everything else was delivered, and its message says FAILED", async () => {
  const l = loop([account([gp2(1)])], { over: { after: 1 }, failOn: gp2(1).id });
  const end = await l.run();
  assert.equal(end.exitCode, 1);
  const message = l.sent.find((m) => m.event === "autopilot");
  assert.match(message.text, /^CloudPilot autopilot: 0 fixes run, 1 failed, AWS account/);
  assert.match(message.text, /1\. FAILED/);
});

test("rounds with nothing for autopilot to do send it no message", async () => {
  const l = loop([account([]), account([]), account([gp2(1)])], { over: { after: 3 } });
  await l.run();
  assert.equal(l.sent.filter((m) => m.event === "autopilot").length, 0);
  assert.match(l.out.join("\n"), /Autopilot: nothing to do: no finding of gp2-volume or bucket-without-lifecycle\./);
  assert.match(l.out.join("\n"), /Autopilot: 0 fixes run, waiting on vol-\S+ \(in 1 round of the 3 it needs\)\./);
});

test("the total cap holds across the rounds of a watch, and a restart of the watch gets a new total but never the same resource", async () => {
  const there = account([gp2(1), gp2(2), gp2(3)]);
  const l = loop([there, there, there, there], { over: { after: 1, maxPerRound: 1, maxTotal: 2 } });
  await l.run();
  assert.equal(l.p.ran.length, 2);
  const restarted = loop([there, there], { over: { after: 1, maxPerRound: 5, maxTotal: 5 }, log: l.p.log });
  await restarted.run();
  assert.deepEqual(ids(restarted.p.ran), [gp2(1).id], "the one left; the two already done are not touched again");
});

test("a run with a scan that has findings of other rules runs only what was named, and reports the rest as it always did", async () => {
  const l = loop([everyScan], { over: { rules: ["gp2-volume"], after: 1 } });
  await l.run();
  assert.deepEqual(ids(l.p.ran), ["vol-0a1b2c3d4e5f60003"]);
  assert.equal(l.sent.find((m) => m.event === "first-report").findings.length, everyScan.findings.length);
});


// The documents say what the code does

test("the README and the landing page name exactly the rules that can qualify, the defaults, and that a permanent fix is never run", () => {
  const readme = readFileSync(resolve(here, "../README.md"), "utf8");
  const section = readme.slice(readme.indexOf("### Let watch run the fixes that can be undone (autopilot)"), readme.indexOf("### Score it against the waste lab"));
  assert.ok(section.length > 3000);
  const rows = [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows, [...AUTOPILOT_QUALIFYING], "the table lists the rules that can qualify, and no other");
  // The way back it repeats is the finding's own.
  const found = account([gp2(1)], [bucket("neglected")]);
  assert.ok(section.includes(found.findings.find((f) => f.pattern === "gp2-volume")!.fix.rollback.replace("the volume can be changed back to gp2 after AWS's 6-hour modification cooldown.", "the volume can be changed back to gp2 after AWS's 6-hour modification cooldown.")));
  assert.ok(section.includes("Remove the rule again with: `aws s3api delete-bucket-lifecycle --bucket <name>`. Objects already moved to Standard-IA stay there."));
  assert.match(section, /A fix that cannot be undone is\s+never run by it, under any option\./);
  assert.match(section, /Start with a dry run\./);
  for (const [flag, value] of [["--autopilot-min-confidence", AUTOPILOT_DEFAULTS.minConfidence], ["--autopilot-after", AUTOPILOT_DEFAULTS.after], ["--autopilot-max", AUTOPILOT_DEFAULTS.maxPerRound], ["--autopilot-max-total", AUTOPILOT_DEFAULTS.maxTotal]] as const) {
    assert.match(section.replace(/\s+/g, " "), new RegExp(`\`${flag}\`[^.]*\\(default \`${String(value).replace(".", "\\.")}\`[,)]`), flag);
  }
  for (const rule of Object.keys(AUTOPILOT_RULES).filter((r) => !AUTOPILOT_RULES[r as keyof typeof AUTOPILOT_RULES].ok)) {
    assert.ok(!rows.includes(rule), rule);
  }

  const top = readFileSync(resolve(here, "../../../README.md"), "utf8");
  assert.match(top, /`watch --autopilot` is the one other thing that can change anything|`watch --autopilot` is the one other thing that can, off unless/);
  const page = readFileSync(resolve(here, "../../../site/index.html"), "utf8");
  assert.match(page, /The one other thing that can change anything is <code>watch --autopilot<\/code>\. It is off unless you turn it on, it acts only for the rules you name, and only for fixes that can be undone/);
  assert.match(page, /A fix that cannot be undone is never run by it, under any option\./);
  assert.match(readme.slice(0, 900), /`watch --autopilot` is the one other thing that can: it is off\s+unless you turn it on, it acts only for the rules you name, and only for fixes\s+that can be undone\./);
});
