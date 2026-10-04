/**
 * Advisories through the command, against the recorded lab with kubectl
 * replaced by a stand-in that serves it: what each surface shows, that
 * --no-advisories leaves them out and skips the nodes, and that findings,
 * the score, the comparison, a webhook and an upload behave as they did.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, cliRun, fakeKubectl, fakeOpenAI, says } from "./helpers.js";
import { assertTakenByHostedService, hosted, stored, TOKEN } from "./hosted.js";
import { hook } from "./webhook.js";

const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, "fixtures/kube-lab.json");
const ANSWER_KEY = resolve(here, "../../../k8s-lab/answer-key.json");
const NODES = "/api/v1/nodes?limit=500";
const NO_KUBECTL = { PATH: dirname(process.execPath) };
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `cloudpilot-${name}-`));

/** The recorded lab, changed by `edit`, written where a stand-in kubectl can serve it. */
function doctored(edit: (responses: Record<string, any>) => void) {
  const lab = JSON.parse(readFileSync(LAB, "utf8"));
  edit(lab.responses);
  const file = join(tmp("lab"), "kube-lab.json");
  writeFileSync(file, JSON.stringify(lab));
  return file;
}

/** The lab with a control plane and two workers of 2 CPU and 4Gi, its pods on the workers. */
const workers = (responses: Record<string, any>) => {
  const [proto] = responses[NODES].items;
  const worker = (name: string) => ({ ...proto, metadata: { name, labels: { "kubernetes.io/hostname": name } }, status: { ...proto.status, allocatable: { cpu: "2", memory: "4Gi" } } });
  responses[NODES].items = [proto, worker("worker-1"), worker("worker-2")];
  responses["/api/v1/pods?limit=500"].items.forEach((p: any, i: number) => (p.spec.nodeName = `worker-${(i % 2) + 1}`));
};

function withKubectl(fixture = LAB) {
  const kubectl = fakeKubectl(fixture);
  const cwd = tmp("kube");
  return {
    cwd,
    kubectl,
    run: (args: string[], env: Record<string, string> = {}) => cli(["kube", "--lookback-hours", "1", ...args], { blockNetwork: true, cwd, env: { ...kubectl.env, ...env } }),
    paths: () => kubectl.calls().filter((c) => c.slice(-3, -1).join(" ") === "get --raw").map((c) => c.at(-1)!),
  };
}

/** Every kubectl call was a read of a path, or the local config. */
function assertOnlyReads(calls: string[][]) {
  assert.ok(calls.length > 10);
  for (const call of calls) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok(rest.slice(0, 2).join(" ") === "get --raw" || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }
}

// What it shows

test("cloudpilot kube lists advisories after the findings, in their own section, and asks the API server for the nodes with a GET", () => {
  const lab = withKubectl();
  const run = lab.run([]);
  assert.equal(run.status, 0, run.stderr);
  // The findings, as ever.
  assert.match(run.stdout, /^5 findings, \$50\.64 per month of estimated waste$/m);
  assert.match(run.stdout, /Estimated waste: \$50\.64 per month across 5 findings in 1 of the 4 namespaces scanned\./);
  // The advisories, after them and before the summary.
  const at = (needle: string) => run.stdout.indexOf(needle);
  assert.ok(at("CloudPilot is read-only: it prints these commands") < at("Also worth a look (not counted as waste)"));
  assert.ok(at("Also worth a look (not counted as waste)") < at("\nSummary\n"));
  assert.match(run.stdout, /^ 1\. Container job of deployment\/importer was killed for running out of memory$/m);
  assert.match(run.stdout, /^ 2\. Deployment local-path-provisioner sets no CPU or memory request$/m);
  assert.match(run.stdout, /kubectl set resources deployment\/importer -n shop --context kind-cloudpilot-lab -c job --limits=memory=320Mi/);
  // The lab's only node is its control plane, so there is nothing to say about spare nodes.
  assert.doesNotMatch(run.stdout, /spare-node-capacity/);
  // The summary is the one it always was.
  assert.doesNotMatch(run.stdout.slice(at("\nSummary\n")), /importer|advisor/i);

  assertOnlyReads(lab.kubectl.calls());
  assert.ok(lab.paths().includes(NODES), "the nodes were read, with a GET");
});

