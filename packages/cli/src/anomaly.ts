/**
 * Spend anomalies: which services cost unusually much on the latest complete
 * day, judged against the days before it. The rule is fixed and has no model
 * in it: the median and the median absolute deviation (MAD) of the baseline
 * days, plus a floor so that pennies never raise an alarm.
 *
 * Pure: no AWS, no clock. The date of "today" is passed in, so the same days
 * always give the same answer.
 */
import { money } from "./report.js";

/** Standard deviations of a normal distribution are 1.4826 times its MAD, so k reads like a number of standard deviations. */
export const MAD_SCALE = 1.4826;

/** Fewer baseline days than this is not enough to say what a usual day looks like. */
export const MIN_BASELINE_DAYS = 7;

/** With a flat baseline (MAD of zero) a day must also be this much above the median, as a fraction of it. */
export const FLAT_RISE = 0.5;

/** The days a "if this continues" figure adds up. */
export const PROJECTION_DAYS = 30;

export const DEFAULT_SENSITIVITY = 3;
export const DEFAULT_MIN_INCREASE_USD = 1;

export const MIN_DAYS = 8;
export const MAX_DAYS = 90;
export const DEFAULT_DAYS = 30;

/** AWS charges this for each Cost Explorer request. */
export const REQUEST_USD = 0.01;

/** What the command says before it reads anything, and in its help. */
export const CHARGE_NOTICE = `Cost Explorer: AWS charges $${REQUEST_USD.toFixed(2)} for each request, and this makes one (more only if AWS splits the answer into pages).`;

/** The same for a run that reads a recording instead. */
export const REPLAY_CHARGE_NOTICE = `Cost Explorer is read from the recording, so no request is made and nothing is charged. A live run makes one request, which AWS charges $${REQUEST_USD.toFixed(2)} for.`;

/** What a day cost, per service, in dollars. */
export interface DayCost {
  /** YYYY-MM-DD, UTC. */
  day: string;
  /** Cost Explorer still marks the day's figures as estimated. */
  estimated?: boolean;
  /** Unblended cost by service. A service with no entry cost nothing that day. */
  costs: Record<string, number>;
}

export interface AnomalyRule {
  /** How many scaled MADs above the median a day must be. */
  sensitivity: number;
  /** How many dollars a day above the median it must be at least. */
  minIncreaseUsd: number;
}

export interface Anomaly {
  service: string;
  /** "new" when the service cost nothing at all in the baseline. */
  kind: "spike" | "new";
  day: string;
  costUsd: number;
  /** The usual daily cost: the median of the baseline days. */
  medianUsd: number;
  /** The median absolute deviation of the baseline days. 0 for a flat baseline. */
  madUsd: number;
  /** How much more than usual the day cost. */
  increaseUsd: number;
  /** What that adds up to over 30 days, if every day cost as much as this one. Arithmetic, not a forecast. */
  monthlyIfContinuesUsd: number;
  baselineDays: number;
}

export interface AnomalyReport {
  /** "ok": the rule was applied. Otherwise it could not be, and `anomalies` is empty. */
  status: "ok" | "not-enough-history" | "no-data";
  today: string;
  /** The latest complete day, the one that was judged. */
  latestDay?: string;
  /** Cost Explorer still marks the latest day as an estimate. */
  latestDayEstimated: boolean;
  /** The days the latest one was compared with. */
  baseline?: { days: number; from: string; to: string };
  /** Complete days before the latest, however many there were. */
  baselineDaysFound: number;
  servicesChecked: number;
  rule: AnomalyRule;
  /** Largest increase first. */
  anomalies: Anomaly[];
  totalIncreaseUsd: number;
  totalMonthlyIfContinuesUsd: number;
}

/** The middle value, or the mean of the two middle ones. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The median of how far each value is from `center`. Most of the values can be off by a lot before it moves. */
export function medianAbsoluteDeviation(values: number[], center = median(values)): number {
  return median(values.map((v) => Math.abs(v - center)));
}

/**
 * Days from one or several pages of an answer as one list, oldest first.
 * A day that appears more than once has its services' costs added together,
 * which is right when AWS split a day's services over two pages.
 */
