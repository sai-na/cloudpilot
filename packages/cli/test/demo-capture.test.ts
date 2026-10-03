import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, FIXTURE } from "./helpers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLUSTER = resolve(ROOT, "demo/cluster-lab");
const ANSWER_KEY = resolve(ROOT, "k8s-lab/answer-key.json");

/** Everything the capture printed to the screen, as one string with plain line ends. */
function captured(): string {
  const [, ...events] = readFileSync(resolve(ROOT, "docs/demo.cast"), "utf8").trim().split("\n");
  return events
    .map((line) => JSON.parse(line) as [number, string, string])
    .map(([, , text]) => text)
    .join("")
    .replaceAll("\r\n", "\n");
}

test("the cluster recording in demo/ still replays, with no network, and scores 5 of 5", () => {
  const run = cli(["kube", "--replay", CLUSTER, "--answer-key", ANSWER_KEY], { blockNetwork: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /REPLAY MODE/);
  assert.match(run.stdout, /Found 5\/5, cost within 1% 5\/5, fix command matches 5\/5/);
  assert.match(run.stdout, /\nPASS\n/);
});

test("the capture in docs/ shows what the commands print today", () => {
  // docs/demo.cast is made by demo/capture.py from these same three runs. If a
  // report changes, the capture is out of date: run demo/capture.py again.
  const screen = captured();
  const scenes: Array<{ args: string[]; lines?: number }> = [
    { args: ["scan", "--replay", FIXTURE, "--no-compare"], lines: 19 },
    { args: ["kube", "--replay", CLUSTER, "--no-compare"], lines: 19 },
    { args: ["kube", "--replay", CLUSTER, "--answer-key", ANSWER_KEY] },
  ];
  for (const scene of scenes) {
    const run = cli(scene.args, { blockNetwork: true });
    assert.equal(run.status, 0, run.stderr);
    const report = run.stdout.trimEnd().split("\n");
    const shown = (scene.lines ? report.slice(0, scene.lines) : report).join("\n");
    assert.ok(screen.includes(shown), `the capture no longer shows what "cloudpilot ${scene.args[0]}" prints; run demo/capture.py`);
  }
  // A replay says it is one, and the capture must show that line for each scene.
  assert.equal(screen.match(/REPLAY MODE: /g)?.length, 3);
});
