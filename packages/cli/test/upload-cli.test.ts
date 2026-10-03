/**
 * `--upload` as a person runs it: the real command, a stand-in kubectl serving
 * the recorded cluster (a live scan as far as the CLI knows), a stand-in for
 * AWS that a live scan reads through AWS_ENDPOINT_URL, and the hosted service
 * as a server on 127.0.0.1. Nothing leaves the machine.
 *
 * A replay cannot be the account's scan, since --upload refuses it, so the
 * account is scanned live against the stand-in for AWS, with prices from the
 * saved table.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, cliRun, FIXTURE, fakeKubectl, recordingText } from "./helpers.js";
import { assertTakenByHostedService, fakeAws, hosted, stored, TOKEN, type Answer, type Hosted } from "./hosted.js";

const here = dirname(fileURLToPath(import.meta.url));
const KUBE_FIXTURE = resolve(here, "fixtures/kube-lab.json");
const PRICES = resolve(here, "../../../pricing/ap-south-1.json");
const VARIABLE = "CLOUDPILOT_UPLOAD_TOKEN";

/** Every file under a directory, as one string: where a secret would show if anything had saved it. */
const everything = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");

/** Nothing the run printed or left behind holds the token. */
function assertTokenNowhere(run: { stdout: string; stderr: string; cwd: string }, ...more: string[]) {
  for (const text of [run.stdout, run.stderr, everything(run.cwd), ...more]) assert.ok(!text.includes(TOKEN), "the token appears in output or in a file");
}

