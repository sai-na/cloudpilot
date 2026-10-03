/**
 * The watch loop, offline and instant: the scan, the clock, the sleep and the
 * sending are all stand-ins, so every branch runs without waiting or a network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { carryForward, compareScans } from "../src/compare.js";
import { parseTargets, type Sender } from "../src/notify.js";
import type { ScanResult } from "../src/types.js";
import { MAX_EVERY_MS, MIN_EVERY_MS, parseEvery, parseMaxRuns, watch, type WatchDeps, type WatchOptions } from "../src/watch.js";
import { finding, scan } from "./scans.js";

import { SECRET } from "./webhook.js";
const SLACK = `https://hooks.slack.com/services/${SECRET}`;
const DISCORD = `https://discord.com/api/webhooks/1234567890/${SECRET}`;

const a = finding("vol-0aaaaaaaaaaaaaaaa", 57);
const b = finding("vol-0bbbbbbbbbbbbbbbb", 18.24, { title: "Unattached 200 GB gp3 volume" });
const c = finding("vol-0cccccccccccccccc", 9.12);

/** One scan per round, `scannedAt` counting up so each is told apart. */
let tick = 0;
const at = (findings: ReturnType<typeof finding>[], extra: Partial<ScanResult> = {}) =>
  scan(findings, { scannedAt: `2026-10-03T0${++tick}:00:00Z`, ...extra });

type Step = ScanResult | Error | ((signal: AbortSignal) => Promise<ScanResult>);

interface Rig {
  options: WatchOptions;
  deps: WatchDeps;
  out: string[];
  err: string[];
  /** Each message sent: the target's host and what the body said. */
  sent: Array<{ host: string; body: any }>;
  saved: ScanResult[];
  sleeps: number[];
  /** Hosts that refuse messages for now. */
  down: Set<string>;
  /** The most rounds that were ever running at once. */
  overlap: { now: number; max: number };
  run(signal?: AbortSignal): ReturnType<typeof watch>;
}

/** A watch whose rounds are `steps` in order; the last one repeats. */
function rig(steps: Step[], opts: { baseline?: ScanResult; urls?: string[]; maxRuns?: number; saveFails?: boolean } = {}): Rig {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Rig["sent"] = [];
  const saved: ScanResult[] = [];
  const sleeps: number[] = [];
  const down = new Set<string>();
  const overlap = { now: 0, max: 0 };
  let round = 0;
  let clock = Date.parse("2026-10-03T00:00:00Z");
  const send: Sender = async (target, body) => {
    if (down.has(target.host)) throw new Error(`${target.host} answered 500`);
    sent.push({ host: target.host, body: JSON.parse(body) });
  };
  const deps: WatchDeps = {
    scan: async () => {
      const step = steps[Math.min(round++, steps.length - 1)]!;
      overlap.now++;
      overlap.max = Math.max(overlap.max, overlap.now);
      try {
        await Promise.resolve();
        if (step instanceof Error) throw step;
        return { result: typeof step === "function" ? await step(new AbortController().signal) : step };
      } finally {
        overlap.now--;
      }
    },
    baseline: {
      load: async () => opts.baseline,
      save: async (result) => {
        if (opts.saveFails) throw new Error("read-only file system");
        saved.push(result);
      },
    },
    send,
    clock: () => new Date((clock += 6 * 3600_000)),
    sleep: async (ms) => void sleeps.push(ms),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  // A slack target is the one whose body is {text}; a generic one has an event, which is what most tests read.
  const options: WatchOptions = { everyMs: 6 * 3600_000, maxRuns: opts.maxRuns ?? steps.length, targets: parseTargets(opts.urls ?? ["https://example.com/hook/" + SECRET]), subject: "the AWS account" };
  return { options, deps, out, err, sent, saved, sleeps, down, overlap, run: (signal = new AbortController().signal) => watch(options, deps, signal) };
}

const never = (_: AbortSignal) => new Promise<ScanResult>(() => {});

test("a round with nothing new sends nothing and prints one line", async () => {
  const baseline = at([a, b]);
  const r = rig([at([a, b])], { baseline });
  const end = await r.run();
  assert.deepEqual(r.sent, []);
  assert.equal(r.out.length, 1);
  assert.match(r.out[0]!, /^2026-10-03T06:00:00\.000Z {2}Nothing new since 2026-10-03T01:00:00Z: 2 findings, \$75\.24 a month\.$/);
  assert.deepEqual(r.err, []);
  assert.equal(end.exitCode, 0);
});

test("the first scan sends the whole report once, and later rounds with nothing new send nothing", async () => {
  const same = [a, b];
  const r = rig([at(same), at(same), at(same)]);
  const end = await r.run();
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.body.event, "first-report");
  assert.equal(r.sent[0]!.body.findings.length, 2);
  assert.match(r.out[0]!, /No earlier scan to compare with; showing every finding\./);
  assert.match(r.out.at(-1)!, /Nothing new since/);
  assert.equal(r.saved.length, 3, "every round that owed nothing more keeps its scan as what was reported");
  assert.equal(end.rounds, 3);
  assert.equal(end.exitCode, 0);
});

