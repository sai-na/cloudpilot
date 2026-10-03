/**
 * Record and replay for a cluster, and the model's part in it (the summary and
 * the questions), offline. kubectl is a stand-in serving the recorded lab, the
 * model is a stand-in server for OpenAI's endpoint, and a replay gets neither.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collectCluster } from "../src/kube.js";
import { cli, cliAsync, FIXTURE as AWS_RECORDING, fakeKubectl, fakeOpenAI, looksUp, recordingText, says, SECRET_MARKERS } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, "fixtures/kube-lab.json");
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `cloudpilot-${name}-`));
/** A process that has node and nothing else on its PATH: no kubectl. */
const NO_KUBECTL = { PATH: dirname(process.execPath) };

const BANNER = /^REPLAY MODE: recorded \S+ from cluster kind-cloudpilot-lab, 4 namespaces\. No live calls\.$/m;
const QUESTION = "Which workload wastes the most, and is it safe to shrink?";

/** Every kubectl call a stand-in saw was a read, or the local config. */
function assertOnlyReads(calls: string[][]) {
  assert.ok(calls.length > 10);
  for (const call of calls) {
    const rest = call[0] === "--context" ? call.slice(2) : call;
    assert.ok(rest.slice(0, 2).join(" ") === "get --raw" || rest.join(" ") === "config view --minify -o json", `kubectl ${call.join(" ")}`);
  }
}

/** Run the kube command against the stand-in kubectl that serves `fixture`, recording into `dir`. */
function record(dir: string, extra: string[] = [], fixture = LAB) {
  const kubectl = fakeKubectl(fixture);
  const run = cli(["kube", "--lookback-hours", "1", "--json", "--record", dir, ...extra], { blockNetwork: true, env: kubectl.env });
  return { run, kubectl };
}

/** The same, from a copy of the lab changed by `edit`. */
function doctored(edit: (lab: any) => void) {
  const lab = JSON.parse(readFileSync(LAB, "utf8"));
  edit(lab);
  const file = join(tmp("lab"), "kube-lab.json");
  writeFileSync(file, JSON.stringify(lab));
  return file;
}

const recorded = tmp("recording");
const first = record(recorded);

test("a cluster scan can be recorded, and the run itself is a live one", () => {
  assert.equal(first.run.status, 0, first.run.stderr);
  assert.match(first.run.stderr, /Recorded to \S+kube\n?$/);
  const result = JSON.parse(first.run.stdout);
  assert.equal(result.findings.length, 5);
  assert.equal(result.replay, undefined);
  assertOnlyReads(first.kubectl.calls());
});