export function mergeDays(parts: DayCost[]): DayCost[] {
  const byDay = new Map<string, DayCost>();
  for (const part of parts) {
    const day = byDay.get(part.day) ?? { day: part.day, costs: {} };
    for (const [service, usd] of Object.entries(part.costs)) day.costs[service] = (day.costs[service] ?? 0) + usd;
    if (part.estimated) day.estimated = true;
    byDay.set(part.day, day);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

const toCents = (usd: number) => Math.round(usd * 100);
const fromCents = (cents: number) => cents / 100;

/**
 * Judge one service. Everything is in whole cents, so a figure on the screen
 * is the figure the rule used. Returns what is unusual about the day, or
 * nothing.
 */
function judge(service: string, day: string, baseline: number[], latest: number, rule: AnomalyRule): Anomaly | undefined {
  const usual = Math.round(median(baseline));
  const spread = Math.round(medianAbsoluteDeviation(baseline, usual));
  const increase = latest - usual;
  // The floor first: a rise of pennies is never an anomaly, however flat the baseline.
  if (increase <= 0 || increase < toCents(rule.minIncreaseUsd)) return undefined;
  const unusual =
    spread > 0
      ? latest > usual + rule.sensitivity * MAD_SCALE * spread
      : // A flat baseline has no spread to measure against, so the day must be clearly more than the usual one: by half again.
        latest >= usual * (1 + FLAT_RISE);
  if (!unusual) return undefined;
  return {
    service,
    kind: baseline.every((c) => c === 0) ? "new" : "spike",
    day,
    costUsd: fromCents(latest),
    medianUsd: fromCents(usual),
    madUsd: fromCents(spread),
    increaseUsd: fromCents(increase),
    monthlyIfContinuesUsd: fromCents(increase * PROJECTION_DAYS),
    baselineDays: baseline.length,
  };
}

/**
 * Compare the latest complete day with the days before it, per service.
 * A day that is `today` or later is still in progress and is never used.
 * Days Cost Explorer returned nothing for do not count; a service missing from
 * a day that Cost Explorer did return cost nothing that day.
 */
export function findAnomalies(parts: DayCost[], today: string, rule: AnomalyRule): AnomalyReport {
  const empty = { today, latestDayEstimated: false, baselineDaysFound: 0, servicesChecked: 0, rule, anomalies: [], totalIncreaseUsd: 0, totalMonthlyIfContinuesUsd: 0 };
  const days = mergeDays(parts).filter((d) => d.day < today);
  const latest = days.at(-1);
  if (!latest) return { ...empty, status: "no-data" };

  const before = days.slice(0, -1);
  const known = { ...empty, latestDay: latest.day, latestDayEstimated: Boolean(latest.estimated), baselineDaysFound: before.length };
  if (before.length < MIN_BASELINE_DAYS) return { ...known, status: "not-enough-history" };

  const services = [...new Set(days.flatMap((d) => Object.keys(d.costs)))].sort();
  const anomalies: Anomaly[] = [];
  for (const service of services) {
    const baseline = before.map((d) => toCents(d.costs[service] ?? 0));
    const found = judge(service, latest.day, baseline, toCents(latest.costs[service] ?? 0), rule);
    if (found) anomalies.push(found);
  }
  // Largest increase first; the name settles a tie, so the order never depends on how Cost Explorer listed the services.
  anomalies.sort((a, b) => b.increaseUsd - a.increaseUsd || (a.service < b.service ? -1 : 1));
  const totalCents = anomalies.reduce((sum, a) => sum + toCents(a.increaseUsd), 0);
  return {
    ...known,
    status: "ok",
    baseline: { days: before.length, from: before[0]!.day, to: before.at(-1)!.day },
    servicesChecked: services.length,
    anomalies,
    totalIncreaseUsd: fromCents(totalCents),
    totalMonthlyIfContinuesUsd: fromCents(totalCents * PROJECTION_DAYS),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The day before `day`, as YYYY-MM-DD. */
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** What the rule said, in words that do not promise more than it knows. */
export function renderAnomalies(report: AnomalyReport, context: { accountId: string; days: number; requests: number }): string {
  const { rule } = report;
  const lines = [
    `Spend anomalies for AWS account ${context.accountId}`,
    `Unblended cost per service over the last ${context.days} days, before credits, refunds and tax.`,
  ];
  const latest = report.latestDay;
  if (report.status === "no-data" || !latest) {
    lines.push("", `Cost Explorer returned no cost data for those days, so nothing was judged. A new account, or one Cost Explorer was only just enabled for, has none yet.`);
  } else if (report.status === "not-enough-history") {
    lines.push(
      "",
      `Not enough history to judge: ${plural(report.baselineDaysFound, "complete day")} before ${latest}, and at least ${MIN_BASELINE_DAYS} are needed to say what a usual day costs. Nothing was flagged.`,
    );
  } else {
    const { baseline } = report;
    lines.push(`Judged: ${latest}, the latest complete day, against the ${baseline!.days} days before it (${baseline!.from} to ${baseline!.to}).`);
  }
  if (latest) {
    const settling = [
      `Today (${report.today}) is still in progress and is not used.`,
      latest < dayBefore(report.today) ? `Cost Explorer had no data after ${latest} yet.` : undefined,
      `Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change.`,
      report.latestDayEstimated ? `AWS still marks ${latest} as an estimate.` : undefined,
    ];
    lines.push(settling.filter(Boolean).join(" "));
  }

  if (report.status === "ok") {
    lines.push("");
    if (report.anomalies.length === 0) {
      lines.push(`Nothing unusual on ${latest}: no service cost at least ${money(rule.minIncreaseUsd)} a day more than its usual day and beyond its normal range (${plural(report.servicesChecked, "service")} checked).`);
    } else {
      lines.push(`${plural(report.anomalies.length, "service")} cost more than usual on ${latest}:`, "");
      report.anomalies.forEach((a, n) => {
        const usual =
          a.kind === "new"
            ? `${money(a.medianUsd)}  (no cost at all in the ${a.baselineDays} days before: new spend)`
            : `${money(a.medianUsd)}  (median of the ${a.baselineDays} days before)`;
        lines.push(
          `  ${n + 1}. ${a.service}`,
          `     ${a.day}    ${money(a.costUsd)}`,
          `     usual day     ${usual}`,
          `     difference    +${money(a.increaseUsd)} a day; if this continues, about +${money(a.monthlyIfContinuesUsd)} over ${PROJECTION_DAYS} days`,
          "",
        );
      });
      lines.push(
        `Total: +${money(report.totalIncreaseUsd)} a day more than usual across ${plural(report.anomalies.length, "service")}. If all of it continued, that would add up to about ${money(report.totalMonthlyIfContinuesUsd)} over ${PROJECTION_DAYS} days.`,
        `The rule says a day was unusual, not why. The ${PROJECTION_DAYS}-day figure is arithmetic on one day, not a forecast.`,
      );
    }
  }
  lines.push("", context.requests === 0 ? "Cost Explorer requests made: 0 (read from the recording)." : `Cost Explorer requests made: ${context.requests} (AWS charges $${REQUEST_USD.toFixed(2)} each).`);
  return lines.join("\n");
}

/**
 * The result as JSON. The shape is part of the command's interface: new
 * fields may be added, none is renamed or removed. Dollar amounts are numbers
 * rounded to the cent; days are YYYY-MM-DD in UTC.
 */
export function anomaliesJson(report: AnomalyReport, context: { accountId: string; days: number; requests: number; replay?: string }) {
  return {
    command: "anomalies",
    accountId: context.accountId,
    ...(context.replay ? { replay: context.replay } : {}),
    charge: { requests: context.requests, usdPerRequest: REQUEST_USD, notice: context.replay ? REPLAY_CHARGE_NOTICE : CHARGE_NOTICE },
    status: report.status,
    today: report.today,
    windowDays: context.days,
    latestDay: report.latestDay ?? null,
    latestDayEstimated: report.latestDayEstimated,
    baseline: report.baseline ?? null,
    baselineDaysFound: report.baselineDaysFound,
    servicesChecked: report.servicesChecked,
    rule: { ...report.rule, madScale: MAD_SCALE, flatRise: FLAT_RISE, minBaselineDays: MIN_BASELINE_DAYS, projectionDays: PROJECTION_DAYS },
    anomalies: report.anomalies,
    totalIncreaseUsd: report.totalIncreaseUsd,
    totalMonthlyIfContinuesUsd: report.totalMonthlyIfContinuesUsd,
    note: "Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change.",
  };
}
