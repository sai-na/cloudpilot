import { existsSync, readFileSync } from "node:fs";

/**
 * Load KEY=VALUE lines from a .env file into the environment, without
 * overriding anything already set. A small stand-in for process.loadEnvFile,
 * which Node 18 does not have.
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string];
    const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