test("a recorded scan replays byte-identically with no kubectl and every socket blocked", () => {
  const stand = fakeKubectl(LAB);
  // The stand-in is on the PATH this time, and must never be started.
  const replay = cli(["kube", "--replay", recorded, "--json"], { blockNetwork: true, env: stand.env });
  assert.equal(replay.status, 0, replay.stderr);
  assert.throws(() => stand.calls(), /ENOENT/, "kubectl was run during a replay");

  const replayed = JSON.parse(replay.stdout);
  const banner: string = replayed.replay;
  delete replayed.replay;
  assert.equal(JSON.stringify(replayed), JSON.stringify(JSON.parse(first.run.stdout)));
  assert.match(banner, BANNER);
  assert.match(replay.stderr, BANNER);
  assert.match(replay.stderr, /Reading cluster kind-cloudpilot-lab from the recording \(no kubectl\)\.\.\./);
  assert.doesNotMatch(replay.stderr, /through kubectl/);

  const bare = cli(["kube", "--replay", recorded, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, replay.stdout);
});

test("a replayed report starts with the replay banner, and the file reports carry it too", () => {
  const run = cli(["kube", "--replay", recorded, "--html", "report.html", "--out", "report.md"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout.split("\n")[0]!, BANNER);
  assert.match(run.stdout, /^5 findings, \$50\.64 per month of estimated waste$/m);
  // The recording says what it was read with, so a replay needs no --lookback-hours.
  assert.match(run.stdout, /^Usage: Prometheus at monitoring\/prometheus:9090, the last 1 hour$/m);
  assert.match(readFileSync(join(run.cwd, "report.html"), "utf8"), /<p class="replay" role="note">REPLAY MODE: recorded \S+ from cluster kind-cloudpilot-lab, 4 namespaces\. No live calls\.<\/p>/);
  assert.match(readFileSync(join(run.cwd, "report.md"), "utf8"), /REPLAY MODE: recorded/);
});

test("two replays of one recording give byte-identical output", () => {
  const a = cli(["kube", "--replay", recorded], { blockNetwork: true, env: NO_KUBECTL });
  const b = cli(["kube", "--replay", recorded], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(a.stdout, b.stdout);
});

test("a replay never writes the saved last scan, and never compares with one", () => {
  const cwd = tmp("baseline");
  const kubectl = fakeKubectl(LAB);
  const seed = cli(["kube", "--lookback-hours", "1"], { blockNetwork: true, cwd, env: kubectl.env });
  assert.equal(seed.status, 0, seed.stderr);
  const saved = join(cwd, ".cloudpilot/last-kube-scan-kind-cloudpilot-lab.json");
  const baseline = readFileSync(saved, "utf8");

  const replay = cli(["kube", "--replay", recorded], { blockNetwork: true, cwd, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(readFileSync(saved, "utf8"), baseline, "the saved last scan is untouched");
  assert.doesNotMatch(replay.stdout, /since the last scan/i);

  const fresh = cli(["kube", "--replay", recorded], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(existsSync(join(fresh.cwd, ".cloudpilot")), false, "a replay leaves nothing behind in the directory it runs from");

  // The same goes for the recorded run: it does not compare with local state, or the replay could not repeat it.
  const again = cli(["kube", "--lookback-hours", "1", "--json", "--record", tmp("again")], { blockNetwork: true, cwd, env: kubectl.env });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).comparison, undefined);
});

test("a read the recording does not hold fails loudly, naming the read", () => {
  // Another lookback asks Prometheus for figures the recording never saw.
  const run = cli(["kube", "--replay", recorded, "--lookback-hours", "5"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Replay: no recorded response for kubectl get --raw \(\/api\/v1\/namespaces\/monitoring\/services\/prometheus:9090\/proxy\/api\/v1\/query\?query=/);
  assert.match(run.stderr, /never falls back to the cluster/);
  // The banner is out before the first read is attempted; nothing of a report is.
  assert.match(run.stdout, /^REPLAY MODE: [^\n]*\n\n$/);
});

test("a recording of an account is not a recording of a cluster, and the other way round", () => {
  const run = cli(["kube", "--replay", AWS_RECORDING], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /holds no recorded cluster scan\. Record one with --record first\./);
  const only = cli(["scan", "--replay", recorded], { blockNetwork: true });
  assert.equal(only.status, 1);
  assert.match(only.stderr, /holds no recorded scan\. Record one with --record first\./);
  assert.equal(only.stdout, "");

  // A question put to the wrong kind of recording names what is missing: the recording, not the question.
  const asked = cli(["ask", "--kube", "--replay", AWS_RECORDING, QUESTION], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /holds no recorded cluster question\. Record one with --record first\./);
  assert.doesNotMatch(asked.stderr, /This question was not recorded/);
  const awsAsked = cli(["ask", "--replay", recorded, QUESTION], { blockNetwork: true });
  assert.equal(awsAsked.status, 1);
  assert.match(awsAsked.stderr, /holds no recorded ask\. Record one with --record first\./);
  assert.doesNotMatch(awsAsked.stderr, /This question was not recorded/);
});

test("an account and a cluster share one recording directory, each session in a folder of its own", () => {
  const dir = tmp("mixed");
  cpSync(AWS_RECORDING, dir, { recursive: true });
  const run = record(dir).run;
  assert.equal(run.status, 0, run.stderr);

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.accountId, "123456789012", "the account sessions keep their account");
  assert.deepEqual(manifest.sessions.map((s: { id: string }) => s.id), ["scan", "ask-88bc6aba9740", "ask-14a18f21221c", "kube"]);
  const session = manifest.sessions.find((s: { id: string }) => s.id === "kube");
  assert.equal(session.command, "kube");
  assert.equal(session.context, "kind-cloudpilot-lab");
  assert.deepEqual([session.namespace, session.prometheus, session.lookbackHours], [null, null, 1]);
  assert.equal(session.namespaces.length, 4);
  assert.deepEqual(existsSync(join(dir, "kube/kube.json")), true);
  assert.equal(existsSync(join(dir, "kube/aws.json")), false);
  assert.equal(existsSync(join(dir, "scan/kube.json")), false);

  // The account's runs replay exactly as from the recording they came from, and the cluster's from the same directory.
  const mixed = cli(["scan", "--replay", dir, "--json"], { blockNetwork: true });
  const aws = cli(["scan", "--replay", AWS_RECORDING, "--json"], { blockNetwork: true });
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.equal(mixed.stdout, aws.stdout);
  const kube = cli(["kube", "--replay", dir, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(kube.status, 0, kube.stderr);
  assert.equal(JSON.parse(kube.stdout).cluster.context, "kind-cloudpilot-lab");
  const question = cli(["ask", "--replay", dir, "What should I fix first, and what is the risk?"], { blockNetwork: true });
  assert.equal(question.status, 0, question.stderr);
});

test("a recording of a cluster alone names no account", () => {
  const manifest = JSON.parse(readFileSync(join(recorded, "manifest.json"), "utf8"));
  assert.equal(manifest.accountId, undefined);
  assert.deepEqual(manifest.sessions.map((s: { id: string }) => s.id), ["kube"]);
});

test("the recording holds no credentials, and none of what a manifest can carry in its environment or commands", () => {
  const file = doctored((lab) => {
    const pod = lab.responses["/api/v1/pods?limit=500"].items[0];
    pod.spec.containers[0].env = [{ name: "DB_PASSWORD", value: "hunter2-not-for-disk" }];
    pod.spec.containers[0].command = ["sh", "-c", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' https://example.test"];
    pod.metadata.annotations = { ...pod.metadata.annotations, "kubectl.kubernetes.io/last-applied-configuration": '{"env":[{"value":"hunter2-not-for-disk"}]}' };
    pod.metadata.labels = { ...pod.metadata.labels, owner: "someone@example.test" };
  });
  const dir = tmp("secrets");
  const { run } = record(dir, [], file);
  assert.equal(run.status, 0, run.stderr);
  const text = recordingText(dir);
  for (const marker of [...SECRET_MARKERS, "hunter2", "someone@example.test", "last-applied-configuration"]) assert.ok(!text.includes(marker), `recording contains ${marker}`);

  // None of what was dropped is read by the scan, so the replay finds just what the live run found.
  const replay = cli(["kube", "--replay", dir, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  delete replayed.replay;
  assert.equal(JSON.stringify(replayed), JSON.stringify(JSON.parse(run.stdout)));
});

test("an answer that looks like a credential is left out of the recording, and the replay says what is missing", () => {
  const file = doctored((lab) => {
    lab.responses["/api/v1/pods?limit=500"].items[0].spec.containers[0].image = "registry.example.test/app:AKIAIOSFODNN7EXAMPLE";
  });
  const dir = tmp("withheld");
  const { run } = record(dir, [], file);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /1 cluster read\(s\) were left out of the recording because the answer looked like a credential/);
  assert.ok(!recordingText(dir).includes("AKIA"));
  const replay = cli(["kube", "--replay", dir], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /Replay: no recorded response for kubectl get --raw \(\/api\/v1\/pods\?limit=500\)/);
});

test("a read the cluster refused is recorded as refused, so a replay shows the same warning", () => {
  // As an RBAC rule that allows pods but not apps/v1 leaves a scan.
  const file = doctored((lab) => {
    for (const path of Object.keys(lab.responses)) if (path.includes("replicasets")) delete lab.responses[path];
  });
  const dir = tmp("refused");
  const { run } = record(dir, [], file);
  assert.equal(run.status, 0, run.stderr);
  const warnings: string[] = JSON.parse(run.stdout).warnings;
  assert.ok(warnings.some((w) => /^ReplicaSets could not be read: Error from server \(NotFound\)/.test(w)), JSON.stringify(warnings));
  const replay = cli(["kube", "--replay", dir, "--json"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout).warnings, warnings);
});

test("what a recording was told to read, a namespace here, is what its replay reads, whatever the replay is given", async () => {
  // The lab as a cluster would answer for one namespace: the paths a namespaced scan asks for, filled in from the whole-cluster answers.
  const lab = JSON.parse(readFileSync(LAB, "utf8"));
  const responses: Record<string, unknown> = {};
  const usage = (path: string) => (path.includes("container_cpu_usage_seconds_total") ? "cpu" : path.includes("timestamp") ? "first" : "memory");
  await collectCluster(
    {
      identity: async () => lab.identity,
      get: async (path) => {
        const base = path.split("?")[0]!;
        const kind = ["pods", "replicasets", "persistentvolumeclaims", "deployments"].find((k) => base.endsWith(`/${k}`));
        let answer: any;
        if (kind) {
          const whole = lab.responses[`${base.includes("/apis/") ? "/apis/apps/v1" : "/api/v1"}/${kind}?limit=500`];
          answer = { ...whole, items: whole.items.filter((i: any) => i.metadata.namespace === "shop") };
        } else if (path.includes("/proxy/")) {
          const wanted = usage(decodeURIComponent(path));
          answer = lab.responses[Object.keys(lab.responses).find((k) => k.includes("/proxy/") && usage(decodeURIComponent(k)) === wanted)!];
        } else {
          answer = lab.responses[path];
        }
        return (responses[path] = answer);
      },
    },
    { namespace: "shop", lookbackHours: 1, now: new Date(lab.recordedAt) },
  );
  const file = join(tmp("lab"), "kube-lab-shop.json");
  writeFileSync(file, JSON.stringify({ ...lab, responses }));

  const dir = tmp("shop");
  const { run } = record(dir, ["--namespace", "shop"], file);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).findings.length, 5);
  const session = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).sessions[0];
  assert.deepEqual([session.namespace, session.namespaces], ["shop", ["shop"]]);

  const replay = cli(["kube", "--replay", dir, "--json", "--namespace", "elsewhere"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  assert.match(replayed.replay, /^REPLAY MODE: recorded \S+ from cluster kind-cloudpilot-lab, namespace shop\. No live calls\.$/);
  delete replayed.replay;
  assert.equal(JSON.stringify(replayed), JSON.stringify(JSON.parse(run.stdout)));
});

// The model's part.

const WRITTEN = "Shrink deployment/reports first: it wastes $24.43 a month, out of $50.64 in all. Its request rests on one hour of usage history.";

test("without a model key, kube --explain says so in one line and shows the templated summary", () => {
  const kubectl = fakeKubectl(LAB);
  const run = cli(["kube", "--lookback-hours", "1", "--explain"], { blockNetwork: true, env: kubectl.env });
  assert.equal(run.status, 0, run.stderr);
  const notices = run.stderr.split("\n").filter((line) => line.includes("AI explanations are unavailable"));
  assert.deepEqual(notices, ["AI explanations are unavailable: no model API key is set. Showing the templated summary instead."]);
  assert.match(run.stdout, /\nSummary\n\nEstimated waste: \$50\.64 per month across 5 findings in 1 of the 4 namespaces scanned\./);
  assertOnlyReads(kubectl.calls());
});

test("kube --explain gives the model the cluster rules and the findings, shows its text, and records it for replay", async () => {
  const model = await fakeOpenAI([says(WRITTEN)]);
  const dir = tmp("explain");
  const kubectl = fakeKubectl(LAB);
  try {
    const run = await cliAsync(["kube", "--lookback-hours", "1", "--explain", "--model", "test-model", "--record", dir], { env: { ...kubectl.env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /discarded|unavailable/);
    assert.match(run.stdout, new RegExp(`\\nSummary\\n\\n${WRITTEN.replace(/[$.]/g, "\\$&")}`));
    assertOnlyReads(kubectl.calls());

    assert.equal(model.requests.length, 1);
    const [request] = model.requests;
    assert.match(request.instructions, /^You are CloudPilot, a read-only cost advisor for Kubernetes clusters\./);
    assert.match(request.instructions, /cloudpilot\/ignore=true/);
    assert.match(request.instructions, /fewer or smaller nodes/);
    assert.doesNotMatch(request.instructions, /AWS Price List|snapshots|cloudpilot:ignore/);
    assert.match(request.input, /owns this cluster/);
    // Money reaches the model as the strings the report shows, never as a number to compute with.
    assert.match(request.input, /"totalMonthlyWasteUsd":"\$50\.64"/);
    assert.match(request.input, /"monthlyCostUsd":"\$24\.43"/);
  } finally {
    model.close();
  }

  const replay = cli(["kube", "--replay", dir, "--explain"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  assert.doesNotMatch(replay.stderr, /discarded|unavailable/);
  assert.match(replay.stdout, /\nSummary\n\nShrink deployment\/reports first/);
  // A recording made without --explain has no summary to give.
  const plain = cli(["kube", "--replay", recorded, "--explain"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /This recording has no AI summary: it was made without --explain or without a model key\. Showing the templated summary instead\./);
  assert.match(plain.stdout, /\nSummary\n\nEstimated waste: \$50\.64/);
});

test("a summary that names a workload or a figure the scan does not hold is discarded, and its replay is too", async () => {
  const model = await fakeOpenAI([says("Shrink deployment/reports, and also deployment/ghost, which would save $99.99 a month.")]);
  const dir = tmp("invented");
  const kubectl = fakeKubectl(LAB);
  try {
    const run = await cliAsync(["kube", "--lookback-hours", "1", "--explain", "--model", "test-model", "--record", dir], { env: { ...kubectl.env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /AI text discarded: it mentioned \$99\.99, deployment\/ghost, which is not in the scan data\. Showing the templated summary instead\./);
    assert.match(run.stdout, /\nSummary\n\nEstimated waste: \$50\.64 per month across 5 findings/);
    assert.doesNotMatch(run.stdout, /ghost|99\.99/);
  } finally {
    model.close();
  }
  const replay = cli(["kube", "--replay", dir, "--explain"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stderr, /AI text discarded: it mentioned \$99\.99, deployment\/ghost/);
  assert.doesNotMatch(replay.stdout, /ghost/);
});

test("without a model key, ask --kube stops with a clear message before reading the cluster", () => {
  const kubectl = fakeKubectl(LAB);
  const run = cli(["ask", "--kube", QUESTION], { blockNetwork: true, env: kubectl.env });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No model access configured\. Set ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  assert.equal(run.stdout, "");
  assert.throws(() => kubectl.calls(), /ENOENT/, "the cluster was read before the missing key was noticed");
});

test("a flag that belongs to the other kind of question is refused rather than ignored", () => {
  const model = { OPENAI_API_KEY: "test-key" };
  const aws = cli(["ask", "--kube", "--region", "ap-south-1", QUESTION], { blockNetwork: true, env: model });
  assert.equal(aws.status, 1);
  assert.match(aws.stderr, /--region is for an AWS account and does nothing with --kube\./);
  const kube = cli(["ask", "--context", "kind-cloudpilot-lab", QUESTION], { blockNetwork: true, env: model });
  assert.equal(kube.status, 1);
  assert.match(kube.stderr, /--context is for a cluster: add --kube\./);
});

test("ask --kube lets the model look at the findings and the workloads, answers, and records the question for replay", async () => {
  const answer = "deployment/reports wastes the most, $24.43 a month. Its container worker requests 300m CPU and peaked below 1m; a restart is the only risk.";
  const model = await fakeOpenAI([looksUp("list_findings", "get_cluster_workloads"), says(answer)]);
  const dir = tmp("ask");
  const kubectl = fakeKubectl(LAB);
  try {
    const run = await cliAsync(["ask", "--kube", "--lookback-hours", "1", "--model", "test-model", "--record", dir, QUESTION], { env: { ...kubectl.env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /looking up: list_findings\n.*looking up: get_cluster_workloads/s);
    assert.equal(run.stdout.trim(), answer);
    assertOnlyReads(kubectl.calls());
    const reads = kubectl.calls().length;

    const [asked, answered] = model.requests;
    assert.deepEqual(asked.tools.map((t: { name: string }) => t.name), ["list_findings", "get_cluster_workloads"]);
    assert.match(asked.instructions, /Kubernetes clusters/);
    assert.equal(asked.input, QUESTION);
    // What the lookups returned: the findings, and the workloads the scan read, flagged or not.
    const [findings, workloads] = answered.input.map((m: { output: string }) => JSON.parse(m.output));
    assert.equal(findings.totalMonthlyWasteUsd, "$50.64");
    assert.equal(findings.findings[0].resourceIds[0], "deployment/reports");
    assert.equal(workloads.context, "kind-cloudpilot-lab");
    const named = (name: string) => workloads.workloads.find((w: { name: string }) => w.name === name);
    assert.deepEqual([named("web").skippedByLabel, named("web").containers[0].cpuRequest], [false, "100m"]);
    assert.equal(named("prometheus").skippedByLabel, true);
    // The model reads the scan; it never reads the cluster.
    assert.equal(kubectl.calls().length, reads);
  } finally {
    model.close();
  }

  const replay = cli(["ask", "--kube", "--replay", dir, QUESTION], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout.split("\n")[0]!, BANNER);
  assert.match(replay.stderr, /looking up: list_findings\n.*looking up: get_cluster_workloads/s);
  assert.ok(replay.stdout.includes(answer));
  assert.equal(existsSync(join(replay.cwd, ".cloudpilot")), false);
});

test("a question the recording does not hold is refused and the recorded questions are listed, never the account's", async () => {
  const model = await fakeOpenAI([says("deployment/reports, $24.43.")]);
  const dir = tmp("questions");
  cpSync(AWS_RECORDING, dir, { recursive: true });
  const kubectl = fakeKubectl(LAB);
  try {
    const run = await cliAsync(["ask", "--kube", "--lookback-hours", "1", "--model", "test-model", "--record", dir, QUESTION], { env: { ...kubectl.env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    model.close();
  }

  const refused = cli(["ask", "--kube", "--replay", dir, "What is the weather?"], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /This question was not recorded\. Recorded questions:\n  - Which workload wastes the most, and is it safe to shrink\?\n$/);
  assert.equal(refused.stdout, "");
  // And the other way: the account's question list does not carry the cluster's.
  const aws = cli(["ask", "--replay", dir, "What is the weather?"], { blockNetwork: true });
  assert.doesNotMatch(aws.stderr, /Which workload wastes/);
  assert.match(aws.stderr, /What should I fix first, and what is the risk\?/);
});

test("with a live model, a new question is answered from the recorded cluster, with no kubectl", async () => {
  const model = await fakeOpenAI([looksUp("get_cluster_workloads"), says("deployment/web uses what it asks for: 100m CPU requested.")]);
  try {
    const run = await cliAsync(["ask", "--kube", "--replay", recorded, "--live-llm", "--model", "test-model", "Why was web not flagged?"], {
      blockNetwork: false,
      env: { ...NO_KUBECTL, ...model.env },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout.split("\n")[0]!, /^REPLAY MODE: recorded \S+ from cluster kind-cloudpilot-lab, 4 namespaces\. No live kubectl calls; the model is called live\.$/);
    assert.match(run.stdout, /deployment\/web uses what it asks for/);
    const workloads = JSON.parse(model.requests[1].input[0].output);
    assert.ok(workloads.workloads.some((w: { name: string }) => w.name === "web"));
  } finally {
    model.close();
  }
});

test("an answer that names a workload the cluster does not have is discarded", async () => {
  const model = await fakeOpenAI([looksUp("list_findings"), says("Shrink deployment/billing first.")]);
  const kubectl = fakeKubectl(LAB);
  try {
    const run = await cliAsync(["ask", "--kube", "--lookback-hours", "1", "--model", "test-model", QUESTION], { env: { ...kubectl.env, ...model.env } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /AI text discarded: it mentioned deployment\/billing, which is not in the scan data\. Showing the templated summary instead\./);
    assert.match(run.stdout, /^Estimated waste: \$50\.64 per month/);
  } finally {
    model.close();
  }
});

test("a replay of a cluster that cannot be read says the directory is not a recording", () => {
  const empty = tmp("empty");
  mkdirSync(empty, { recursive: true });
  const run = cli(["kube", "--replay", empty], { blockNetwork: true, env: NO_KUBECTL });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /is not a CloudPilot recording \(no manifest\.json\)\./);
});
