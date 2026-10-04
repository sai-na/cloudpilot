/**
 * The audit log: one JSON line for every fix that was run, failed, was
 * declined, refused or (for autopilot) held back. `apply` and the watch's
 * autopilot write it; `audit` reads it; autopilot also reads it to know which
 * resources it has already tried.
 */
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApplyError, isAuditEntry, type AuditEntry } from "./apply.js";

export const AUDIT_LOG = ".cloudpilot/audit.jsonl";

/** The audit log, losing only the lines that cannot be read rather than the whole record. */
export async function readAudit(path = AUDIT_LOG): Promise<{ entries: AuditEntry[]; unreadable: number }> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw new ApplyError(`${path} is there but could not be read (${err.code ?? err.message}). That file is the record of what apply has run, so this is not an empty record.`);
  });
  const entries: AuditEntry[] = [];
  let unreadable = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (isAuditEntry(parsed)) entries.push(parsed);
    else unreadable++;
  }
  return { entries, unreadable };
}

/**
 * Every entry, or a throw when any line of the log cannot be read. For autopilot's
 * never-twice gate: a line that is skipped is a fix that looks as if it was never
 * tried, so a damaged log must stop it rather than let a resource be fixed again.
 */
export async function readAuditWhole(path = AUDIT_LOG): Promise<AuditEntry[]> {
  const { entries, unreadable } = await readAudit(path);
  if (unreadable > 0) {
    throw new ApplyError(
      `${path} has ${unreadable} line${unreadable === 1 ? "" : "s"} that cannot be read, so what was tried before is not known. Repair or remove ${unreadable === 1 ? "it" : "them"}. Apply by hand is not affected.`,
    );
  }
  return entries;
}

export async function appendAudit(entry: AuditEntry, path = AUDIT_LOG): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

/** Throws unless a line could be added to the log: checked before anything is run, so no fix runs that cannot be recorded. */
export async function checkAuditWritable(path = AUDIT_LOG): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await (await open(path, "a")).close();
}
