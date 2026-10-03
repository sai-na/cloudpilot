import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Run the CLI in an empty directory (or the one given) with no credentials of
 * any kind: no model keys, no AWS profile, no .env. Optionally with every
 * socket blocked.
 */
export function cli(args: string[], options: { blockNetwork?: boolean; env?: Record<string, string>; cwd?: string } = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "cloudpilot-test-"));
  const run = spawnSync(
    process.execPath,
    [...(options.blockNetwork ? ["--require", BLOCK_NETWORK] : []), "--import", TSX, CLI, ...args],
    {
      cwd,
      encoding: "utf8",
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
    },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, cwd };
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
