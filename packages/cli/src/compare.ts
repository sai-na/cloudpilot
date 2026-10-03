/**
 * What changed between two scans, so a repeat scan can say "two new, one
 * resolved" instead of making the reader go through every finding again.
 */
import type { Comparison, Finding, ScanResult } from "./types.js";

const keyOf = (f: Finding) => `${f.pattern}|${f.region}|${[...f.resourceIds].sort().join(",")}`;

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** True when a parsed finding carries every field a comparison and its report need. */
function isComparableFinding(value: unknown): value is Finding {
  const f = value as Partial<Finding> | null;
  return Boolean(
    f &&
      typeof f.pattern === "string" &&
      typeof f.region === "string" &&
      typeof f.title === "string" &&
      isStringList(f.resourceIds) &&
      typeof f.monthlyCostUsd === "number" &&
      Number.isFinite(f.monthlyCostUsd),
  );
}

/** True when a parsed file looks like a scan result this version can compare with. */
export function isScanResult(value: unknown): value is ScanResult {
  const v = value as Partial<ScanResult> | null;
  return Boolean(
    v &&
      typeof v.accountId === "string" &&
      isStringList(v.regions) &&
      Array.isArray(v.findings) &&
      v.findings.every(isComparableFinding) &&
      typeof v.scannedAt === "string",
  );
}

/**
 * The current scan with each finding marked new or not, and a note of what
 * the previous scan had that this one no longer does. Returns undefined when
 * the two scans are of different accounts and so cannot be compared.
 */
export function compareScans(previous: ScanResult, current: ScanResult): ScanResult | undefined {
  if (previous.accountId !== current.accountId) return undefined;

  const before = new Set(previous.findings.map(keyOf));
  const now = new Set(current.findings.map(keyOf));
  const findings = current.findings.map((f) => ({ ...f, isNew: !before.has(keyOf(f)) }));
  // A finding is only "resolved" if its region was looked at again and it is gone.
  const resolved = previous.findings
    .filter((f) => current.regions.includes(f.region) && !now.has(keyOf(f)))
    .map((f) => ({ title: f.title, region: f.region, resourceIds: f.resourceIds, monthlyCostUsd: f.monthlyCostUsd }));

  const added = findings.filter((f) => f.isNew);
  const sum = (items: Array<{ monthlyCostUsd: number }>) => items.reduce((total, f) => total + f.monthlyCostUsd, 0);
  const comparison: Comparison = {
    previousScannedAt: previous.scannedAt,
    newCount: added.length,
    newMonthlyUsd: sum(added),
    newInRegionsNotScannedBefore: added.filter((f) => !previous.regions.includes(f.region)).length,
    resolved,
    resolvedMonthlyUsd: sum(resolved),
    unchangedCount: findings.length - added.length,
  };
  return { ...current, findings, comparison };
}