test("a first scan that finds nothing sends nothing, and still becomes the baseline", async () => {
  const r = rig([at([]), at([a])]);
  await r.run();
  assert.equal(r.sent.length, 1, "only the second round, when something appeared");
  assert.equal(r.sent[0]!.body.event, "new-findings");
  assert.equal(r.sent[0]!.body.findings.length, 1);
});

test("a new finding sends a message about that finding alone, and becomes part of the baseline", async () => {
  const baseline = at([a, b]);
  const r = rig([at([a, b, c])], { baseline });
  await r.run();
  assert.equal(r.sent.length, 1);
  const [message] = r.sent;
  assert.equal(message!.body.event, "new-findings");
  assert.deepEqual(message!.body.findings.map((f: any) => f.resourceIds[0]), ["vol-0cccccccccccccccc"]);
  assert.match(message!.body.text, /^CloudPilot: 1 new finding, \$9\.12 a month, AWS account 123456789012/);
  assert.ok(!message!.body.text.includes("vol-0aaaaaaaaaaaaaaaa"), "what was already reported is not said again");
  assert.deepEqual(r.saved[0]!.findings.map((f) => f.resourceIds[0]), ["vol-0aaaaaaaaaaaaaaaa", "vol-0bbbbbbbbbbbbbbbb", "vol-0cccccccccccccccc"]);
  assert.match(r.out[0]!, /Showing only the 1 new finding\./);
  assert.match(r.out.at(-1)!, /^Sent to example\.com\.$/);
});

test("something resolved is printed but sends nothing, and when it comes back it is new", async () => {
  const baseline = at([a, b]);
  const r = rig([at([a]), at([a, b])], { baseline });
  await r.run();
  assert.match(r.out[0]!, /Resolved since the last scan:\n {2}- Unattached 200 GB gp3 volume \(vol-0bbbbbbbbbbbbbbbb\), \$18\.24 a month/);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0]!.body.findings.map((f: any) => f.resourceIds[0]), ["vol-0bbbbbbbbbbbbbbbb"]);
});

test("a failed send keeps the baseline, and the next round says the same findings again", async () => {
  const baseline = at([a]);
  const r = rig([at([a, b]), at([a, b]), at([a, b])], { baseline });
  r.down.add("example.com");
  // Round 1: the send fails. Bring the webhook back after it.
  const sleep = r.deps.sleep;
  let rounds = 0;
  r.deps.sleep = async (ms, signal) => {
    if (++rounds === 1) r.down.clear();
    await sleep(ms, signal);
  };
  const end = await r.run();
  assert.match(r.err[0]!, /^Could not send the message: example\.com answered 500\. It will be sent again next round\.$/);
  assert.equal(r.sent.length, 1, "round 2 sent it");
  assert.deepEqual(r.sent[0]!.body.findings.map((f: any) => f.resourceIds[0]), ["vol-0bbbbbbbbbbbbbbbb"]);
  assert.equal(r.saved.length, 2, "nothing was kept after the failed round; round 2 and round 3 kept theirs");
  assert.ok(r.saved[0]!.findings.some((f) => f.resourceIds[0] === "vol-0bbbbbbbbbbbbbbbb"));
  assert.equal(end.exitCode, 0, "it was delivered in the end");
});

