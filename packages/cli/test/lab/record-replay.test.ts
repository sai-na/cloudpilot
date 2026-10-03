/**
 * Live tests: they need the waste lab and the cloudpilot-readonly AWS profile.
 * Run with `npm run test:lab`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cli, CLI, recordingText, SECRET_MARKERS, TSX } from "../helpers.js";

const PROFILE = "cloudpilot-readonly";
const REGION = "ap-south-1";

/** Run the CLI live, with the developer's own environment and AWS config. */
function live(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const run = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    encoding: "utf8",
    cwd: mkdtempSync(join(tmpdir(), "cloudpilot-test-")),
    env: { ...env, NO_COLOR: "1" },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Record, replay with the network blocked, and return both results. */
function recordThenReplay(dir: string, scope: string[]) {
  const record = live(["scan", "--profile", PROFILE, ...scope, "--json", "--record", dir]);
  assert.equal(record.status, 0, record.stderr);
  const replay = cli(["scan", "--replay", dir, "--json"], { blockNetwork: true });
  assert.equal(replay.status, 0, replay.stderr);
  const recorded = JSON.parse(record.stdout);
  const replayed = JSON.parse(replay.stdout);
  const banner: string = replayed.replay;
  delete replayed.replay;
  return { recorded, replayed, banner };
}

const single = join(mkdtempSync(join(tmpdir(), "cloudpilot-recording-")), "one-region");

test("record a scan of the lab region, then replay it byte-identically with the network blocked", () => {
  const { recorded, replayed, banner } = recordThenReplay(single, ["--region", REGION]);
  assert.ok(recorded.findings.length > 0);
  assert.equal(JSON.stringify(replayed.findings), JSON.stringify(recorded.findings));
  assert.equal(JSON.stringify(replayed), JSON.stringify(recorded));
  assert.match(banner, /region ap-south-1\. No live calls\.$/);
});

test("the fresh recording holds no credentials, signatures or tokens", () => {
  const text = recordingText(single);
  for (const marker of SECRET_MARKERS) assert.ok(!text.includes(marker), `recording contains ${marker}`);
});

test("with no --region every enabled region is scanned, and that replays byte-identically too", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cloudpilot-recording-")), "all-regions");
  const { recorded, replayed, banner } = recordThenReplay(dir, []);
  assert.ok(recorded.regions.length > 1, "more than one region scanned");
  assert.ok(recorded.regions.includes(REGION));
  assert.ok(recorded.findings.every((f: { region: string }) => recorded.regions.includes(f.region)));
  assert.equal(JSON.stringify(replayed), JSON.stringify(recorded));
  assert.match(banner, new RegExp(`${recorded.regions.length} regions\\. No live calls\\.$`));
  for (const marker of SECRET_MARKERS) assert.ok(!recordingText(dir).includes(marker), `recording contains ${marker}`);
});

test("with no --profile the standard credential chain is used, as in CloudShell", () => {
  // Temporary credentials for the read-only role, handed over the way CloudShell does: through the environment.
  const [key, secret, token] = execFileSync(
    "aws",
    ["sts", "assume-role", "--profile", "cloudpilot-seed", "--role-arn", roleArn(), "--role-session-name", "cloudpilot-test",
      "--duration-seconds", "900", "--query", "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]", "--output", "text"],
    { encoding: "utf8" },
  ).trim().split(/\s+/);
  const run = live(["scan", "--region", REGION, "--json"], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_ACCESS_KEY_ID: key,
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_SESSION_TOKEN: token,
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.ok(result.findings.length > 0);
  // No model key in that environment: the scan still completes, with the templated summary.
  assert.match(result.summary, /^Estimated waste: \$/);
});

test("a second scan from the same directory says by itself that nothing has changed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cloudpilot-test-"));
  const run = () =>
    spawnSync(process.execPath, ["--import", TSX, CLI, "scan", "--profile", PROFILE, "--region", REGION], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /since the last scan/i);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Nothing has changed since the last scan \(\S+\)\./);
});

function roleArn(): string {
  const account = execFileSync("aws", ["sts", "get-caller-identity", "--profile", "cloudpilot-seed", "--query", "Account", "--output", "text"], { encoding: "utf8" }).trim();
  return `arn:aws:iam::${account}:role/cloudpilot-readonly`;
}

test("the MCP server scans the live account when a client asks", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "cloudpilot-lab-test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", TSX, CLI, "mcp", "--profile", PROFILE],
      cwd: mkdtempSync(join(tmpdir(), "cloudpilot-mcp-")),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stderr: "ignore",
    }),
  );
  try {
    const scan = await client.callTool({ name: "scan", arguments: { region: REGION } });
    const body = (scan.content as Array<{ text: string }>)[0]!.text;
    assert.equal(scan.isError, false, body);
    assert.match(body, /^Estimated waste: \$\d+\.\d\d per month/);
    assert.doesNotMatch(body, /REPLAY MODE/);

    const cpu = await client.callTool({ name: "get_cpu_history", arguments: { instance_id: /"(i-[0-9a-f]+)"/.exec(body)![1], hours: 6 } });
    assert.equal(cpu.isError, false);
    assert.match((cpu.content as Array<{ text: string }>)[0]!.text, /"averagePct":/);
  } finally {
    await client.close();
  }
});
