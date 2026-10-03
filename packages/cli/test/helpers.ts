import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(here, "../src/index.ts");
export const FIXTURE = resolve(here, "fixtures/lab");
const BLOCK_NETWORK = resolve(here, "block-network.cjs");
/** The TypeScript loader by absolute URL, so the CLI can run from any directory. */
export const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

type CliOptions = { blockNetwork?: boolean; env?: Record<string, string>; cwd?: string };

/** The command line and environment shared by every way of running the CLI: no credentials of any kind. */
function invocation(args: string[], options: CliOptions) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "cloudpilot-test-"));
  return {
    cwd,
    command: [...(options.blockNetwork ? ["--require", BLOCK_NETWORK] : []), "--import", TSX, CLI, ...args],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NO_COLOR: "1",
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_EC2_METADATA_DISABLED: "true",
      // An unreachable proxy, in case anything honours it.
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ...options.env,
    },
  };
}

/**
 * Run the CLI in an empty directory (or the one given) with no credentials of
 * any kind: no model keys, no AWS profile, no .env. Optionally with every
 * socket blocked.
 */
export function cli(args: string[], options: CliOptions = {}) {
  const { cwd, command, env } = invocation(args, options);
  const run = spawnSync(process.execPath, command, { cwd, encoding: "utf8", env });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, cwd };
}

/**
 * The same, without blocking this process: for a test that serves something
 * on 127.0.0.1 for the CLI to talk to, or that has to signal a running one.
 */
export function cliAsync(args: string[], options: CliOptions = {}) {
  const { cwd, command, env } = invocation(args, options);
  const child: ChildProcess = spawn(process.execPath, command, { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<{ status: number | null; stdout: string; stderr: string; cwd: string }>((resolve) =>
    child.on("close", (status) => resolve({ status, stdout, stderr, cwd })),
  );
  return { child, cwd, done, output: () => ({ stdout, stderr }) };
}

/** Every file of a recording as text, with stored response bodies decoded from base64. */
export function recordingText(dir: string): string {
  const parts: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const raw = readFileSync(join(entry.parentPath, entry.name), "utf8");
    parts.push(raw);
    if (entry.name === "aws.json") {
      for (const responses of Object.values<Array<{ body: string }>>(JSON.parse(raw).entries)) {
        for (const response of responses) parts.push(Buffer.from(response.body, "base64").toString("latin1"));
      }
    }
  }
  return parts.join("\n");
}

export const SECRET_MARKERS = ["AKIA", "ASIA", "x-amz-security-token", "Authorization", "sk-ant"];

const KUBECTL_STAND_IN = `#!/usr/bin/env node
// Serves the recorded lab. Anything but a GET of a known path, or reading the local config, is refused.
// Output is left to drain by itself: exiting straight after a large write would cut it short.
const fs = require("fs");
const fixture = JSON.parse(fs.readFileSync(process.env.KUBE_FIXTURE, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.KUBE_LOG, JSON.stringify(args) + "\\n");
const rest = args[0] === "--context" ? args.slice(2) : args;
if (rest.join(" ") === "config view --minify -o json") {
  process.stdout.write(JSON.stringify({ contexts: [{ name: fixture.identity.context }], clusters: [{ cluster: { server: fixture.identity.server } }] }));
} else if (rest.length === 3 && rest[0] === "get" && rest[1] === "--raw" && rest[2] in fixture.responses) {
  process.stdout.write(JSON.stringify(fixture.responses[rest[2]]));
} else if (rest.length === 3 && rest[0] === "get" && rest[1] === "--raw") {
  process.stderr.write("Error from server (NotFound): " + rest[2]);
  process.exitCode = 1;
} else {
  process.stderr.write("the scanner called something it should not: kubectl " + args.join(" "));
  process.exitCode = 2;
}
`;

/**
 * A kubectl that serves a recorded cluster (see test/kube-lab/record-fixture.ts)
 * and keeps a log of everything it was asked. Put `env` in the environment of
 * the process under test.
 */
export function fakeKubectl(fixture: string) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-kubectl-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "kubectl"), KUBECTL_STAND_IN);
  chmodSync(join(bin, "kubectl"), 0o755);
  const log = join(dir, "kubectl.log");
  return {
    env: { PATH: `${bin}:${dirname(process.execPath)}`, KUBE_FIXTURE: fixture, KUBE_LOG: log },
    calls: (): string[][] => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}
