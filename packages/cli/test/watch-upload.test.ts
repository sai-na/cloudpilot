/**
 * Uploads under watch, offline and instant: every round that completed is
 * uploaded, a failure is said once, and an upload never decides whether a
 * message was delivered or what has been reported.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScanResult } from "../src/types.js";
import type { Outcome } from "../src/upload.js";
import { watch, type WatchDeps } from "../src/watch.js";
import { finding, scan } from "./scans.js";

const a = finding("vol-0aaaaaaaaaaaaaaaa", 57);
const b = finding("vol-0bbbbbbbbbbbbbbbb", 18.24, { title: "Unattached 200 GB gp3 volume" });

const stored: Outcome = { ok: true, line: "Uploaded the scan to hosted.example.com: stored (1 new, 0 came back, 0 resolved, 0 unchanged).", key: "stored" };
const refused = (status: number): Outcome => ({ ok: false, line: `Could not upload the scan to hosted.example.com: it answered ${status}, which CloudPilot does not know.`, key: `answered ${status}` });

let tick = 0;
const at = (findings: ReturnType<typeof finding>[], extra: Partial<ScanResult> = {}) => scan(findings, { scannedAt: `2026-10-03T0${++tick}:00:00Z`, ...extra });

type Step = ScanResult | Error;

/** A watch with no webhook and an upload that answers `answers` in turn (the last repeats). */
function rig(steps: Step[], answers: Array<Outcome | "throws-stop">, opts: { baseline?: ScanResult } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const uploaded: Array<Record<string, any>> = [];
  const order: string[] = [];
  let round = 0;
  let clock = Date.parse("2026-10-03T00:00:00Z");
  const deps: WatchDeps = {
    scan: async () => {
      const step = steps[Math.min(round++, steps.length - 1)]!;
      if (step instanceof Error) throw step;
      return { result: step };
    },
    baseline: { load: async () => opts.baseline, save: async () => {} },
    send: async () => {},
    upload: async (body) => {
      uploaded.push(JSON.parse(body));
      order.push("upload");
      return answers[Math.min(uploaded.length - 1, answers.length - 1)] as Outcome;
    },
    clock: () => new Date((clock += 6 * 3600_000)),
    sleep: async () => {},
    out: (line) => (order.push("out"), out.push(line)),
    err: (line) => err.push(line),
  };
  return { deps, out, err, uploaded, order, run: (maxRuns = steps.length) => watch({ everyMs: 6 * 3600_000, maxRuns, targets: [], subject: "the AWS account" }, deps, new AbortController().signal) };
}

test("every round that completed is uploaded, with something new or not", async () => {
  const same = [a, b];
  const rounds = [at(same), at(same), at(same)];
  const r = rig(rounds, [stored]);
  const end = await r.run();
  assert.equal(r.uploaded.length, 3, "the service needs every scan to work out what is new and what was resolved");
  assert.deepEqual(r.uploaded.map((u) => u.scannedAt), rounds.map((s) => s.scannedAt));
  assert.equal(r.out.filter((l) => l === stored.line).length, 3);
  assert.deepEqual(r.err, []);
  assert.equal(end.exitCode, 0);
});

test("what a round uploads is what scan --json prints for it: the findings in full, compared with the baseline, and a summary", async () => {
  const baseline = at([a]);
  const r = rig([at([a, b])], [stored], { baseline });
  await r.run();
  const [body] = r.uploaded;
  assert.equal(body!.findings.length, 2, "everything found, not only what is new");
  assert.equal(body!.comparison.newCount, 1);
  assert.deepEqual(body!.findings.map((f: { isNew: boolean }) => f.isNew), [false, true]);
  assert.equal(typeof body!.summary, "string");
  assert.equal(body!.replay, undefined);
});

test("the report is printed before the upload is said, and a round that failed uploads nothing", async () => {
  const r = rig([at([a]), new Error("The security token included in the request is expired")], [stored]);
  const end = await r.run();
  assert.equal(r.uploaded.length, 1, "only the round that completed");
  assert.deepEqual(r.order.slice(0, 3), ["out", "upload", "out"], "the report, then the upload, then what came of it");
  assert.match(r.err[0]!, /The check failed: The security token/);
  assert.equal(end.exitCode, 1);
});

test("a failing upload is said once, not every round, and the report is still printed", async () => {
  const r = rig([at([a]), at([a]), at([a])], [refused(401)]);
  const end = await r.run();
  assert.equal(r.uploaded.length, 3, "it keeps trying every round");
  assert.deepEqual(r.err, [refused(401).line], "said once");
  assert.match(r.out[0]!, /CloudPilot/, "the report came out");
  assert.equal(end.exitCode, 1, "the last upload failed");
});

test("a different failure is said again, and when uploading works again that is said once", async () => {
  const r = rig([at([a]), at([a]), at([a]), at([a]), at([a])], [refused(401), refused(401), refused(404), stored, stored]);
  const end = await r.run();
  assert.deepEqual(r.err, [refused(401).line, refused(404).line]);
  assert.equal(r.out.filter((l) => /Uploading works again\.$/.test(l)).length, 1);
  assert.equal(r.out.filter((l) => l === stored.line).length, 2);
  assert.equal(end.exitCode, 0, "the last upload worked");
});

test("a failure that differs only in numbers is the same failure", async () => {
  const line = (port: number): Outcome => ({ ok: false, line: `Could not upload the scan to 127.0.0.1:${port}: could not reach 127.0.0.1:${port} (fetch failed).`, key: "no answer: could not reach 127.0.0.1:# (fetch failed)" });
  const r = rig([at([a]), at([a])], [line(1111), line(2222)]);
  await r.run();
  assert.equal(r.err.length, 1);
});

test("an upload does not decide what has been reported: the baseline moves as it would without one", async () => {
  const saved: ScanResult[] = [];
  const r = rig([at([a, b])], [refused(401)], { baseline: at([a]) });
  r.deps.baseline.save = async (result) => void saved.push(result);
  await r.run();
  assert.equal(saved.length, 1, "nothing was owed to a webhook, so what was reported moved");
});

test("without an upload nothing is uploaded and nothing changes", async () => {
  const r = rig([at([a])], [stored]);
  delete r.deps.upload;
  const end = await r.run();
  assert.equal(r.uploaded.length, 0);
  assert.equal(end.exitCode, 0);
});
