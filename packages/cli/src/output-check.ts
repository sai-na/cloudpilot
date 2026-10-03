/**
 * Guard on model-written text: every resource ID and dollar amount in it must
 * already exist in the scan data. One invented value and the text is thrown away.
 */
import type { Inventory, PriceBook, ScanResult } from "./types.js";

const RESOURCE_ID = /\b(?:vol|snap|ami|i|eipalloc|eipassoc|eni|lt|sg|subnet|vpc|nat)-[0-9a-f]{8,}\b/g;
const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
/** A percentage written as 1.2%, 1.2 % or 1.2 percent. */
const PERCENT = /(\d+(?:\.\d+)?)\s?(?:%|percent\b)/g;
/** How far either side of a percentage to look for the words that make it a share of the bill. */
const PERCENT_CONTEXT = 60;
const ABOUT_THE_BILL = /\b(?:bill|billed|spend|spent|spending|invoice)\b/i;

export interface Allowed {
  ids: Set<string>;
  amounts: number[];
  /** The share of the bill CloudPilot worked out, the only percentage a model may state about spend. */
  percents: number[];
}

/** The share of the bill as written in a report, which says "less than 0.1%" for a share that rounds to nothing. */
const sharePercents = (result: ScanResult) => {
  const pct = result.bill?.wasteSharePct;
  return pct === undefined ? [] : pct === 0 ? [0, 0.1] : [pct];
};

/** Everything the model was given and may therefore repeat. */
export function allowedValues(result: ScanResult, extra?: { inventories?: Inventory[]; prices?: PriceBook[] }): Allowed {
  const source = JSON.stringify([result, extra?.inventories ?? null]);
  const amounts = [
    result.totalMonthlyWasteUsd,
    ...(result.comparison
      ? [result.comparison.newMonthlyUsd, result.comparison.resolvedMonthlyUsd, ...result.comparison.resolved.map((r) => r.monthlyCostUsd)]
      : []),
    ...result.findings.flatMap((f) => [f.monthlyCostUsd, ...(f.alternative ? [f.alternative.monthlySavingUsd] : [])]),
    ...(result.bill?.totalUsd !== undefined ? [result.bill.totalUsd] : []),
    // Unit prices quoted inside cost notes, such as "$0.114/GB-month".
    ...[...source.matchAll(DOLLARS)].map((m) => Number(m[1]!.replace(/,/g, ""))),
  ];
  // Every price in a book the model was handed, whichever field it sits in.
  const prices = (value: unknown): number[] =>
    typeof value === "number"
      ? [value]
      : value !== null && typeof value === "object"
        ? Object.values(value as Record<string, unknown>).filter((v): v is number => typeof v === "number")
        : [];
  for (const book of extra?.prices ?? []) {
    for (const field of Object.values(book as unknown as Record<string, unknown>)) amounts.push(...prices(field));
  }
  return { ids: new Set(source.match(RESOURCE_ID) ?? []), amounts, percents: sharePercents(result) };
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
  // A percentage of what the account spent is the one CloudPilot worked out, or it is invented.
  // Other percentages (CPU, confidence) are scan data and are left to the amounts and IDs above.
  for (const match of text.matchAll(PERCENT)) {
    const around = text.slice(Math.max(0, match.index - PERCENT_CONTEXT), match.index + match[0].length + PERCENT_CONTEXT);
    if (!ABOUT_THE_BILL.test(around)) continue;
    const decimals = match[1]!.split(".")[1]?.length ?? 0;
    if (!allowed.percents.some((p) => Number(p.toFixed(decimals)) === Number(match[1]))) bad.push(match[0]);
  }
  return bad;
}