async function withHosted(respond: (n: number) => Answer, body: (server: Hosted) => Promise<void>) {
  const server = await hosted((_, n) => respond(n));
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

const withToken = (extra: Record<string, string> = {}) => ({ [VARIABLE]: TOKEN, ...extra });

/** A live scan of the recorded cluster, with the token in the environment. */
function kube(args: string[], extra: Record<string, string> = {}, cwd?: string) {
  const kubectl = fakeKubectl(KUBE_FIXTURE);
  return { kubectl, done: cliRun(["kube", ...args], { cwd, env: withToken({ ...kubectl.env, ...extra }) }) };
}

const ACCOUNT = ["scan", "--region", "ap-south-1", "--offline", "--price-file", PRICES];

// What is sent

test("kube --upload posts exactly what --json prints, with the token as a bearer token, and says how it went", async () => {
  await withHosted(() => stored(), async (server) => {
    const run = await kube(["--json", "--upload", server.url]).done;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(server.requests.length, 1);
    const [request] = server.requests;
    assert.equal(request!.method, "POST");
    assert.equal(request!.path, "/api/ingest");
    assert.equal(request!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request!.headers["content-type"], "application/json");
    const printed = JSON.parse(run.stdout);
    assert.deepEqual(JSON.parse(request!.body), printed, "the body is the result --json prints, summary included");
    assert.ok(printed.cluster && printed.findings.length > 0);
    assertTakenByHostedService(JSON.parse(request!.body));
    assert.match(run.stderr, /^Uploaded the scan to 127\.0\.0\.1:\d+: stored \(10 new, 0 came back, 0 resolved, 0 unchanged\)\.$/m);
    assertTokenNowhere(run);
  });
});

test("scan --upload posts the account's scan, read live, exactly as --json prints it", async () => {
  const aws = await fakeAws();
  try {
    await withHosted(() => stored(), async (server) => {
      const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-upload-"));
      const run = await cliRun([...ACCOUNT, "--json", "--record", "rec", "--out", "report.md", "--html", "report.html", "--upload", server.url], { cwd, env: withToken(aws.env) });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
      const printed = JSON.parse(run.stdout);
      assert.deepEqual(JSON.parse(server.requests[0]!.body), printed);
      assert.equal(printed.accountId, "123456789012");
      assert.equal(printed.findings.length, 2, "the two unattached volumes");
      assertTakenByHostedService(printed);
      assert.match(run.stderr, /^Uploaded the scan to 127\.0\.0\.1:\d+: stored/m);
      // Only reads reached AWS, and nothing but the one POST went anywhere else.
      for (const action of aws.actions) assert.match(action, /^(Describe|Get)[A-Z]/);
      // The token is in no report, no saved scan and no recording.
      assertTokenNowhere(run, recordingText(join(cwd, "rec")));
      assert.ok(existsSync(join(cwd, "rec", "manifest.json")) && existsSync(join(cwd, ".cloudpilot", "last-scan.json")), "the files the run leaves behind exist, and were searched");
    });
  } finally {
    await aws.close();
  }
});

test("every run uploads, and what is uploaded is the whole result even when --only-new shows none of it", async () => {
  await withHosted(() => stored(), async (server) => {
    const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-upload-"));
    const first = await kube(["--upload", server.url], {}, cwd).done;
    assert.equal(first.status, 0, first.stderr);
    const second = await kube(["--only-new", "--upload", server.url], {}, cwd).done;
    assert.equal(second.status, 0, second.stderr);
    assert.equal(server.requests.length, 2, "a run with nothing new is uploaded too: the service works out what is new from the sequence");
    const [one, two] = server.requests.map((r) => JSON.parse(r.body));
    assert.equal(one.findings.length, two.findings.length, "all findings, not only the new ones");
    assert.equal(two.comparison.newCount, 0);
    assert.equal(two.comparison.unchangedCount, two.findings.length);
    assert.match(second.stdout, /^Nothing new since the last scan; the 2 findings already reported are not listed\.$/m, "the report itself showed nothing new");
    assert.notEqual(one.scannedAt, two.scannedAt);
    assertTokenNowhere(second);
  });
});

test("the cluster scan's kubectl is never handed the token", async () => {
  await withHosted(() => stored(), async (server) => {
    const log = join(mkdtempSync(join(tmpdir(), "cloudpilot-upload-")), "env.log");
    const run = await kube(["--upload", server.url], { KUBE_ENV_LOG: log }).done;
    assert.equal(run.status, 0, run.stderr);
    const seen = readFileSync(log, "utf8");
    assert.ok(seen.trim().length > 0, "kubectl ran, and its environment was kept");
    assert.ok(!seen.includes(TOKEN) && !seen.includes(VARIABLE), "the token was kept from the programs the scan starts");
    assert.equal(server.requests.length, 1, "and it was still there to upload with");
  });
});

// What the hosted service answers

const answers: Array<[string, Answer, number, RegExp]> = [
  ["201 stored", stored(), 0, /^Uploaded the scan to 127\.0\.0\.1:\d+: stored \(10 new/m],
  ["200 this exact scan was already stored", { status: 200, body: { duplicate: true } }, 0, /^Uploaded the scan to 127\.0\.0\.1:\d+: this exact scan was already stored, so nothing changed\.$/m],
  [
    "401 token not accepted",
    { status: 401, body: { error: "This upload token is not valid." } },
    1,
    /^Could not upload the scan to 127\.0\.0\.1:\d+: the token in CLOUDPILOT_UPLOAD_TOKEN was not accepted\. It is wrong or has been revoked: make a new one in the hosted service's settings and set the variable again\.$/m,
  ],
  [
    "409 older than the latest stored",
    { status: 409, body: { error: "This scan was taken at an earlier time." } },
    1,
    /^Could not upload the scan to 127\.0\.0\.1:\d+: a later scan of this account or cluster is already stored, so this older one was refused\. Check the clock of this machine: a scan taken after the stored one is accepted\.$/m,
  ],
  [
    "413 too large",
    { status: 413, body: { error: "The body is larger than 5 MB." } },
    1,
    /^Could not upload the scan to 127\.0\.0\.1:\d+: the scan is larger than the service accepts\. Scan a smaller part at a time, with --region or --namespace\.$/m,
  ],
  [
    "422 not a scan result",
    { status: 422, body: { error: "This is not a CloudPilot scan result.", problems: [{ path: "findings.0.pattern", message: "must be a rule name such as unattached-ebs-volume" }] } },
    1,
    /^Could not upload the scan to 127\.0\.0\.1:\d+: the service does not take this as a scan result \(findings\.0\.pattern: must be a rule name such as unattached-ebs-volume\)\. CloudPilot and the service disagree about that field: update CloudPilot, and report it if it still happens\.$/m,
  ],
  [
    "a redirect",
    { status: 301, headers: { location: "https://elsewhere.example.com/api/ingest" } },
    1,
    /^Could not upload the scan to 127\.0\.0\.1:\d+: it answered 301, a redirect, which CloudPilot does not follow because the token would go with it\. Give the address it redirects to as --upload\.$/m,
  ],
];

for (const [name, answer, status, line] of answers) {
  test(`${name}: one line on stderr, the report still printed, exit ${status}`, async () => {
    await withHosted(() => answer, async (server) => {
      const run = await kube(["--upload", server.url]).done;
      assert.equal(run.status, status, run.stderr);
      assert.equal(server.requests.length, 1, "an answer that says what is wrong is not sent again");
      assert.match(run.stderr, line);
      // The report is there, whatever became of the upload.
      assert.match(run.stdout, /2 findings, \$0\.60 per month of estimated waste/);
      assert.match(run.stdout, /Summary/);
      assert.equal(run.stderr.split("\n").filter((l) => /upload/i.test(l)).length, 1, "said once");
      assertTokenNowhere(run);
    });
  });
}

test("a server error is tried once more, and when it clears the scan is stored and the exit code is 0", async () => {
  await withHosted((n) => (n === 1 ? { status: 503, body: "busy" } : stored()), async (server) => {
    const run = await kube(["--upload", server.url]).done;
    assert.equal(run.status, 0, run.stderr);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0]!.body, server.requests[1]!.body);
    assert.match(run.stderr, /^Uploaded the scan to 127\.0\.0\.1:\d+: stored/m);
  });
});