test("a send that keeps failing is never counted as reported, and the exit code says so", async () => {
  const r = rig([at([a, b]), at([a, b])], { baseline: at([a]) });
  r.down.add("example.com");
  const end = await r.run();
  assert.equal(r.saved.length, 0, "the baseline never moved");
  assert.equal(r.sent.length, 0);
  assert.equal(r.err.filter((l) => l.startsWith("Could not send the message")).length, 2);
  assert.equal(end.exitCode, 1);
});

test("when one of two webhooks is down, the other is not sent the same message every round", async () => {
  const r = rig([at([a, b]), at([a, b]), at([a, b])], { baseline: at([a]), urls: [SLACK, DISCORD] });
  r.down.add("discord.com");
  await r.run();
  assert.deepEqual(r.sent.map((m) => m.host), ["hooks.slack.com"], "Slack has it once; Discord has not taken it");
  assert.equal(r.saved.length, 0);
  assert.match(r.err[0]!, /discord\.com answered 500/);
  // Discord comes back: it alone is sent the message, and then the baseline moves.
  r.down.clear();
  const again = rig([at([a, b])], { baseline: at([a]), urls: [SLACK, DISCORD] });
  await again.run();
  assert.deepEqual(again.sent.map((m) => m.host).sort(), ["discord.com", "hooks.slack.com"]);
});

test("a retry reaches only the targets that missed it", async () => {
  const r = rig([at([a, b]), at([a, b])], { baseline: at([a]), urls: [SLACK, DISCORD], maxRuns: 2 });
  r.down.add("discord.com");
  const sleep = r.deps.sleep;
  r.deps.sleep = async (ms, signal) => {
    r.down.clear();
    await sleep(ms, signal);
  };
  await r.run();
  assert.deepEqual(r.sent.map((m) => m.host), ["hooks.slack.com", "discord.com"]);
  assert.equal(r.saved.length, 1);
});

test("a round that fails is said once on stderr and by message, however long it lasts, and does not move the baseline", async () => {
  const baseline = at([a]);
  const r = rig([new Error("The security token included in the request is expired (request 1001)"), new Error("The security token included in the request is expired (request 1002)"), new Error("The security token included in the request is expired (request 1003)")], { baseline });
  const end = await r.run();
  assert.equal(r.err.length, 1, r.err.join("\n"));
  assert.match(r.err[0]!, /^2026-10-03T06:00:00\.000Z {2}The check failed: The security token included in the request is expired \(request 1001\)$/);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.body.event, "check-failed");
  assert.match(r.sent[0]!.body.text, /^CloudPilot: the check itself failed \(AWS account 123456789012\)/);
  assert.equal(r.sent[0]!.body.error, "The security token included in the request is expired (request 1001)");
  assert.deepEqual(r.saved, []);
  assert.equal(end.rounds, 3, "it did not stop");
  assert.equal(end.exitCode, 1, "the last round failed");
});

test("a different failure is said again", async () => {
  const r = rig([new Error("credentials expired"), new Error("connection refused")], { baseline: at([a]) });
  await r.run();
  assert.equal(r.err.length, 2);
  assert.deepEqual(r.sent.map((m) => m.body.error), ["credentials expired", "connection refused"]);
});

test("when the check works again that is said, and silence means fine again", async () => {
  const baseline = at([a]);
  const r = rig([new Error("credentials expired"), new Error("credentials expired"), at([a])], { baseline });
  const end = await r.run();
  assert.deepEqual(r.sent.map((m) => m.body.event), ["check-failed", "check-recovered"]);
  assert.match(r.sent[1]!.body.text, /^CloudPilot: checking works again \(AWS account 123456789012\)\nThe check had been failing since 2026-10-03T06:00:00\.000Z and completed at /);
  assert.match(r.out.at(-1)!, /Checking works again\.$/);
  assert.equal(end.exitCode, 0);
  // And once recovered, a quiet round is quiet.
  const quiet = rig([new Error("credentials expired"), at([a]), at([a])], { baseline });
  await quiet.run();
  assert.equal(quiet.sent.length, 2);
});

