/**
 * `--notify` and `watch` as a person runs them: the real command, the recorded
 * lab (or its Kubernetes twin, behind a stand-in kubectl), and a webhook that is
 * a server on 127.0.0.1. Nothing leaves the machine.
 *
 * test/block-network.cjs stops every socket, loopback included, so it cannot be
 * on while a webhook is served; the scans here need no network anyway (a replay
 * makes no calls, and kubectl is a script). Where blocking matters, a run with
 * it on shows what a send that cannot connect does.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, cliAsync, FIXTURE } from "./helpers.js";
import { hook, SECRET, type Hook } from "./webhook.js";

const here = dirname(fileURLToPath(import.meta.url));
const KUBE_FIXTURE = resolve(here, "fixtures/kube-lab.json");

const KUBECTL_STAND_IN = `#!/usr/bin/env node
// Serves the recorded cluster, as in kube.test.ts. KUBE_BROKEN makes every read fail, as an unreachable cluster does,
// and KUBE_NO_CONTEXT leaves kubectl with no current context, which is what a trimmed-down environment looks like.
const fs = require("fs");
const fixture = JSON.parse(fs.readFileSync(process.env.KUBE_FIXTURE, "utf8"));
const args = process.argv.slice(2);
const rest = args[0] === "--context" ? args.slice(2) : args;
// KUBE_NO_KUBECONFIG is a pod: no kubeconfig, so no context to name or to use (see helpers.ts).
if (process.env.KUBE_NO_KUBECONFIG && args[0] === "--context") {
  process.stderr.write("error: cannot locate context " + args[1]);
  process.exitCode = 1;
} else if (process.env.KUBE_NO_KUBECONFIG && rest.join(" ") === "config view --minify -o json") {
  process.stderr.write("error: current-context must exist in order to minify");
  process.exitCode = 1;
} else if (rest.join(" ") === "config view --minify -o json" && process.env.KUBE_NO_CONTEXT) {
  process.stdout.write(JSON.stringify({ contexts: [], clusters: [] }));
} else if (rest.join(" ") === "config view --minify -o json") {
  process.stdout.write(JSON.stringify({ contexts: [{ name: fixture.identity.context }], clusters: [{ cluster: { server: fixture.identity.server } }] }));
} else if (process.env.KUBE_BROKEN) {
  process.stderr.write("Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout");
  process.exitCode = 1;
} else if (rest.length === 3 && rest[0] === "get" && rest[1] === "--raw" && rest[2] in fixture.responses) {
  process.stdout.write(JSON.stringify(fixture.responses[rest[2]]));
} else {
  process.stderr.write("the scanner called something it should not: kubectl " + args.join(" "));
  process.exitCode = 2;
}
`;

const CONTEXT = "kind-cloudpilot-lab";

/** An empty working directory with a kubectl on the PATH that serves the recorded cluster. */
function lab() {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-notify-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "kubectl"), KUBECTL_STAND_IN);
  chmodSync(join(bin, "kubectl"), 0o755);
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:${dirname(process.execPath)}`, KUBE_FIXTURE: KUBE_FIXTURE, ...extra });
  return {
    cwd,
    env,
    file: (name: string) => join(cwd, ".cloudpilot", name),
    /** A run, waited for. */
    run: (args: string[], extra: Record<string, string> = {}) => cliAsync(args, { cwd, env: env(extra) }).done,
  };
}

/** Every file under a directory, as one string: where a secret would show if anything had saved it. */
const everything = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");

const events = (server: Hook) => server.requests.map((r) => JSON.parse(r.body).event);
const bodies = (server: Hook) => server.requests.map((r) => JSON.parse(r.body));

/** Run `body` with a webhook that answers 200, and close it after. */
async function withHook(body: (server: Hook) => Promise<void>, status = 200) {
  const server = await hook(() => ({ status, body: status === 200 ? "ok" : "no_service" }));
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

// scan --notify

test("scan --notify sends the first report once, and the URL is shown nowhere", async () => {
  await withHook(async (server) => {
    const run = await cliAsync(["scan", "--replay", FIXTURE, "--notify", server.url]).done;
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(events(server), ["first-report"]);
    const body = bodies(server)[0];
    assert.equal(body.findings.length, 10);
    assert.match(body.text, /^CloudPilot: first report, 10 findings, \$151\.53 a month, AWS account 123456789012\nREPLAY MODE: recorded \S+ from account 123456789012, region ap-south-1\. No live calls\. Notifications are still sent\.\n/);
    assert.match(run.stderr, /^Sent to 127\.0\.0\.1:\d+\.$/m);
    // The banner says it: a replay still sends the one message it was asked to send.
    assert.match(run.stdout, /^REPLAY MODE: .* No live calls\. Notifications are still sent\.$/m);
    for (const text of [run.stdout, run.stderr, everything(run.cwd)]) assert.ok(!text.includes(SECRET));
  });
});

test("scan --notify sends only what is new since the scan it is compared with, and nothing when nothing is", async () => {
  const lastTime = cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true });
  const earlier = JSON.parse(lastTime.stdout);
  const [added, ...rest] = earlier.findings;
  await withHook(async (server) => {
    const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-notify-"));
    writeFileSync(join(cwd, "yesterday.json"), JSON.stringify({ ...earlier, scannedAt: "2026-10-01T00:00:00Z", findings: rest }));
    const run = await cliAsync(["scan", "--replay", FIXTURE, "--compare", "yesterday.json", "--notify", server.url], { cwd }).done;
    assert.equal(run.status, 0, run.stderr);
    const [body] = bodies(server);
    assert.equal(server.requests.length, 1);
    assert.equal(body.event, "new-findings");
    assert.deepEqual(body.findings.map((f: { resourceIds: string[] }) => f.resourceIds), [added.resourceIds]);
    assert.match(body.text, /^CloudPilot: 1 new finding, \$\d+\.\d\d a month, AWS account 123456789012$/m);
    assert.match(body.text, /Since the last scan \(2026-10-01T00:00:00Z\): 1 new/);

    // Compared with a scan that already has everything: silence, and it says so.
    writeFileSync(join(cwd, "today.json"), JSON.stringify(earlier));
    const quiet = await cliAsync(["scan", "--replay", FIXTURE, "--compare", "today.json", "--notify", server.url], { cwd }).done;
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(server.requests.length, 1, "nothing new sent nothing");
    assert.match(quiet.stderr, /^Nothing new, so nothing was sent to 127\.0\.0\.1:\d+\.$/m);
  });
});

test("scan --notify tells every target, and CLOUDPILOT_NOTIFY works as --notify does", async () => {
  await withHook(async (one) => {
    await withHook(async (two) => {
      const run = await cliAsync(["scan", "--replay", FIXTURE, "--notify", one.url, "--notify", two.url]).done;
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual([one.requests.length, two.requests.length], [1, 1]);
      const env = await cliAsync(["scan", "--replay", FIXTURE], { env: { CLOUDPILOT_NOTIFY: `${one.url}, ${two.url}` } }).done;
      assert.equal(env.status, 0, env.stderr);
      assert.deepEqual([one.requests.length, two.requests.length], [2, 2]);
      assert.ok(!env.stderr.includes(SECRET) && !env.stdout.includes(SECRET));
    });
  });
});

test("a send that is refused is not swallowed: it is said on stderr and the exit code is not zero", async () => {
  await withHook(async (server) => {
    const run = await cliAsync(["scan", "--replay", FIXTURE, "--notify", server.url]).done;
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^Could not send the message: 127\.0\.0\.1:\d+ answered 404 \(no_service\)\. The findings stay new for the next run\.$/m);
    assert.match(run.stdout, /10 findings, \$151\.53 per month/, "the report itself was still printed");
    for (const text of [run.stdout, run.stderr]) assert.ok(!text.includes(SECRET));
  }, 404);
});

test("a webhook that cannot be reached fails the same way, with no URL in what is said", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--notify", `http://127.0.0.1:40404/hooks/${SECRET}`], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Could not send the message: could not reach 127\.0\.0\.1:40404 \(fetch failed: network blocked by test/m);
  for (const text of [run.stdout, run.stderr, everything(run.cwd)]) assert.ok(!text.includes(SECRET));
});

