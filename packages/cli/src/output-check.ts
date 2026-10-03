/**
 * Guard on model-written text: every resource ID and dollar amount in it must
 * already exist in the scan data. One invented value and the text is thrown away.
 */
import type { Inventory, PriceBook, ScanResult } from "./types.js";

const RESOURCE_ID = /\b(?:vol|snap|ami|i|eipalloc|eipassoc|eni|lt|sg|subnet|vpc)-[0-9a-f]{8,}\b/g;
const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;

export interface Allowed {
  ids: Set<string>;
  amounts: number[];
}

/** Everything the model was given and may therefore repeat. */
export function allowedValues(result: ScanResult, extra?: { inventories?: Inventory[]; prices?: PriceBook[] }): Allowed {
  const source = JSON.stringify([result, extra?.inventories ?? null]);
  const amounts = [
    result.totalMonthlyWasteUsd,
    ...result.findings.flatMap((f) => [f.monthlyCostUsd, ...(f.alternative ? [f.alternative.monthlySavingUsd] : [])]),
    // Unit prices quoted inside cost notes, such as "$0.114/GB-month".
    ...[...source.matchAll(DOLLARS)].map((m) => Number(m[1]!.replace(/,/g, ""))),
  ];
  for (const p of extra?.prices ?? []) {
    amounts.push(p.snapshotGbMonth, p.idleIpv4Hour, p.s3StandardGbMonth, ...Object.values(p.ebsGbMonth), ...Object.values(p.instanceHour));
  }
  return { ids: new Set(source.match(RESOURCE_ID) ?? []), amounts };
}

/**
 * Returns the values in the text that are not backed by the scan data.
 * An empty list means the text may be shown.
 */
export function unsupportedValues(text: string, allowed: Allowed): string[] {
  const bad: string[] = [];
  for (const id of new Set(text.match(RESOURCE_ID) ?? [])) {
    if (!allowed.ids.has(id)) bad.push(id);
  }
  for (const match of text.matchAll(DOLLARS)) {
    const written = match[1]!.replace(/,/g, "");
    const decimals = written.split(".")[1]?.length ?? 0;
    // "$57" is fine for 57.00 and "$8.9" for 8.91: compare at the precision the text used.
    const value = Number(written);
    if (!allowed.amounts.some((a) => Number(a.toFixed(decimals)) === value)) bad.push(match[0]);
  }
  return bad;
}