test("--json has an advisories array of a stable shape, kept out of the findings and the total", () => {
  const run = withKubectl().run(["--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.findings.length, 5);
  assert.equal(result.totalMonthlyWasteUsd.toFixed(2), "50.64");
  assert.deepEqual(result.advisoryWarnings, []);
  assert.ok(result.findings.every((f: { pattern: string }) => !["out-of-memory", "no-requests"].includes(f.pattern)));
  assert.deepEqual(
    result.advisories.map((a: { rule: string }) => a.rule),
    ["out-of-memory", "no-requests"],
  );
  const [oom, bare] = result.advisories;
  assert.deepEqual(Object.keys(oom).sort(), ["advice", "container", "countedInTotal", "evidence", "kind", "namespace", "resource", "rule", "suggestion", "title"]);
  assert.deepEqual(Object.keys(bare).sort(), ["advice", "countedInTotal", "evidence", "kind", "namespace", "resource", "rule", "title"]);
  assert.deepEqual(Object.keys(oom.suggestion).sort(), ["commands", "risk", "rollback"]);
  assert.deepEqual([oom.kind, oom.resource, oom.namespace, oom.container, oom.countedInTotal, oom.suggestion.risk], ["Deployment", "deployment/importer", "shop", "job", false, "caution"]);
  assert.deepEqual([bare.resource, bare.namespace, bare.countedInTotal], ["deployment/local-path-provisioner", "local-path-storage", false]);
});

test("--no-advisories leaves them out of every report and does not read the nodes", () => {
  const lab = withKubectl();
  const run = lab.run(["--no-advisories", "--out", "report.md", "--html", "report.html"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^5 findings, \$50\.64 per month of estimated waste$/m);
  assert.doesNotMatch(run.stdout, /Also worth a look/);
  assert.doesNotMatch(readFileSync(join(lab.cwd, "report.md"), "utf8"), /Also worth a look/);
  assert.doesNotMatch(readFileSync(join(lab.cwd, "report.html"), "utf8"), /Also worth a look|class="advisor/);
  assert.ok(!lab.paths().includes(NODES), "no read of the nodes was made");
  assertOnlyReads(lab.kubectl.calls());

  const json = JSON.parse(withKubectl().run(["--json", "--no-advisories"]).stdout);
  assert.ok(!("advisories" in json) && !("advisoryWarnings" in json));
  // The findings are what they are with advisories on.
  const full = JSON.parse(withKubectl().run(["--json"]).stdout);
  assert.deepEqual(json.findings, full.findings);
  assert.equal(json.totalMonthlyWasteUsd, full.totalMonthlyWasteUsd);
});

test("the Markdown, plain-text and HTML files carry the section, and the HTML has no tick box for an advisory", () => {
  const lab = withKubectl();
  const run = lab.run(["--out", "report.md", "--html", "report.html"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(join(lab.cwd, "report.md"), "utf8"), /\n## Also worth a look \(not counted as waste\)\n/);
  const txt = lab.run(["--out", "report.txt", "--no-compare"]);
  assert.equal(txt.status, 0, txt.stderr);
  const plain = readFileSync(join(lab.cwd, "report.txt"), "utf8");
  assert.match(plain, /^Also worth a look \(not counted as waste\)$/m);
  assert.doesNotMatch(plain, /\u001b\[/);

  const html = readFileSync(join(lab.cwd, "report.html"), "utf8");
  const section = html.slice(html.indexOf('<section class="advisories"'), html.indexOf("</section>\n<section class=\"notes\">"));
  assert.match(section, /<h2>Also worth a look \(not counted as waste\)<\/h2>/);
  assert.equal((section.match(/<article class="advisory">/g) ?? []).length, 2);
  assert.doesNotMatch(section, /<input|<button|data-lines/);
  // The fixes in the script are the five findings' and nothing else.
  assert.equal((html.match(/<input type="checkbox"/g) ?? []).length, 5);
  assert.ok(!html.slice(html.indexOf('id="script-text"'), html.indexOf("</code>", html.indexOf('id="script-text"'))).includes("--limits"));
});

test("the lab still scores 5 of 5 with nothing outside its answer key, however many advisories there are", () => {
  for (const fixture of [LAB, doctored(workers)]) {
    const run = withKubectl(fixture).run(["--answer-key", ANSWER_KEY]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Found 5\/5, cost within 1% 5\/5, fix command matches 5\/5 \(5\/5 exact\)\.\nNo findings outside the answer key\.\n\nPASS/);
    assert.doesNotMatch(run.stdout, /Also worth a look/);
  }
});

test("with a worker pool the spare capacity is reported, the control plane is left out, and the total does not move", () => {
  const lab = withKubectl(doctored(workers));
  const json = JSON.parse(lab.run(["--json"]).stdout);
  const spare = json.advisories.find((a: { rule: string }) => a.rule === "spare-node-capacity");
  assert.equal(spare.title, "The requests would fit on fewer nodes: none of 2 could be removed now, up to 1 once the suggested requests are applied");
  assert.deepEqual(spare.capacity.excludedNodes, ["cloudpilot-lab-control-plane"]);
  assert.equal(spare.estimatedMonthlyUsd, 58.52);
  assert.equal(spare.countedInTotal, false);
  assert.equal(json.totalMonthlyWasteUsd.toFixed(2), "50.64");
  assert.equal(json.findings.length, 5);
});

// What it leaves alone

test("a second scan with --only-new still lists the advisories in full, and compares findings as it always did", () => {
  const lab = withKubectl();
  assert.equal(lab.run([]).status, 0);
  const again = lab.run(["--only-new"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^No new or resolved findings since the last scan/m);
  assert.match(again.stdout, /Nothing new since the last scan; the 5 findings already reported are not listed\./);
  assert.match(again.stdout, /^Also worth a look \(not counted as waste\)$/m);
  assert.match(again.stdout, /^ 1\. Container job of deployment\/importer was killed/m);
  const json = JSON.parse(lab.run(["--json"]).stdout);
  assert.deepEqual([json.comparison.newCount, json.comparison.resolved.length, json.comparison.unchangedCount], [0, 0, 5]);
});

test("nodes that cannot be read give a warning of their own, and a finding that really went is still called resolved", () => {
  const lab = withKubectl();
  assert.equal(lab.run([]).status, 0);
  // Next time the nodes are unreadable, and the reports workload has been deleted.
  const next = doctored((responses) => {
    delete responses[NODES];
    for (const path of ["/api/v1/pods?limit=500"]) responses[path].items = responses[path].items.filter((p: any) => !p.metadata.name.startsWith("reports-"));
    responses["/apis/apps/v1/replicasets?limit=500"].items = responses["/apis/apps/v1/replicasets?limit=500"].items.filter((r: any) => !r.metadata.name.startsWith("reports-"));
    responses["/apis/apps/v1/deployments?limit=500"].items = responses["/apis/apps/v1/deployments?limit=500"].items.filter((d: any) => d.metadata.name !== "reports");
  });
  const after = cli(["kube", "--lookback-hours", "1", "--json"], { blockNetwork: true, cwd: lab.cwd, env: fakeKubectl(next).env });
  assert.equal(after.status, 0, after.stderr);
  const json = JSON.parse(after.stdout);
  assert.match(json.advisoryWarnings[0], /^Spare node capacity could not be checked: the nodes could not be read: Error from server \(NotFound\)/);
  assert.deepEqual(json.warnings, [], "the warning the findings depend on is not set");
  assert.equal(json.comparison.resolved.length, 1, "a refused read of the nodes does not make a comparison doubt the findings");
  assert.match(json.comparison.resolved[0].title, /reports/);
  assert.equal(json.findings.length, 4);

  const text = cli(["kube", "--lookback-hours", "1"], { blockNetwork: true, env: fakeKubectl(next).env });
  assert.match(text.stdout, /^1 check\(s\) could not run:\n {2}- Spare node capacity could not be checked/m);
  assert.match(text.stdout, /^Also worth a look/m, "the advisories that need no nodes are still listed");
});

test("a webhook is told exactly what it was told before, and an upload carries advisories because it carries what --json prints", async () => {
  const bodyOf = async (extra: string[]) => {
    const server = await hook(() => ({ status: 200, body: "ok" }));
    try {
      const run = await cliRun(["kube", "--lookback-hours", "1", "--notify", server.url, ...extra], { env: fakeKubectl(LAB).env });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(server.requests.length, 1);
      return JSON.parse(server.requests[0]!.body);
    } finally {
      await server.close();
    }
  };
  const [on, off] = [await bodyOf([]), await bodyOf(["--no-advisories"])];
  delete on.scannedAt;
  delete off.scannedAt;
  assert.deepEqual(on, off);
  assert.doesNotMatch(JSON.stringify(on), /importer was killed|advisories|local-path-provisioner/);

  const server = await hosted(() => stored());
  try {
    const run = await cliRun(["kube", "--lookback-hours", "1", "--json", "--upload", server.url], { env: { ...fakeKubectl(LAB).env, CLOUDPILOT_UPLOAD_TOKEN: TOKEN } });
    assert.equal(run.status, 0, run.stderr);
    const sent = JSON.parse(server.requests[0]!.body);
    assert.deepEqual(sent, JSON.parse(run.stdout), "the body is what --json prints");
    assert.equal(sent.advisories.length, 2);
    assertTakenByHostedService(sent);
  } finally {
    await server.close();
  }
});

test("watch --kube takes --no-advisories and skips the nodes; watching an account refuses it", async () => {
  const on = fakeKubectl(LAB);
  const watched = await cliRun(["watch", "--kube", "--max-runs", "1", "--lookback-hours", "1"], { env: on.env });
  assert.equal(watched.status, 0, watched.stderr);
  assert.ok(on.calls().some((c) => c.at(-1) === NODES), "the watch reads the nodes by default");
  assertOnlyReads(on.calls());

  const off = fakeKubectl(LAB);
  const quiet = await cliRun(["watch", "--kube", "--no-advisories", "--max-runs", "1", "--lookback-hours", "1"], { env: off.env });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(off.calls().length > 10 && !off.calls().some((c) => c.at(-1) === NODES), "and not with --no-advisories");

  const aws = cli(["watch", "--no-advisories"], { blockNetwork: true });
  assert.equal(aws.status, 1);
  assert.match(aws.stderr, /--no-advisories only applies with --kube\./);
});

// The model

test("kube --explain tells the model the advisories, accepts text that repeats them and discards text that invents", async () => {
  const good = "Also, shop/deployment/importer was killed for running out of memory; raising its limit to 320Mi is a suggestion, not waste, and is not in the $50.64.";
  const model = await fakeOpenAI([says(good), says("Raise the limit of deployment/importer to 384Mi.")]);
  try {
    const run = await cliRun(["kube", "--lookback-hours", "1", "--explain", "--model", "test-model"], { env: { ...fakeKubectl(LAB).env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    const [request] = model.requests;
    assert.match(request.instructions, /The scan may also hold advisories: things for a person to look at that are NOT waste\./);
    assert.match(request.input, /"advisories":\[\{"rule":"out-of-memory"/);
    assert.match(request.input, /The scan also has advisories: things to look at that are not waste\./);
    assert.ok(run.stdout.includes(good), "text that repeats the scan is shown");

    const bad = await cliRun(["kube", "--lookback-hours", "1", "--explain", "--model", "test-model"], { env: { ...fakeKubectl(LAB).env, ...model.env } });
    assert.equal(bad.status, 0, bad.stderr);
    assert.match(bad.stderr, /AI text discarded: it mentioned 384Mi, which is not in the scan data\. Showing the templated summary instead\./);
    assert.ok(!bad.stdout.includes("384Mi"));
  } finally {
    model.close();
  }
});

test("ask --kube lets the model list the advisories with the findings, and holds its answer to them", async () => {
  const model = await fakeOpenAI([
    [{ type: "function_call", id: "fc_0", call_id: "c0", name: "list_findings", arguments: "{}", status: "completed" }],
    says("Nothing waste-related there, but deployment/importer was killed for memory; 320Mi is the limit CloudPilot suggests."),
  ]);
  try {
    const run = await cliRun(["ask", "--kube", "--lookback-hours", "1", "--model", "test-model", "Is anything wrong that is not waste?"], { env: { ...fakeKubectl(LAB).env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    const [, answered] = model.requests;
    const listed = JSON.parse(answered.input[0].output);
    assert.equal(listed.totalMonthlyWasteUsd, "$50.64");
    assert.deepEqual(listed.advisories.map((a: { rule: string }) => a.rule), ["out-of-memory", "no-requests"]);
    assert.ok(run.stdout.includes("320Mi is the limit CloudPilot suggests."), run.stdout + run.stderr);
  } finally {
    model.close();
  }
});

// Record and replay

test("a recording keeps the nodes and their role, drops what a scan never reads, and a replay repeats the advisories", () => {
  const dir = tmp("recording");
  const fixture = doctored(workers);
  const recorded = cli(["kube", "--lookback-hours", "1", "--json", "--record", dir], { blockNetwork: true, env: fakeKubectl(fixture).env });
  assert.equal(recorded.status, 0, recorded.stderr);
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name === "kube.json");
  const kube = JSON.parse(readFileSync(join(files[0]!.parentPath, "kube.json"), "utf8"));
  const [control, ...rest] = kube.responses[NODES][0].answer.items;
  assert.deepEqual(control.metadata.labels, { "node-role.kubernetes.io/control-plane": "" }, "the role is kept, and no other label");
  assert.equal(control.metadata.annotations, undefined);
  assert.ok(!JSON.stringify(kube.responses[NODES]).includes('"images"'));
  assert.equal(rest.length, 2);
  assert.equal(JSON.parse(recorded.stdout).advisories.find((a: { rule: string }) => a.rule === "spare-node-capacity").capacity.excludedNodes.length, 1);

  const replay = cli(["kube", "--replay", dir, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  delete replayed.replay;
  assert.deepEqual(replayed, JSON.parse(recorded.stdout), "the same findings, advisories and figures, the control plane still left out");

  // --no-advisories on a replay skips them, and reads nothing the recording lacks.
  const without = JSON.parse(cli(["kube", "--replay", dir, "--json", "--no-advisories"], { blockNetwork: true, env: NO_KUBECTL }).stdout);
  assert.ok(!("advisories" in without));
  assert.deepEqual(without.findings, replayed.findings);
});

test("a recording made without advisories, or before there were any, replays as it was run: no nodes to miss", () => {
  const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

  const quiet = tmp("quiet");
  assert.equal(cli(["kube", "--lookback-hours", "1", "--record", quiet, "--no-advisories"], { blockNetwork: true, env: fakeKubectl(LAB).env }).status, 0);
  assert.equal(manifestOf(quiet).sessions[0].advisories, false);
  const replayQuiet = cli(["kube", "--replay", quiet, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replayQuiet.status, 0, replayQuiet.stderr);
  assert.ok(!("advisories" in JSON.parse(replayQuiet.stdout)));

  // One made before the flag existed: the session says nothing, and the recording has no nodes.
  const old = tmp("old");
  assert.equal(cli(["kube", "--lookback-hours", "1", "--record", old], { blockNetwork: true, env: fakeKubectl(LAB).env }).status, 0);
  const manifest = manifestOf(old);
  delete manifest.sessions[0].advisories;
  writeFileSync(join(old, "manifest.json"), JSON.stringify(manifest));
  const replayOld = cli(["kube", "--replay", old, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replayOld.status, 0, replayOld.stderr);
  const result = JSON.parse(replayOld.stdout);
  assert.equal(result.findings.length, 5);
  assert.ok(!("advisories" in result));
});
