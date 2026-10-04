import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Run the CLI to its end without blocking the test's own event loop, so a stand-in server in this process can answer it. */
export function cliRun(args: string[], options: CliOptions = {}) {
  const { child, done } = cliAsync(args, options);
  return new Promise<Awaited<typeof done>>((resolve, reject) => {
    child.on("error", reject);
    void done.then(resolve);
  });
}

/**
 * A stand-in for OpenAI's Responses endpoint. `outputs` is what each request
 * is answered with, in turn; every request is kept. `env` points a process
 * under test at it, with a key that is good for nothing else.
 */
export async function fakeOpenAI(outputs: object[][]) {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `resp_${requests.length}`, object: "response", status: "completed", model: "test", output: outputs[requests.length - 1] ?? [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    env: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, NO_PROXY: "127.0.0.1" },
    close: () => server.close(),
  };
}

/** What a model that writes this text answers with. */
export const says = (text: string) => [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
/** What a model that asks for these lookups answers with. */
export const looksUp = (...names: string[]) => names.map((name, i) => ({ type: "function_call", id: `fc_${i}`, call_id: `c${i}`, name, arguments: "{}", status: "completed" }));

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
// Where a test asks, keep the environment this was started with: what the scanner hands to a program it starts.
if (process.env.KUBE_ENV_LOG) fs.appendFileSync(process.env.KUBE_ENV_LOG, JSON.stringify(process.env) + "\\n");
const rest = args[0] === "--context" ? args.slice(2) : args;
// KUBE_NO_KUBECONFIG: kubectl with no kubeconfig at all, as in a pod. It has no context to name, and none to be told to use.
// What makes it a pod is the environment KUBERNETES_SERVICE_HOST sets up, which the test passes in; the reads then go through the pod's service account.
if (process.env.KUBE_NO_KUBECONFIG && args[0] === "--context") {
  process.stderr.write("error: cannot locate context " + args[1]);
  process.exitCode = 1;
} else if (process.env.KUBE_NO_KUBECONFIG && rest.join(" ") === "config view --minify -o json") {
  process.stderr.write("error: current-context must exist in order to minify");
  process.exitCode = 1;
} else if (rest.join(" ") === "config view --minify -o json") {
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
 * the process under test, or `pod` to have it behave as it does inside a cluster.
 */
export function fakeKubectl(fixture: string) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpilot-kubectl-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "kubectl"), KUBECTL_STAND_IN);
  chmodSync(join(bin, "kubectl"), 0o755);
  const log = join(dir, "kubectl.log");
  const env = { PATH: `${bin}:${dirname(process.execPath)}`, KUBE_FIXTURE: fixture, KUBE_LOG: log };
  return {
    env,
    /** What a process in a pod sees: no kubeconfig, and the variables the kubelet sets so that kubectl finds the API server. */
    pod: { ...env, KUBE_NO_KUBECONFIG: "1", KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
    /** Whether kubectl was started at all. `calls` fails when it was not. */
    started: () => existsSync(log),
    calls: (): string[][] => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}