test("a webhook URL that is not https, or not a URL, stops the run before anything is read, naming only the host", () => {
  const insecure = cli(["scan", "--replay", FIXTURE, "--notify", `http://hooks.example.com/${SECRET}`], { blockNetwork: true });
  assert.equal(insecure.status, 1);
  assert.match(insecure.stderr, /^cloudpilot: notify URL 1 of 1 \(hooks\.example\.com\) is not an https URL\./);
  const junk = cli(["scan", "--replay", FIXTURE], { blockNetwork: true, env: { CLOUDPILOT_NOTIFY: `nonsense ${SECRET}` } });
  assert.equal(junk.status, 1);
  assert.match(junk.stderr, /notify URL 1 of 1 is not a URL/);
  for (const run of [insecure, junk]) {
    assert.ok(!run.stderr.includes(SECRET));
    assert.equal(run.stdout, "", "nothing was scanned");
  }
});

test("--notify needs the comparison it reports from", () => {
  const run = cli(["scan", "--replay", FIXTURE, "--no-compare", "--notify", "https://example.com/hook"], { blockNetwork: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--notify needs the comparison to know what is new, so it cannot be used with --no-compare\./);
});

test("a scan of the account that fails is a message of its own, and the run still fails", async () => {
  // A lookback window the recording holds no CloudWatch data for: the scan cannot be made.
  await withHook(async (server) => {
    const run = await cliAsync(["scan", "--replay", FIXTURE, "--lookback-hours", "5", "--notify", server.url]).done;
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    const [body] = bodies(server);
    assert.equal(body.subject, "your AWS account");
    assert.match(body.error, /^Replay: no recorded response for CloudWatch GetMetricData/);
    assert.match(run.stderr, /Told 127\.0\.0\.1:\d+ that the check failed\./);
    assert.match(run.stderr, /cloudpilot: Replay: no recorded response/);
  });
});

test("watch on the account: a round that fails is said, sent, and ends the run non-zero", async () => {
  await withHook(async (server) => {
    const run = await cliAsync(["watch", "--replay", FIXTURE, "--lookback-hours", "5", "--max-runs", "1", "--notify", server.url]).done;
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    assert.match(run.stderr, /The check failed: Replay: no recorded response for CloudWatch GetMetricData/);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET));
  });
});

