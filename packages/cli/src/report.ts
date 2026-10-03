import type { Finding, Pattern, ScanResult } from "./types.js";

export const money = (n: number) => `$${n.toFixed(2)}`;

export const RISK_LABEL: Record<Finding["fix"]["risk"], string> = {
  caution: "CAUTION - review before running",
  dangerous: "DANGEROUS - permanent, needs explicit approval",
};

const ANSI = { bold: 1, dim: 2, cyan: 36, yellow: 33 } as const;

/** Colour for a terminal only: plain text when piped, or when NO_COLOR is set. */
function styleText(style: keyof typeof ANSI, text: string): string {
  const wanted = process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : process.stdout.isTTY && !process.env.NO_COLOR;
  return wanted ? `\u001b[${ANSI[style]}m${text}\u001b[0m` : text;
}

/**
 * An opaque ID too long to read, such as an S3 upload ID of a hundred
 * characters, cut down for a heading. Fix commands always carry the whole ID.
 * The limit sits above the longest bucket name (63), which is never cut.
 */
export const shortId = (id: string) => (id.length > 64 ? `${id.slice(0, 16)}...${id.slice(-6)}` : id);

/** The words for what was scanned and where findings live: an account and its regions, or a cluster and its namespaces. */
export const words = (result: ScanResult) =>
  result.cluster ? { scope: "cluster", place: "namespace", places: "namespaces" } : { scope: "account", place: "region", places: "regions" };

/** "ap-south-1" for one region, "17 regions" for several. */
export const regionLabel = (result: ScanResult) => (result.regions.length === 1 ? result.regions[0]! : `${result.regions.length} ${words(result).places}`);

/** Regions that have at least one finding, in name order. */
export const regionsWithFindings = (result: ScanResult) => [...new Set(result.findings.map((f) => f.region))].sort();

export function header(result: ScanResult): string[] {
  const { place, places } = words(result);
  const where = result.regions.length === 1 ? `${place} ${result.regions[0]}` : `${result.regions.length} ${places} scanned`;
  const cluster = result.cluster;
  if (cluster) {
    const p = cluster.prices;
    const from = p.source === "opencost-defaults" ? "OpenCost defaults; set your own with --cpu-hour-usd, --memory-gib-hour-usd, --storage-gib-month-usd" : "set on the command line";
    return [
      `Cluster ${cluster.context}, ${where}, scanned ${result.scannedAt}`,
      `Prices: $${p.cpuHourUsd} per vCPU-hour, $${p.memoryGibHourUsd} per GiB-hour of memory, $${p.storageGibMonthUsd} per GiB-month of storage (${from})`,
      cluster.prometheus ? `Usage: Prometheus at ${cluster.prometheus}, the last ${cluster.lookbackHours} ${cluster.lookbackHours === 1 ? "hour" : "hours"}` : "Usage: no Prometheus was read, so requests were not compared with real use",
    ];
  }
  return [
    `Account ${result.accountId}, ${where}, scanned ${result.scannedAt}`,
    `Prices: ${result.prices.source}, fetched ${result.prices.fetchedAt}`,
  ];
}

/** One line on what changed since the earlier scan, when there was one to compare with. */
export function comparisonLine(result: ScanResult): string | undefined {
  const c = result.comparison;
  if (!c) return undefined;
  // Says only what was compared: the same findings can still cost a little more or less than before.
  if (c.newCount === 0 && c.resolved.length === 0) return `No new or resolved findings since the last scan (${c.previousScannedAt}).`;
  const line = `Since the last scan (${c.previousScannedAt}): ${c.newCount} new (${money(c.newMonthlyUsd)} a month), ${c.resolved.length} resolved (${money(c.resolvedMonthlyUsd)} a month), ${c.unchangedCount} unchanged.`;
  const widened = c.newInRegionsNotScannedBefore;
  if (!widened) return line;
  // A wider scan than last time: those findings are new to the reader, not necessarily new in the account.
  // "one" or "ones" follows how many are new; "is" or "are" follows how many of them this explains.
  const ones = c.newCount === 1 ? "one" : "ones";
  const { place, places } = words(result);
  const where = widened === 1 ? `is in a ${place}` : `are in ${places}`;
  return `${line} ${widened} of the new ${ones} ${where} the last scan did not cover.`;
}

