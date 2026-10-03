/** Scans built by hand, for tests that need particular findings rather than the recorded lab. */
import type { Finding, ScanResult } from "../src/types.js";

export const finding = (id: string, cost: number, extra: Partial<Finding> = {}): Finding => ({
  region: "ap-south-1",
  pattern: "unattached-ebs-volume",
  title: `Unattached 500 GB gp2 volume`,
  resourceType: "AWS::EC2::Volume",
  resourceIds: [id],
  evidence: ["State is available"],
  monthlyCostUsd: cost,
  costBasis: "500 GB x $0.114/GB-month (gp2)",
  fix: { commands: [`aws ec2 delete-volume --volume-id ${id}`], risk: "dangerous", rollback: "" },
  confidence: 0.95,
  ...extra,
});

export const scan = (findings: Finding[], extra: Partial<ScanResult> = {}): ScanResult => ({
  accountId: "123456789012",
  regions: ["ap-south-1"],
  scannedAt: "2026-10-03T00:00:00Z",
  prices: { source: "price-file", fetchedAt: "" },
  findings,
  totalMonthlyWasteUsd: findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0),
  skippedByTag: [],
  warnings: [],
  ...extra,
});