// kube --notify, where the saved scan can be written

test("kube --notify: a message that did not arrive leaves the findings new, and one that did is not repeated", async () => {
  const k = lab();
  await withHook(async (refusing) => {
    const failed = await k.run(["kube", "--lookback-hours", "1", "--notify", refusing.url]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not send the message: .* answered 404/);
    assert.equal(existsSync(k.file(`last-kube-scan-${CONTEXT}.json`)), false, "nothing is kept as reported");
  }, 404);

  await withHook(async (server) => {
    const first = await k.run(["kube", "--lookback-hours", "1", "--notify", server.url]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(events(server), ["first-report"], "the findings were still new, so the whole report goes now");
    const [body] = bodies(server);
    assert.equal(body.findings.length, 5);
    assert.match(body.text, /^CloudPilot: first report, 5 findings, \$50\.64 a month, cluster kind-cloudpilot-lab$/m);
    assert.match(body.text, /namespace shop/);
    assert.ok(existsSync(k.file(`last-kube-scan-${CONTEXT}.json`)));
    assert.ok(!everything(k.cwd).includes(SECRET), "the URL is in no saved file");

    const second = await k.run(["kube", "--lookback-hours", "1", "--notify", server.url]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(server.requests.length, 1);
    assert.match(second.stderr, /Nothing new, so nothing was sent/);
  });
});

test("kube --replay --notify: the banner does not claim no live calls were made", async () => {
  const k = lab();
  const recording = join(k.cwd, "recording");
  const made = await k.run(["kube", "--lookback-hours", "1", "--record", recording]);
  assert.equal(made.status, 0, made.stderr);

  await withHook(async (server) => {
    const run = await k.run(["kube", "--replay", recording, "--notify", server.url]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(events(server), ["first-report"], "a replay still sends the one message it was asked to send");
    const [body] = bodies(server);
    assert.match(body.text, /^REPLAY MODE: .* No live calls\. Notifications are still sent\.$/m);
    assert.match(run.stdout, /^REPLAY MODE: .* No live calls\. Notifications are still sent\.$/m);
  });
});

test("kube --notify: a cluster that cannot be read is a message of its own, and still fails the run", async () => {
  const k = lab();
  await withHook(async (server) => {
    const run = await k.run(["kube", "--lookback-hours", "1", "--notify", server.url], { KUBE_BROKEN: "1" });
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    const [body] = bodies(server);
    assert.equal(body.subject, "cluster kind-cloudpilot-lab");
    assert.match(body.error, /Unable to connect to the server/);
    assert.match(body.text, /^CloudPilot: the check itself failed \(cluster kind-cloudpilot-lab\)\n.*so this is not a report that nothing is new\./);
    assert.doesNotMatch(body.text, /keeps trying/, "a one-shot scan does not promise to try again");
    assert.match(run.stderr, /Told 127\.0\.0\.1:\d+ that the check failed\./);
  });
});

test("kube --notify: not knowing which cluster to read is a message of its own", async () => {
  const k = lab();
  await withHook(async (server) => {
    const run = await k.run(["kube", "--lookback-hours", "1", "--notify", server.url], { KUBE_NO_CONTEXT: "1" });
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    const [body] = bodies(server);
    assert.equal(body.subject, "cluster (the current context)");
    assert.match(body.error, /kubectl has no current context/);
    assert.match(run.stderr, /Told 127\.0\.0\.1:\d+ that the check failed\./);
  });
});

// watch

test("watch --kube: not knowing which cluster to read is said before the loop starts, not swallowed", async () => {
  const k = lab();
  await withHook(async (server) => {
    const run = await k.run(["watch", "--kube", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url], { KUBE_NO_CONTEXT: "1" });
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    assert.equal(bodies(server)[0].subject, "cluster (the current context)");
    assert.match(bodies(server)[0].error, /kubectl has no current context/);
    assert.equal(existsSync(k.file(`watch-kube-${CONTEXT}.json`)), false);
  });
});

test("watch --kube --max-runs 1: first report, then silence, then only what is new", async () => {
  const k = lab();
  const baseline = k.file(`watch-kube-${CONTEXT}.json`);
  await withHook(async (server) => {
    const args = ["watch", "--kube", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url];
    const first = await k.run(args);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(events(server), ["first-report"]);
    assert.match(first.stderr, /^Watching cluster kind-cloudpilot-lab every 1h, read-only\. Messages go to 127\.0\.0\.1:\d+\. Ctrl\+C stops it\.$/m);
    assert.match(first.stdout, /5 findings, \$50\.64 per month of estimated waste/);
    assert.match(first.stdout, /^Sent to 127\.0\.0\.1:\d+\.$/m);
    assert.ok(existsSync(baseline));
    assert.equal(existsSync(k.file(`last-kube-scan-${CONTEXT}.json`)), false, "scan's baseline is a different file and is left alone");

    // A day with nothing new: one line, no message.
    const quiet = await k.run(args);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(server.requests.length, 1);
    assert.match(quiet.stdout, /^\S+ {2}Nothing new since \S+: 5 findings, \$50\.64 a month\.$/m);

    // Something new: the baseline from before had one finding fewer.
    const kept = JSON.parse(readFileSync(baseline, "utf8"));
    const [added, ...rest] = kept.findings;
    writeFileSync(baseline, JSON.stringify({ ...kept, scannedAt: "2026-10-01T00:00:00Z", findings: rest }));
    const next = await k.run(args);
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(events(server), ["first-report", "new-findings"]);
    assert.deepEqual(bodies(server)[1].findings.map((f: { resourceIds: string[] }) => f.resourceIds), [added.resourceIds]);
    assert.equal(JSON.parse(readFileSync(baseline, "utf8")).findings.length, 5, "and now it has been reported");
    assert.ok(!everything(k.cwd).includes(SECRET));
  });
});

/** What a process in a pod sees: no kubeconfig, and the variables the kubelet sets so that kubectl finds the API server. */
const POD = { KUBE_NO_KUBECONFIG: "1", KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" };

test("watch --kube inside a cluster: the name it was given is the cluster, in every round, in the message and in the baseline", async () => {
  const k = lab();
  const baseline = k.file("watch-kube-prod-eu.json");
  await withHook(async (server) => {
    const args = ["watch", "--kube", "--cluster-name", "prod-eu", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url];
    const first = await k.run(args, POD);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /^Watching cluster prod-eu every 1h, read-only\./m);
    assert.match(first.stderr, /^Reading cluster prod-eu from inside it, as this pod's service account \(read-only\)\.\.\.$/m);
    assert.deepEqual(events(server), ["first-report"]);
    assert.match(bodies(server)[0].text, /^CloudPilot: first report, 5 findings, \$50\.64 a month, cluster prod-eu\n/);
    assert.match(first.stdout, /kubectl set resources deployment\/reports -n shop --context prod-eu -c worker/);
    assert.ok(existsSync(baseline));

    // A restart in the same directory carries on from the baseline: nothing new, nothing sent.
    const quiet = await k.run(args, POD);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(server.requests.length, 1);
  });
});

test("watch --kube inside a cluster with no name: the webhook is told why, before any read, and the run fails", async () => {
  const k = lab();
  await withHook(async (server) => {
    const run = await k.run(["watch", "--kube", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url], POD);
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    assert.match(bodies(server)[0].error, /Name the cluster with --cluster-name <name> \(or CLOUDPILOT_CLUSTER_NAME\)/);
    assert.equal(existsSync(k.file("watch-kube-prod-eu.json")), false);
    assert.doesNotMatch(run.stderr + run.stdout, /Reading cluster/);
  });
});

test("watch --kube inside a cluster: a failure before the cluster can be read still says which cluster it was", async () => {
  const k = lab();
  await withHook(async (server) => {
    // A pod whose image has no kubectl: the watch cannot even find out what it is reading, which is a failed check like any other.
    const noKubectl = { ...POD, PATH: dirname(process.execPath) };
    const run = await k.run(["watch", "--kube", "--cluster-name", "prod-eu", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url], noKubectl);
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    // In a pod there is no current context to name, so the one message that breaks the silence has to carry the name the cluster was given.
    assert.equal(bodies(server)[0].subject, "cluster prod-eu");
    assert.doesNotMatch(bodies(server)[0].text, /the current context/);
    assert.match(bodies(server)[0].error, /kubectl was not found on your PATH/);
  });
});

test("outside a cluster, a failure before the read never claims the cluster CLOUDPILOT_CLUSTER_NAME names", async () => {
  const k = lab();
  await withHook(async (server) => {
    // A laptop with the variable left in a shell profile: kubectl would have read its own current context and ignored the name entirely.
    const brokenKubectl = { PATH: dirname(process.execPath), CLOUDPILOT_CLUSTER_NAME: "prod-eu" };
    const run = await k.run(["kube", "--lookback-hours", "1", "--notify", server.url], brokenKubectl);
    assert.equal(run.status, 1);
    assert.deepEqual(events(server), ["check-failed"]);
    assert.equal(bodies(server)[0].subject, "cluster (the current context)");
    assert.ok(!JSON.stringify(bodies(server)[0]).includes("prod-eu"), "a cluster that was never going to be read is not named");
  });
});

test("watch: --cluster-name is for a cluster, so it is refused without --kube", async () => {
  const run = await lab().run(["watch", "--cluster-name", "prod-eu", "--max-runs", "1"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--cluster-name only applies with --kube\./);
});

test("watch: a webhook that refuses keeps the findings new, fails the run, and the next round with a working one reports them", async () => {
  const k = lab();
  const baseline = k.file(`watch-kube-${CONTEXT}.json`);
  const args = (url: string) => ["watch", "--kube", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", url];
  await withHook(async (refusing) => {
    const run = await k.run(args(refusing.url));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Could not send the message: .* answered 404 \(no_service\)\. It will be sent again next round\./);
    assert.equal(existsSync(baseline), false);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET));
  }, 404);
  await withHook(async (server) => {
    const run = await k.run(args(server.url));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(events(server), ["first-report"]);
  });
});

test("watch: a cluster that cannot be reached is said on stderr and by message, and the run ends non-zero without a baseline", async () => {
  const k = lab();
  await withHook(async (server) => {
    const run = await k.run(["watch", "--kube", "--every", "1h", "--max-runs", "1", "--lookback-hours", "1", "--notify", server.url], { KUBE_BROKEN: "1" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^\S+ {2}The check failed: .*Unable to connect to the server/m);
    assert.deepEqual(events(server), ["check-failed"]);
    assert.match(bodies(server)[0].text, /This is said once\. CloudPilot keeps trying and will say so when checking works again\./);
    assert.equal(existsSync(k.file(`watch-kube-${CONTEXT}.json`)), false);
  });
});

test("watch on the account, from a recording: the first report goes out once and nothing is saved", async () => {
  await withHook(async (server) => {
    const run = await cliAsync(["watch", "--replay", FIXTURE, "--max-runs", "1", "--notify", server.url]).done;
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(events(server), ["first-report"]);
    assert.match(run.stderr, /^Watching the AWS account every 6h, read-only\./m);
    assert.equal(existsSync(join(run.cwd, ".cloudpilot")), false, "a replay is a recording, not the account, so it leaves no baseline");
    assert.ok(!(run.stdout + run.stderr + everything(run.cwd)).includes(SECRET));
  });
});

test("watch on the account, from a recording, with a baseline that has one finding fewer", async () => {
  const earlier = JSON.parse(cli(["scan", "--replay", FIXTURE, "--json"], { blockNetwork: true }).stdout);
  const [added, ...rest] = earlier.findings;
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-notify-"));
  mkdirSync(join(cwd, ".cloudpilot"));
  writeFileSync(join(cwd, ".cloudpilot/watch-baseline.json"), JSON.stringify({ ...earlier, scannedAt: "2026-10-01T00:00:00Z", findings: rest }));
  await withHook(async (server) => {
    const run = await cliAsync(["watch", "--replay", FIXTURE, "--max-runs", "1", "--notify", server.url], { cwd }).done;
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(events(server), ["new-findings"]);
    assert.deepEqual(bodies(server)[0].findings.map((f: { resourceIds: string[] }) => f.resourceIds), [added.resourceIds]);
    assert.match(run.stdout, /Showing only the 1 new finding\./);
  });
});

test("watch with no --notify prints and sends nothing", async () => {
  const run = await cliAsync(["watch", "--replay", FIXTURE, "--max-runs", "1"], { blockNetwork: true }).done;
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /No --notify target: results are printed here only\./);
  assert.match(run.stdout, /10 findings, \$151\.53 per month/);
});

test("Ctrl+C ends a watch cleanly, between rounds", async () => {
  const run = cliAsync(["watch", "--replay", FIXTURE]);
  const started = Date.now();
  while (!run.output().stdout.includes("CloudPilot is read-only")) {
    assert.ok(Date.now() - started < 30_000, "the first round finished");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The first round is done and the next is six hours away.
  run.child.kill("SIGINT");
  const end = await run.done;
  assert.equal(end.status, 0, end.stderr);
  assert.doesNotMatch(end.stderr, /Error|at .*\.ts:\d+/);
});

test("Ctrl+C ends a watch cleanly, in the middle of a round", async () => {
  // A kubectl that never answers: the round is in flight when the signal comes.
  const k = lab();
  writeFileSync(
    join(dirname(k.cwd), "bin/kubectl"),
    `#!/usr/bin/env node\nif (process.argv.includes("config")) process.stdout.write(JSON.stringify({ contexts: [{ name: "stuck" }], clusters: [{ cluster: { server: "https://stuck.invalid" } }] }));\nelse setTimeout(() => {}, 15000);\n`,
  );
  const run = cliAsync(["watch", "--kube", "--every", "1h"], { cwd: k.cwd, env: k.env() });
  const started = Date.now();
  while (!run.output().stderr.includes("Reading cluster stuck")) {
    assert.ok(Date.now() - started < 30_000, "the round began");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  run.child.kill("SIGINT");
  const end = await run.done;
  assert.equal(end.status, 0, end.stderr);
  assert.doesNotMatch(end.stderr, /The check failed/);
});

test("watch refuses an interval that is abusive or meaningless, and options that belong to the other thing it can watch", () => {
  const refuse = (args: string[], message: RegExp) => {
    const run = cli(["watch", "--replay", FIXTURE, ...args], { blockNetwork: true });
    assert.equal(run.status, 1, args.join(" "));
    assert.match(run.stderr, message);
    assert.equal(run.stdout, "", "nothing was scanned");
  };
  refuse(["--every", "5m"], /--every must be at least 15m/);
  refuse(["--every", "10"], /--every takes a number and a unit/);
  refuse(["--every", "30d"], /--every must be 7d or less/);
  refuse(["--max-runs", "0"], /--max-runs takes a whole number of one or more/);
  refuse(["--context", "prod"], /--context only applies with --kube\./);
  const kube = cli(["watch", "--kube", "--region", "ap-south-1"], { blockNetwork: true });
  assert.equal(kube.status, 1);
  assert.match(kube.stderr, /--region only applies to the AWS account, not with --kube\./);
  const notify = cli(["watch", "--replay", FIXTURE, "--notify", `http://hooks.example.com/${SECRET}`], { blockNetwork: true });
  assert.equal(notify.status, 1);
  assert.ok(!notify.stderr.includes(SECRET));
});