test("recovering with something new is one message, not two", async () => {
  const r = rig([new Error("credentials expired"), at([a, b])], { baseline: at([a]) });
  await r.run();
  assert.deepEqual(r.sent.map((m) => m.body.event), ["check-failed", "new-findings"]);
  assert.match(r.sent[1]!.body.text, /^Checking works again: it had been failing since 2026-10-03T06:00:00\.000Z\.$/m);
});

test("a failure notice that could not be sent is tried again, and recovery is only announced to those who heard of the failure", async () => {
  const r = rig([new Error("credentials expired"), new Error("credentials expired"), at([a])], { baseline: at([a]) });
  r.down.add("example.com");
  let rounds = 0;
  const sleep = r.deps.sleep;
  r.deps.sleep = async (ms, signal) => {
    if (++rounds === 1) r.down.clear();
    await sleep(ms, signal);
  };
  await r.run();
  assert.deepEqual(r.sent.map((m) => m.body.event), ["check-failed", "check-recovered"], "the failure reached them on the second try");

  // Never heard of it: no recovery message out of nowhere.
  const unheard = rig([new Error("credentials expired"), at([a])], { baseline: at([a]) });
  unheard.down.add("example.com");
  const sleep2 = unheard.deps.sleep;
  unheard.deps.sleep = async (ms, signal) => {
    unheard.down.clear();
    await sleep2(ms, signal);
  };
  const end = await unheard.run();
  assert.deepEqual(unheard.sent.map((m) => m.body.event), [], "the failure notice was never delivered, so there is nothing to take back");
  assert.equal(end.exitCode, 0);
});

test("a failed round in between does not make the findings of a failed send reported", async () => {
  const r = rig([at([a, b]), new Error("cluster unreachable"), at([a, b])], { baseline: at([a]) });
  r.down.add("example.com");
  const sleep = r.deps.sleep;
  let rounds = 0;
  r.deps.sleep = async (ms, signal) => {
    if (++rounds === 1) r.down.clear();
    await sleep(ms, signal);
  };
  await r.run();
  assert.deepEqual(r.sent.map((m) => m.body.event), ["check-failed", "new-findings"]);
  assert.deepEqual(r.sent[1]!.body.findings.map((f: any) => f.resourceIds[0]), ["vol-0bbbbbbbbbbbbbbbb"], "still new, so still said");
});

test("without a target the loop prints and keeps its baseline, and sends nothing", async () => {
  const r = rig([at([a]), at([a, b])], { urls: [] });
  const end = await r.run();
  assert.deepEqual(r.sent, []);
  assert.equal(r.saved.length, 2);
  assert.equal(end.exitCode, 0);
});

test("a check that failed for part of the account does not make its findings new when it works again", async () => {
  // Round 2 could not read ap-south-1, so the volume looks gone. It is not resolved, and not new when it is read again.
  const warned = at([b], { warnings: ["[ap-south-1] ec2:DescribeVolumes was denied"] });
  const r2 = rig([warned, at([a, b])], { baseline: at([a, b]) });
  await r2.run();
  assert.deepEqual(r2.sent, [], "nothing was resolved and nothing was new");
  assert.deepEqual(r2.saved[0]!.findings.map((f) => f.resourceIds[0]), ["vol-0bbbbbbbbbbbbbbbb", "vol-0aaaaaaaaaaaaaaaa"], "the unread region's findings are carried forward");
});

test("a baseline of another account is not compared with: the first report is sent", async () => {
  const r = rig([at([a])], { baseline: at([a], { accountId: "999999999999" }) });
  await r.run();
  assert.equal(r.sent[0]!.body.event, "first-report");
});

test("a baseline that cannot be kept is said once and the watch carries on from memory", async () => {
  const r = rig([at([a]), at([a]), at([a, b])], { saveFails: true });
  await r.run();
  assert.equal(r.err.filter((l) => l.startsWith("Could not keep the baseline")).length, 1);
  assert.deepEqual(r.sent.map((m) => m.body.event), ["first-report", "new-findings"], "in memory it still knew what had been reported");
});

test("rounds wait the interval between them, stop at --max-runs, and never overlap", async () => {
  const r = rig([at([a]), at([a]), at([a]), at([a])], { maxRuns: 3 });
  const end = await r.run();
  assert.equal(end.rounds, 3);
  assert.deepEqual(r.sleeps, [6 * 3600_000, 6 * 3600_000], "no wait after the last round");
  assert.equal(r.overlap.max, 1);
});

