import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, FIXTURE } from "./helpers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLUSTER = resolve(ROOT, "demo/cluster-lab");
const ANSWER_KEY = resolve(ROOT, "k8s-lab/answer-key.json");

/** What `str.rstrip("\n")` in demo/capture.py does, so a scene is rebuilt line for line as the capture composed it. */
const withoutTrailingNewlines = (text: string) => text.replace(/\n+$/, "");

const CAST = resolve(ROOT, "docs/demo.cast");
/** Where one scene of the capture ends and the next begins: the screen is cleared between them. */
const CLEAR = "\u001b[2J\u001b[H";
const ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Everything the capture printed to the screen, as one string with plain line ends. */
function captured(): string {
  const [, ...events] = readFileSync(CAST, "utf8").trim().split("\n");
  return events
    .map((line) => JSON.parse(line) as [number, string, string])
    .map(([, , text]) => text)
    .join("")
    .replaceAll("\r\n", "\n");
}

/** The screen size the cast was recorded at, which is the size demo/capture.py renders the GIF at. */
function screenSize(): { width: number; height: number } {
  return JSON.parse(readFileSync(CAST, "utf8").split("\n")[0]) as { width: number; height: number };
}

/** How many rows of a `width`-column screen these lines fill, counting the row the cursor ends on (see rows_filled in demo/capture.py). */
function rowsFilled(lines: string[], width: number): number {
  return lines.reduce((rows, line) => rows + Math.max(1, Math.ceil(line.replace(ESCAPE, "").length / width)), 0) + 1;
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
    // The capture shows the stderr progress first (head never cuts it), then the report, as demo/capture.py composes them.
    const report = withoutTrailingNewlines(run.stdout).split("\n");
    const shown = [
      ...withoutTrailingNewlines(run.stderr).split("\n"),
      ...(scene.lines ? report.slice(0, scene.lines) : report),
    ].join("\n");
    assert.ok(screen.includes(shown), `the capture no longer shows what "cloudpilot ${scene.args[0]}" prints; run demo/capture.py`);
  }
  // A replay says it is one, and the capture must show that line for each scene.
  assert.equal(screen.match(/REPLAY MODE: /g)?.length, 3);
});

test("every scene of the capture fits the screen the GIF is rendered at", () => {
  // agg wraps at the cast's width and scrolls past its height, so a scene over
  // the budget loses its top rows from docs/demo.gif - the prompt first, then
  // the REPLAY MODE line - while the cast still holds every line.
  const { width, height } = screenSize();
  const scenes = captured().split(CLEAR);
  assert.equal(scenes.length, 3);
  for (const [number, scene] of scenes.entries()) {
    const lines = scene.replace(/\n ?$/, "").split("\n");
    const filled = rowsFilled(lines, width);
    assert.ok(
      filled <= height,
      `scene ${number + 1} of the capture fills ${filled} rows of the ${height}-row screen, so the GIF scrolls its top away; show fewer lines of the report, or raise ROWS in demo/capture.py`,
    );
  }
});
