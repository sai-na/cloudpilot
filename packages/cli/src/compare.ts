/**
 * What changed between two scans, so a repeat scan can say "two new, one
 * resolved" instead of making the reader go through every finding again.
 */
import { regionsNotFullyScanned } from "./detect.js";
import type { Comparison, Finding, ScanResult } from "./types.js";

/** What makes two findings the same finding across scans. */
export const keyOf = (f: Finding) => `${f.pattern}|${f.region}|${[...f.resourceIds].sort().join(",")}`;

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

/** The regions (or namespaces) of a scan where a check could not run, so what is missing there is unknown rather than gone. */
function incompleteRegions(scan: ScanResult): Set<string> {
  // A cluster is read as a whole, so a failed read there leaves every namespace in doubt.
  return scan.cluster && scan.warnings.length > 0 ? new Set(scan.regions) : regionsNotFullyScanned(scan.warnings);
}

/**
 * Which regions (or namespaces) this scan read in full, so that what an
 * earlier scan had there and this one does not is really gone. A region this
 * scan never looked at is as unknown as one whose check failed. Both the
 * comparison and the carrying forward have to agree on this, or a finding can
 * be neither resolved nor kept and so look new the next time it is read.
 */
function readFully(scan: ScanResult): (region: string) => boolean {
  const incomplete = incompleteRegions(scan);
  return (region) => scan.regions.includes(region) && !incomplete.has(region);
}

/**
 * The scan to compare the next one with once this one has been reported:
 * the scan itself, plus what the earlier one had in places this one did not
 * read in full. Without that, a check that fails once and works again - or a
 * run narrowed to fewer regions - would make every finding behind it look new
 * the next time it is read.
 */
export function carryForward(previous: ScanResult | undefined, current: ScanResult): ScanResult {
  if (!previous || previous.accountId !== current.accountId) return current;
  const readAgain = readFully(current);
  const have = new Set(current.findings.map(keyOf));
  const kept = previous.findings.filter((f) => !readAgain(f.region) && !have.has(keyOf(f)));
  if (kept.length === 0) return current;
  const findings = [...current.findings, ...kept];
  return { ...current, findings, totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0) };
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
  // A finding is only "resolved" if its region was read again in full and it is
  // gone. Where a check could not run, the resource may well still be there and
  // only the reading of it is missing, which is never a fix.
  const readAgain = readFully(current);
  const resolved = previous.findings
    .filter((f) => readAgain(f.region) && !now.has(keyOf(f)))
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