test("without --max-runs it goes on until stopped, and stopping between rounds is a clean exit", async () => {
  const r = rig([at([a])], { maxRuns: undefined });
  r.options.maxRuns = undefined;
  const stop = new AbortController();
  let rounds = 0;
  r.deps.sleep = async () => {
    if (++rounds === 4) stop.abort();
  };
  const end = await r.run(stop.signal);
  assert.equal(end.rounds, 4);
  assert.equal(end.stopped, true);
  assert.equal(end.exitCode, 0);
});

test("stopping in the middle of a round does not wait for the scan", async () => {
  const r = rig([never]);
  const stop = new AbortController();
  const running = r.run(stop.signal);
  setTimeout(() => stop.abort(), 5);
  const end = await running;
  assert.equal(end.stopped, true);
  assert.equal(end.exitCode, 0);
  assert.deepEqual(r.sent, []);
});

test("stopping while a message is being sent does not wait for it, and says what was left", async () => {
  const stop = new AbortController();
  const r = rig([at([a])]);
  r.deps.send = (_target, _body, signal) =>
    new Promise((_, reject) => {
      stop.abort();
      signal.addEventListener("abort", () => reject(new Error("stopped before it was sent")));
    });
  const end = await r.run(stop.signal);
  assert.equal(end.stopped, true);
  assert.equal(end.exitCode, 0);
  assert.equal(r.saved.length, 0, "an undelivered message leaves its findings new");
  assert.match(r.err.at(-1)!, /^Stopped with a message not yet delivered\. Its findings are still new, so the next run reports them\.$/);
});

test("a signal that arrives before the first round runs no round", async () => {
  const stop = new AbortController();
  stop.abort();
  const r = rig([at([a])]);
  const end = await r.run(stop.signal);
  assert.equal(end.rounds, 0);
  assert.deepEqual(r.sent, []);
});

test("a message is sent for a replay with its banner", async () => {
  const r = rig([at([a])]);
  r.deps.scan = async () => ({ result: at([a]), banner: "REPLAY MODE: recorded earlier. No live calls. Notifications are still sent." });
  await r.run();
  assert.equal(r.sent[0]!.body.text.split("\n")[1], "REPLAY MODE: recorded earlier. No live calls. Notifications are still sent.");
});

test("the loop compares exactly as scan does", async () => {
  const baseline = at([a, b]);
  const next = at([a, c]);
  const r = rig([next], { baseline });
  await r.run();
  assert.deepEqual(r.sent[0]!.body.comparison, compareScans(baseline, next)!.comparison);
});

test("what is carried forward is only what an unread region had, and only for the same account", () => {
  const before = at([a, b, finding("snap-0eeeeeeeeeeeeeeee", 2.5, { region: "us-east-1" })], { regions: ["ap-south-1", "us-east-1"] });
  const now = at([a], { regions: ["ap-south-1", "us-east-1"], warnings: ["[us-east-1] ec2:DescribeSnapshots was denied"] });
  // b is gone from a region that was read in full: resolved. The snapshot is in a region with a failed check: carried.
  assert.deepEqual(carryForward(before, now).findings.map((f) => f.resourceIds[0]), ["vol-0aaaaaaaaaaaaaaaa", "snap-0eeeeeeeeeeeeeeee"]);
  assert.equal(carryForward(before, now).totalMonthlyWasteUsd, 59.5);
  assert.equal(carryForward(undefined, now), now);
  assert.equal(carryForward(at([a], { accountId: "999999999999" }), now), now);
  assert.equal(carryForward(before, at([a], { regions: ["ap-south-1", "us-east-1"] })).findings.length, 1, "nothing to carry when every check ran everywhere");
  // A round narrowed to fewer regions read nothing in the others, so what they had is still unknown, not gone.
  assert.deepEqual(
    carryForward(before, at([a], { regions: ["ap-south-1"] })).findings.map((f) => f.resourceIds[0]),
    ["vol-0aaaaaaaaaaaaaaaa", "snap-0eeeeeeeeeeeeeeee"],
  );
  // A cluster is read as a whole: a failed read leaves every namespace in doubt.
  const cluster = { context: "prod", lookbackHours: 1, prices: { source: "opencost-defaults" as const, cpuHourUsd: 0, memoryGibHourUsd: 0, storageGibMonthUsd: 0 } };
  const was = at([finding("deployment/api", 5, { region: "shop" })], { accountId: "prod", regions: ["shop"], cluster });
  const is = at([], { accountId: "prod", regions: ["shop"], cluster, warnings: ["Prometheus did not answer the query"] });
  assert.equal(carryForward(was, is).findings.length, 1);
});