export interface ReportOptions {
  /** List only the findings that are new since the earlier scan. */
  onlyNew?: boolean;
  /**
   * Why this scan carries no comparison, where the caller knows that there was
   * more to it than there being no earlier scan: comparing was turned off or
   * not asked for ("off"), or the scan given to compare with could not be used
   * ("not-comparable"). Left unset, a report says there was nothing to compare
   * with, so it must only be left unset when that is true.
   */
  noComparison?: "off" | "not-comparable";
  /** Never colour the text, whatever the terminal: for a file or an email. */
  plain?: boolean;
}

/** The findings a report lists: all of them, or with onlyNew just those the earlier scan did not have. */
export function shownFindings(result: ScanResult, onlyNew = false): Finding[] {
  return onlyNew && result.comparison ? result.findings.filter((f) => f.isNew) : result.findings;
}

/** Note saying the list was cut down to the new findings, when it was. */
export function onlyNewLine(result: ScanResult, shown: Finding[], options: ReportOptions = {}): string | undefined {
  // Asked for only the new findings with no comparison to go by: every finding is shown, and says why that is.
  if (options.onlyNew && !result.comparison) {
    if (options.noComparison === "off") return "This scan was not compared with an earlier one; showing every finding.";
    if (options.noComparison === "not-comparable") return `The scan to compare with is of a different ${words(result).scope}; showing every finding.`;
    return "No earlier scan to compare with; showing every finding.";
  }
  if (shown.length >= result.findings.length) return undefined;
  // The everyday outcome of --only-new: the account is as it was, so nothing is listed.
  if (shown.length === 0) {
    return `Nothing new since the last scan; the ${result.findings.length} finding${result.findings.length === 1 ? " already reported is" : "s already reported are"} not listed.`;
  }
  return `Showing only the ${shown.length} new finding${shown.length === 1 ? "" : "s"}.`;
}

const resolvedLines = (result: ScanResult) =>
  (result.comparison?.resolved ?? []).map((r) => `${r.title} (${r.resourceIds.map(shortId).join(", ")}), ${money(r.monthlyCostUsd)} a month`);

/** Report for a terminal. */
export function renderText(result: ScanResult, options: ReportOptions = {}): string {
  const paint = (style: keyof typeof ANSI, text: string) => (options.plain ? text : styleText(style, text));
  const bold = (s: string) => paint("bold", s);
  const dim = (s: string) => paint("dim", s);
  const lines: string[] = [bold("CloudPilot scan"), ...header(result).map(dim), ""];

  lines.push(
    result.findings.length === 0
      ? "No waste found."
      : bold(`${result.findings.length} findings, ${money(result.totalMonthlyWasteUsd)} per month of estimated waste`),
  );
  const since = comparisonLine(result);
  if (since) lines.push(since);

  if (result.findings.length > 0) {
    const shown = shownFindings(result, options.onlyNew);
    const filtered = onlyNewLine(result, shown, options);
    if (filtered) lines.push(dim(filtered));
    lines.push("");
    shown.forEach((f, n) => {
      lines.push(`${bold(`${String(n + 1).padStart(2)}. ${money(f.monthlyCostUsd).padStart(8)}/mo  ${f.title}`)}${f.isNew ? paint("yellow", "  NEW") : ""}`);
      const region = result.regions.length > 1 ? `  ${f.region}` : "";
      lines.push(dim(`    ${f.resourceType}  ${f.resourceIds.map(shortId).join(", ")}${region}  rule confidence ${Math.round(f.confidence * 100)}%`));
      for (const e of f.evidence) lines.push(`    - ${e}`);
      lines.push(dim(`    cost: ${f.costBasis}`));
      lines.push(`    fix (${RISK_LABEL[f.fix.risk]}):`);
      for (const c of f.fix.commands) lines.push(paint("cyan", `      ${c}`));
      lines.push(dim(`    way back: ${f.fix.rollback}`));
      if (f.alternative) {
        lines.push(`    or: ${f.alternative.description} (saves ${money(f.alternative.monthlySavingUsd)}/mo):`);
        for (const c of f.alternative.commands) lines.push(paint("cyan", `      ${c}`));
      }
      lines.push("");
    });
    // The notice is about the commands just listed, and there are none to speak of when nothing was.
    if (shown.length > 0) lines.push(dim("CloudPilot is read-only: it prints these commands and never runs them."));
  }

  const resolved = resolvedLines(result);
  if (resolved.length > 0) lines.push("", "Resolved since the last scan:", ...resolved.map((r) => `  - ${r}`));

  const skipped = skippedLine(result);
  if (skipped) lines.push("", skipped);

  if (result.warnings.length > 0) {
    lines.push("", paint("yellow", `${result.warnings.length} check(s) could not run:`));
    for (const w of result.warnings) lines.push(paint("yellow", `  - ${w}`));
  }
  return lines.join("\n");
}

