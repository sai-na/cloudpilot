import { readFile } from "node:fs/promises";
import type { Finding, ScanResult } from "./types.js";

/** One entry of the waste lab's answer key (lab-manifest.json). */
interface ManifestPattern {
  id: string;
  waste_pattern: string;
  resource_ids: string[];
  fix_commands: string[];
  estimated_monthly_cost_usd: number;
  alternative_fix_commands?: string[];
  alternative_monthly_saving_usd?: number;
}

export type FixMatch = "exact" | "equivalent" | "different";

export interface PatternScore {
  id: string;
  wastePattern: string;
  found: boolean;
  expectedCostUsd: number;
  actualCostUsd: number;
  costOk: boolean;
  fix: FixMatch;
  /** Only when the answer key lists an alternative fix. */
  alternativeOk?: boolean;
}

export interface Evaluation {
  scores: PatternScore[];
  /** Findings that match nothing in the answer key. */
  extra: Finding[];
  passed: boolean;
}

const squash = (command: string) => command.trim().replace(/\s+/g, " ");

/** The same operation on the same resource, whatever policy document is passed along. */
const operation = (command: string) => squash(command).replace(/--lifecycle-configuration '[^']*'/, "--lifecycle-configuration <rule>");

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

const costMatches = (expected: number, actual: number) => Math.abs(expected - actual) <= Math.max(0.01, expected * 0.01);

export async function evaluate(result: ScanResult, manifestPath: string): Promise<Evaluation> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { patterns: ManifestPattern[] };
  const matched = new Set<Finding>();

  const scores = manifest.patterns.map((p): PatternScore => {
    const hits = result.findings.filter((f) => f.resourceIds.some((id) => p.resource_ids.includes(id)));
    hits.forEach((f) => matched.add(f));
    const covered = new Set(hits.flatMap((f) => f.resourceIds));
    const actualCostUsd = hits.reduce((sum, f) => sum + f.monthlyCostUsd, 0);
    const commands = hits.flatMap((f) => f.fix.commands);

    const fix: FixMatch = sameSet(commands.map(squash), p.fix_commands.map(squash))
      ? "exact"
      : sameSet(commands.map(operation), p.fix_commands.map(operation))
        ? "equivalent"
        : "different";

    const score: PatternScore = {
      id: p.id,
      wastePattern: p.waste_pattern,
      found: p.resource_ids.every((id) => covered.has(id)),
      expectedCostUsd: p.estimated_monthly_cost_usd,
      actualCostUsd,
      costOk: costMatches(p.estimated_monthly_cost_usd, actualCostUsd),
      fix,
    };
    if (p.alternative_fix_commands) {
      const altCommands = hits.flatMap((f) => f.alternative?.commands ?? []);
      const altSaving = hits.reduce((sum, f) => sum + (f.alternative?.monthlySavingUsd ?? 0), 0);
      score.alternativeOk =
        sameSet(altCommands.map(squash), p.alternative_fix_commands.map(squash)) &&
        costMatches(p.alternative_monthly_saving_usd ?? 0, altSaving);
    }
    return score;
  });

  const extra = result.findings.filter((f) => !matched.has(f));
  const passed = scores.every((s) => s.found && s.costOk && s.fix !== "different" && s.alternativeOk !== false);
  return { scores, extra, passed };
}

export function renderEvaluation(evaluation: Evaluation): string {
  const { scores, extra } = evaluation;
  const yes = (ok: boolean) => (ok ? "yes" : "NO");
  const lines = [
    "CloudPilot vs. the answer key",
    "",
    `${"ID".padEnd(4)} ${"found".padEnd(6)} ${"expected".padStart(9)} ${"got".padStart(9)} ${"cost".padEnd(5)} ${"fix".padEnd(11)} pattern`,
  ];
  for (const s of scores) {
    lines.push(
      `${s.id.padEnd(4)} ${yes(s.found).padEnd(6)} ${`$${s.expectedCostUsd.toFixed(2)}`.padStart(9)} ${`$${s.actualCostUsd.toFixed(2)}`.padStart(9)} ${yes(s.costOk).padEnd(5)} ${s.fix.padEnd(11)} ${s.wastePattern}${s.alternativeOk === undefined ? "" : ` (alternative fix: ${yes(s.alternativeOk)})`}`,
    );
  }
  const count = (ok: (s: PatternScore) => boolean) => `${scores.filter(ok).length}/${scores.length}`;
  lines.push(
    "",
    `Found ${count((s) => s.found)}, cost within 1% ${count((s) => s.costOk)}, fix command matches ${count((s) => s.fix !== "different")} (${count((s) => s.fix === "exact")} exact).`,
  );
  if (extra.length > 0) {
    lines.push("", `${extra.length} finding(s) not in the answer key:`);
    for (const f of extra) lines.push(`  - ${f.title} [${f.resourceIds.join(", ")}]`);
  } else {
    lines.push("No findings outside the answer key.");
  }
  lines.push("", evaluation.passed ? "PASS" : "FAIL");
  return lines.join("\n");
}