test("a server that keeps failing is tried once more and no more, and the exit code says so", async () => {
  await withHosted(() => ({ status: 500, body: "boom" }), async (server) => {
    const run = await kube(["--upload", server.url]).done;
    assert.equal(run.status, 1);
    assert.equal(server.requests.length, 2, "one retry at most");
    assert.match(run.stderr, /^Could not upload the scan to 127\.0\.0\.1:\d+: it answered 500\. The service is failing: try again later\.$/m);
    assert.match(run.stdout, /2 findings, \$0\.60 per month of estimated waste/);
  });
});

test("a service that cannot be reached is said with its host, and the report is still printed", async () => {
  const gone = await hosted(() => ({ status: 200 }));
  const url = gone.url;
  await gone.close();
  const run = await kube(["--upload", url]).done;
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^Could not upload the scan to 127\.0\.0\.1:\d+: could not reach 127\.0\.0\.1:\d+ \(fetch failed: connect ECONNREFUSED .*\)\. Check the address and the network\.$/m);
  assert.match(run.stdout, /2 findings, \$0\.60 per month of estimated waste/);
  assertTokenNowhere(run);
});

test("whatever the service echoes back, the token is not in anything the run printed or saved", async () => {
  const echo = (request: { headers: Record<string, unknown> }) => `${request.headers.authorization} ${"x".repeat(3000)}`;
  const server = await hosted((request) => ({ status: 422, body: { error: echo(request), problems: [{ path: `findings.${request.headers.authorization}`, message: echo(request) }] } }));
  const bad = await hosted((request) => ({ status: 418, body: echo(request) }));
  try {
    const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-upload-"));
    for (const target of [server, bad]) {
      const run = await kube(["--out", "report.md", "--html", "report.html", "--record", "rec", "--upload", target.url], {}, cwd).done;
      assert.equal(run.status, 1);
      assert.ok(run.stderr.length < 2000, "a long answer is not dumped");
      assert.match(run.stderr, target === server ? /\(findings\.Bearer \[token\]: Bearer \[token\] x+…\)/ : /it answered 418/);
      assertTokenNowhere(run, recordingText(join(cwd, "rec")));
    }
    assert.ok(readdirSync(cwd).includes("report.md"));
  } finally {
    await server.close();
    await bad.close();
  }
});

// What is refused, and when

const URL_ = "https://hosted.example.com/api/ingest";

/** A run that must stop before anything is read: no network, nothing printed but the reason. */
function refused(args: string[], message: string, env: Record<string, string> = withToken()) {
  const run = cli(args, { blockNetwork: true, env });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, `cloudpilot: ${message}\n`, "the reason, and nothing was read before it");
  assert.equal(run.stdout, "");
  assertTokenNowhere(run);
}

const REPLAY = "--upload cannot be used with --replay: a recording is not the account as it is now, and uploading it would put old findings into the hosted history as if they were current.";
const REDACT = "--upload cannot be used with --redact-account: the stand-in account ID is the same for every account, so the hosted history would merge different accounts into one.";
const ANSWER_KEY = "--upload cannot be used with --answer-key: that run scores a lab against its answer key and keeps no scan, and a lab is not a cluster whose history is worth keeping.";

test("--upload is refused with --replay, on every command that has one, and says why", () => {
  refused(["scan", "--replay", FIXTURE, "--upload", URL_], REPLAY);
  refused(["kube", "--replay", FIXTURE, "--upload", URL_], REPLAY);
  refused(["watch", "--replay", FIXTURE, "--upload", URL_], REPLAY);
});

test("--upload is refused with --redact-account, and says why", () => {
  refused(["scan", "--redact-account", "--upload", URL_], REDACT);
  refused(["watch", "--redact-account", "--upload", URL_], REDACT);
});

test("--upload is refused with kube --answer-key, and says why", () => {
  refused(["kube", "--answer-key", "key.json", "--upload", URL_], ANSWER_KEY);
});

test("--upload with no token stops the run before anything is read, so a typo costs no scan", () => {
  const message = `--upload needs the upload token in the environment variable ${VARIABLE}. It is never taken from a command-line flag, because a flag ends up in shell history and in the process list.`;
  for (const command of [["scan"], ["kube"], ["watch", "--max-runs", "1"], ["watch", "--kube", "--max-runs", "1"]]) {
    refused([...command, "--upload", URL_], message, {});
    refused([...command, "--upload", URL_], message, { [VARIABLE]: "  " });
  }
});