/**
 * The terminal report as a plain-text document, summary included: what a
 * person reads in a file or an email, where colour codes would be noise.
 */
export function renderPlainText(result: ScanResult, summary?: string, banner?: string, options: ReportOptions = {}): string {
  const parts = [...(banner ? [banner] : []), renderText(result, { ...options, plain: true }), ...(summary ? [`Summary\n\n${summary}`] : [])];
  return `${parts.join("\n\n")}\n`;
}

/** Report as a Markdown document. */
export function renderMarkdown(result: ScanResult, summary?: string, banner?: string, options: ReportOptions = {}): string {
  const lines: string[] = ["# CloudPilot scan", "", ...(banner ? [`> ${banner}`, ""] : []), ...header(result).map((h) => `- ${h}`), ""];
  lines.push(`**${result.findings.length} findings, ${money(result.totalMonthlyWasteUsd)} per month of estimated waste.**`, "");
  const since = comparisonLine(result);
  if (since) lines.push(since, "");
  const shown = shownFindings(result, options.onlyNew);
  const filtered = onlyNewLine(result, shown, options);
  if (filtered) lines.push(filtered, "");
  if (summary) lines.push("## Summary", "", summary, "");
  const resolved = resolvedLines(result);
  if (resolved.length > 0) lines.push("## Resolved since the last scan", "", ...resolved.map((r) => `- ${r}`), "");

  if (shown.length > 0) {
    lines.push("| # | Per month | Finding | Resource | Region | Fix risk |", "|---|---|---|---|---|---|");
    shown.forEach((f, n) => {
      lines.push(`| ${n + 1} | ${money(f.monthlyCostUsd)} | ${f.isNew ? "**New:** " : ""}${f.title} | \`${f.resourceIds.map(shortId).join("`, `")}\` | ${f.region} | ${f.fix.risk} |`);
    });
    lines.push("");
    shown.forEach((f, n) => {
      lines.push(`## ${n + 1}. ${f.title}${f.isNew ? " (new)" : ""}`, "");
      lines.push(`- **Cost:** ${money(f.monthlyCostUsd)} per month (${f.costBasis})`);
      lines.push(`- **Resource:** ${f.resourceType} \`${f.resourceIds.join("`, `")}\` in ${f.region}`);
      lines.push(`- **Rule confidence:** ${Math.round(f.confidence * 100)}%`);
      lines.push("- **Evidence:**", ...f.evidence.map((e) => `  - ${e}`));
      lines.push(`- **Fix** (${RISK_LABEL[f.fix.risk]}):`, "", "```sh", ...f.fix.commands, "```", "");
      lines.push(`- **Way back:** ${f.fix.rollback}`);
      if (f.alternative) {
        lines.push(
          `- **Alternative:** ${f.alternative.description}, saving ${money(f.alternative.monthlySavingUsd)} per month:`,
          "",
          "```sh",
          ...f.alternative.commands,
          "```",
        );
      }
      lines.push("");
    });
    lines.push("CloudPilot is read-only: it prints these commands and never runs them.", "");
  }
  const skipped = skippedLine(result);
  if (skipped) lines.push(skipped, "");
  if (result.warnings.length > 0) {
    lines.push("## Checks that could not run", "", ...result.warnings.map((w) => `- ${w}`), "");
  }
  return lines.join("\n");
}

/** How many resources the ignore tag left out, so skipping is never silent. */
export function skippedLine(result: ScanResult): string | undefined {
  const n = result.skippedByTag.length;
  if (n === 0) return undefined;
  const marker = result.cluster ? "label cloudpilot/ignore=true" : "tag cloudpilot:ignore=true";
  return `${n} resource${n === 1 ? " was" : "s were"} skipped because of the ${marker}: ${result.skippedByTag.join(", ")}`;
}