test("a round over fewer regions keeps the rest of the baseline, so a wider round later reports nothing new", async () => {
  const far = finding("vol-0dddddddddddddddd", 3, { region: "us-east-1" });
  const wide = at([a, far], { regions: ["ap-south-1", "us-east-1"] });
  // Restarted with --region ap-south-1: this round only reads the one region.
  const narrow = rig([at([a], { regions: ["ap-south-1"] })], { baseline: wide });
  await narrow.run();
  assert.deepEqual(narrow.sent, [], "nothing is new and nothing is resolved, so nothing is said");
  const kept = narrow.saved.at(-1)!;
  assert.deepEqual(kept.findings.map((f) => f.resourceIds[0]).sort(), ["vol-0aaaaaaaaaaaaaaaa", "vol-0dddddddddddddddd"]);
  assert.deepEqual(kept.regions, ["ap-south-1", "us-east-1"], "the baseline stands for everywhere it has an answer for");

  // And the next round over both regions finds nothing new, instead of re-announcing us-east-1.
  const again = rig([at([a, far], { regions: ["ap-south-1", "us-east-1"] })], { baseline: kept });
  await again.run();
  assert.deepEqual(again.sent, []);
});

test("after a narrowed round, a finding new in a region the baseline already answered for is not called newly covered", async () => {
  const far = finding("vol-0dddddddddddddddd", 3, { region: "us-east-1" });
  const wide = at([a, far], { regions: ["ap-south-1", "us-east-1"] });
  const narrow = rig([at([a], { regions: ["ap-south-1"] })], { baseline: wide });
  await narrow.run();
  const kept = narrow.saved.at(-1)!;

  // Wide again, with one genuinely new us-east-1 finding: new, but not in a region the baseline had no answer for.
  const extra = finding("vol-0ffffffffffffffff", 7, { region: "us-east-1" });
  const again = rig([at([a, far, extra], { regions: ["ap-south-1", "us-east-1"] })], { baseline: kept });
  await again.run();
  assert.deepEqual(
    again.sent.map((m) => m.body.findings.map((f: { resourceIds: string[] }) => f.resourceIds[0])),
    [["vol-0ffffffffffffffff"]],
  );
  assert.equal(again.sent[0]!.body.comparison.newInRegionsNotScannedBefore, 0);
  assert.doesNotMatch(again.out.join("\n"), /region the last scan did not cover/);
});

// The interval

test("an interval is a number and a unit, between 15 minutes and 7 days", () => {
  assert.equal(parseEvery("15m"), MIN_EVERY_MS);
  assert.equal(parseEvery("6h"), 6 * 3600_000);
  assert.equal(parseEvery("1.5h"), 90 * 60_000);
  assert.equal(parseEvery("1d"), 86_400_000);
  assert.equal(parseEvery("7d"), MAX_EVERY_MS);
  assert.throws(() => parseEvery("14m"), /--every must be at least 15m/);
  assert.throws(() => parseEvery("30s"), /--every must be at least 15m/);
  assert.throws(() => parseEvery("8d"), /--every must be 7d or less/);
  for (const bad of ["", "6", "h", "-1h", "6 hours", "every hour", "0h"]) assert.throws(() => parseEvery(bad), /--every takes a number and a unit|at least 15m/, bad);
});

test("--max-runs is a whole number of one or more", () => {
  assert.equal(parseMaxRuns("3"), 3);
  for (const bad of ["0", "-1", "1.5", "many", ""]) assert.throws(() => parseMaxRuns(bad), /--max-runs takes a whole number/, bad);
});