test("an address that is not https, not a URL or carries a password is refused, naming only its host", () => {
  refused(["scan", "--upload", "http://hosted.example.com/api/ingest"], "The --upload URL (hosted.example.com) is not an https URL. The upload token goes with every request and must not travel unencrypted.");
  refused(["kube", "--upload", "https://alice:hunter2@hosted.example.com/api/ingest"], `The --upload URL (hosted.example.com) has a user name or password in it. The token goes in ${VARIABLE}, not in the URL.`);
  refused(["scan", "--upload", `nonsense ${TOKEN}`], "The --upload URL is not a URL. (It is not shown, in case it carries a secret.)");
});

test("the token is never a flag: there is none, and what was typed after one is not echoed back", () => {
  const run = cli(["scan", "--upload", URL_, "--upload-token", TOKEN], { blockNetwork: true, env: withToken() });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown option '--upload-token'/);
  assert.equal(run.stdout, "");
  assert.ok(!run.stderr.includes(TOKEN));
  for (const command of ["scan", "kube", "watch"]) {
    const help = cli([command, "--help"]).stdout.replace(/\s+/g, " ");
    assert.match(help, /--upload <url>/);
    assert.match(help, /read only from CLOUDPILOT_UPLOAD_TOKEN, never from a flag, because a flag ends up in shell history and in the process list/);
  }
});

test("a scan that cannot be made uploads nothing", async () => {
  await withHosted(() => stored(), async (server) => {
    const run = await kube(["--lookback-hours", "0", "--upload", server.url]).done;
    assert.equal(run.status, 1);
    assert.equal(server.requests.length, 0);
    assert.match(run.stderr, /--lookback-hours must be more than zero/);
  });
});

// watch

test("watch --kube uploads each round that completed, says so, and the token is nowhere", async () => {
  await withHosted(() => stored(), async (server) => {
    const kubectl = fakeKubectl(KUBE_FIXTURE);
    const watched = await cliRun(["watch", "--kube", "--max-runs", "1", "--upload", server.url], { env: withToken(kubectl.env) });
    assert.equal(watched.status, 0, watched.stderr);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(server.requests[0]!.body);
    assert.ok(body.cluster && body.findings.length > 0 && typeof body.summary === "string");
    assertTakenByHostedService(body);
    assert.match(watched.stderr, /Watching cluster kind-cloudpilot-lab every 6h, read-only\. No --notify target: results are printed here only\. Every round is uploaded to 127\.0\.0\.1:\d+\. Ctrl\+C stops it\./);
    assert.match(watched.stdout, /^Uploaded the scan to 127\.0\.0\.1:\d+: stored/m);
    assertTokenNowhere(watched);
  });
});

test("watch on the account uploads the round it scanned live", async () => {
  const aws = await fakeAws();
  try {
    await withHosted(() => stored(), async (server) => {
      const run = await cliRun(["watch", "--region", "ap-south-1", "--offline", "--price-file", PRICES, "--max-runs", "1", "--upload", server.url], { env: withToken(aws.env) });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(server.requests.length, 1);
      const body = JSON.parse(server.requests[0]!.body);
      assert.equal(body.accountId, "123456789012");
      assertTakenByHostedService(body);
      assertTokenNowhere(run);
    });
  } finally {
    await aws.close();
  }
});

test("watch says a failing upload on stderr, still prints the round, and ends non-zero", async () => {
  await withHosted(() => ({ status: 401, body: { error: "This upload token is not valid." } }), async (server) => {
    const kubectl = fakeKubectl(KUBE_FIXTURE);
    const watched = await cliRun(["watch", "--kube", "--max-runs", "1", "--upload", server.url], { env: withToken(kubectl.env) });
    assert.equal(watched.status, 1);
    assert.equal(server.requests.length, 1);
    assert.equal(watched.stderr.match(/Could not upload the scan to/g)?.length, 1);
    assert.match(watched.stdout, /2 findings, \$0\.60 per month of estimated waste/);
    assertTokenNowhere(watched);
  });
});

test("the file names are not a way to learn the token: a saved scan holds the scan and nothing about the upload", async () => {
  await withHosted(() => stored(), async (server) => {
    const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-upload-"));
    mkdirSync(join(cwd, ".cloudpilot"), { recursive: true });
    const run = await kube(["--upload", server.url], {}, cwd).done;
    assert.equal(run.status, 0, run.stderr);
    const saved = readdirSync(join(cwd, ".cloudpilot")).map((f) => readFileSync(join(cwd, ".cloudpilot", f), "utf8")).join("\n");
    assert.ok(saved.length > 0);
    assert.ok(!saved.includes(TOKEN) && !saved.includes(server.host), "no token and no address in the saved scan");
  });
});