export const KIND: Record<Pattern, string> = {
  "unattached-ebs-volume": "Unattached EBS volumes",
  "gp2-volume": "gp2 volumes that could be gp3",
  "idle-elastic-ip": "Idle Elastic IPs",
  "stopped-instance": "Stopped instances still paying for storage",
  "idle-instance": "Idle running instances",
  "orphaned-snapshot": "Snapshots of deleted volumes",
  "unused-ami": "Unused AMIs",
  "bucket-without-lifecycle": "Buckets with no lifecycle rule",
  "incomplete-multipart-upload": "Incomplete multipart uploads",
  "over-requested-workload": "Workloads requesting more than they use",
  "unused-volume-claim": "Volume claims no pod mounts",
  "released-volume": "Volumes left Released",
};

/**
 * A summary built from the findings alone, with no model involved. Shown when
 * no model is available, or when a model's text fails the output check.
 * `shortenIds` cuts very long IDs down, for a summary a person will read;
 * callers that pass the text to a model leave it off and get whole IDs.
 */
export function templatedSummary(result: ScanResult, options: { shortenIds?: boolean } = {}): string {
  const label = (ids: string[]) => (options.shortenIds ? ids.map(shortId) : ids).join(", ");
  if (result.findings.length === 0) {
    const since = comparisonLine(result);
    return [`No waste found in ${regionLabel(result)}.`, ...(since ? [since] : []), ...(skippedLine(result) ? [skippedLine(result)!] : [])].join("\n");
  }
  const where =
    result.regions.length === 1
      ? result.regions[0]!
      : `${regionsWithFindings(result).length} of the ${result.regions.length} ${words(result).places} scanned`;
  const since = comparisonLine(result);
  const lines = [
    `Estimated waste: ${money(result.totalMonthlyWasteUsd)} per month across ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${where}.`,
    ...(since ? [since] : []),
    "",
    "By kind, most expensive first:",
  ];
  const groups = new Map<Pattern, Finding[]>();
  for (const f of result.findings) groups.set(f.pattern, [...(groups.get(f.pattern) ?? []), f]);
  const total = (fs: Finding[]) => fs.reduce((sum, f) => sum + f.monthlyCostUsd, 0);
  for (const [pattern, fs] of [...groups].sort((a, b) => total(b[1]) - total(a[1]))) {
    const risk = fs[0]!.fix.risk === "dangerous" ? "the fix is permanent" : "the fix can be reviewed and reversed";
    lines.push(`- ${KIND[pattern]}: ${fs.length} finding${fs.length === 1 ? "" : "s"}, ${money(total(fs))} per month; ${risk}.`);
  }

  if (result.regions.length > 1) {
    const withFindings = regionsWithFindings(result);
    lines.push("", `By ${words(result).place}:`);
    for (const region of withFindings) {
      const fs = result.findings.filter((f) => f.region === region);
      lines.push(`- ${region}: ${fs.length} finding${fs.length === 1 ? "" : "s"}, ${money(total(fs))} per month.`);
    }
    const clean = result.regions.length - withFindings.length;
    if (clean > 0) lines.push(`- ${clean} other ${clean === 1 ? words(result).place : words(result).places}: nothing found.`);
  }

  const top = result.findings[0]!;
  lines.push("", `Largest single finding: ${top.title} (${label(top.resourceIds)}), ${money(top.monthlyCostUsd)} per month.`);
  const safest = result.findings
    .flatMap((f) => (f.alternative ? [{ ids: f.resourceIds, saving: f.alternative.monthlySavingUsd, what: f.alternative.description }] : []))
    .sort((a, b) => b.saving - a.saving)[0];
  if (safest) {
    lines.push(`Lowest-risk saving: ${safest.what} (${label(safest.ids)}), ${money(safest.saving)} per month, reversible.`);
  }
  if (groups.has("orphaned-snapshot") || groups.has("unused-ami")) {
    lines.push("Snapshot and AMI costs are upper bounds based on provisioned size.");
  }
  if (groups.has("over-requested-workload")) {
    lines.push("Lower requests save money once the freed capacity lets the cluster run fewer or smaller nodes.");
  }
  const skipped = skippedLine(result);
  if (skipped) lines.push(skipped);
  lines.push("Nothing has been changed: every fix is a proposal for a person to review and run.");
  return lines.join("\n");
}
