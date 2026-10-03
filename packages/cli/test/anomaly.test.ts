/** The spend anomaly rule on plain arrays: no AWS, no clock, no network. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anomaliesJson,
  CHARGE_NOTICE,
  DEFAULT_MIN_INCREASE_USD,
  DEFAULT_SENSITIVITY,
  findAnomalies,
  mergeDays,
  median,
  medianAbsoluteDeviation,
  renderAnomalies,
  type AnomalyRule,
  type DayCost,
} from "../src/anomaly.js";

const TODAY = "2026-10-01";
const RULE: AnomalyRule = { sensitivity: DEFAULT_SENSITIVITY, minIncreaseUsd: DEFAULT_MIN_INCREASE_USD };

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** One service's daily cost: the last value is the day before `today`, each earlier one a day older. */
function daily(service: string, values: number[], today = TODAY): DayCost[] {
  return values.map((usd, i) => ({ day: addDays(today, i - values.length), costs: { [service]: usd } }));
}

/** Several services over the same days. */
function together(...parts: DayCost[][]): DayCost[] {
  return mergeDays(parts.flat());
}

const repeat = (value: number, n: number) => Array<number>(n).fill(value);
const run = (days: DayCost[], rule: Partial<AnomalyRule> = {}, today = TODAY) => findAnomalies(days, today, { ...RULE, ...rule });
const only = (report: ReturnType<typeof run>) => {
  assert.equal(report.anomalies.length, 1, JSON.stringify(report.anomalies));
  return report.anomalies[0]!;
};

// ---- The statistics ----

test("the median is the middle value, or the mean of the middle two, whatever the order", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.throws(() => median([]));
});

test("the median absolute deviation does not move for one huge value", () => {
  assert.equal(medianAbsoluteDeviation([1, 2, 3, 4, 5]), 1);
  // The mean would be 22.8 and the standard deviation 39; the median and the MAD hardly notice the 100.
  assert.equal(median([1, 2, 3, 4, 100]), 3);
  assert.equal(medianAbsoluteDeviation([1, 2, 3, 4, 100]), 1);
  assert.equal(medianAbsoluteDeviation(repeat(10, 9)), 0);
});

// ---- Flat baseline: no spread, so the floor and a rise of half again decide ----

test("a spike on a flat baseline is flagged, with the usual cost, the rise and what 30 days of it would add up to", () => {
  const found = only(run(daily("Amazon EC2", [...repeat(10, 29), 16])));
  assert.deepEqual(found, {
    service: "Amazon EC2",
    kind: "spike",
    day: "2026-09-30",
    costUsd: 16,
    medianUsd: 10,
    madUsd: 0,
    increaseUsd: 6,
    monthlyIfContinuesUsd: 180,
    baselineDays: 29,
  });
});

test("on a flat baseline the day must be at least half again the usual one, and at least the floor above it", () => {
  const judged = (latest: number, rule: Partial<AnomalyRule> = {}) => run(daily("S", [...repeat(10, 29), latest]), rule).anomalies.length;
  assert.equal(judged(15), 1, "exactly 50% above is flagged");
  assert.equal(judged(14.99), 0, "just under 50% above is not");
  assert.equal(judged(10), 0);
  assert.equal(judged(4), 0, "a cheaper day is never an anomaly");
  // The floor: 50% of 1.00 is 0.50, which is under a dollar, so a dollar is the test that holds.
  const small = (latest: number) => run(daily("S", [...repeat(1, 29), latest])).anomalies.length;
  assert.equal(small(1.99), 0);
  assert.equal(small(2), 1);
});

test("a rise under the dollar floor is never flagged, however large it is relative to the usual cost", () => {
  const report = run(daily("Amazon Route 53", [...repeat(0.02, 29), 0.9]));
  assert.equal(report.status, "ok");
  assert.deepEqual(report.anomalies, [], "45 times the usual cost, and still under a dollar more");
  // The same rise is flagged when the floor is lowered to match.
  assert.equal(run(daily("S", [...repeat(0.02, 29), 0.9]), { minIncreaseUsd: 0.5 }).anomalies.length, 1);
  // The floor is a floor, not a threshold: at exactly the floor it is flagged.
  assert.equal(run(daily("S", [...repeat(0.5, 29), 1.5])).anomalies.length, 1);
  assert.equal(run(daily("S", [...repeat(0.5, 29), 1.49])).anomalies.length, 0);
  assert.equal(run(daily("S", [...repeat(10, 29), 14.99]), { minIncreaseUsd: 5 }).anomalies.length, 0);
});

test("a floor of zero still never flags a day that cost the usual amount or less", () => {
  assert.deepEqual(run(daily("S", repeat(5, 30)), { minIncreaseUsd: 0 }).anomalies, []);
  assert.deepEqual(run(daily("S", [...repeat(5, 29), 0]), { minIncreaseUsd: 0 }).anomalies, []);
  assert.deepEqual(run(daily("S", repeat(0, 30)), { minIncreaseUsd: 0 }).anomalies, []);
});

// ---- Noisy baseline: median + k * 1.4826 * MAD ----

/** 9, 10 and 11 dollars in a fixed mix: median 10 and MAD 1, so the line is 10 + 3 * 1.4826 = 14.4478. */
const NOISY = Array.from({ length: 29 }, (_, i) => [9, 10, 11][i % 3]!);

test("the noisy baseline used here has a median of 10 and a MAD of 1", () => {
  assert.equal(NOISY.length, 29);
  assert.equal(median(NOISY), 10);
  assert.equal(medianAbsoluteDeviation(NOISY), 1);
});

test("on a noisy baseline the line is the median plus k times 1.4826 times the MAD, to the cent", () => {
  const judged = (latest: number, rule: Partial<AnomalyRule> = {}) => run(daily("S", [...NOISY, latest]), rule).anomalies;
  assert.deepEqual(judged(14.44), [], "14.44 is under the line of 14.4478");
  assert.equal(judged(14.45).length, 1, "14.45 is over it");
  assert.deepEqual(judged(11), [], "an ordinary noisy day");
  // k moves the line: 10 + 5 * 1.4826 = 17.413.
  assert.equal(judged(16).length, 1);
  assert.deepEqual(judged(16, { sensitivity: 5 }), []);
  assert.equal(judged(17.42, { sensitivity: 5 }).length, 1);
  const found = judged(20)[0]!;
  assert.equal(found.madUsd, 1);
  assert.equal(found.medianUsd, 10);
  assert.equal(found.increaseUsd, 10);
});

test("both tests must hold: over the line but under the floor, or over the floor but under the line, is not flagged", () => {
  // A very quiet service: MAD 0.01, so the line is 0.05 above the median, far under a dollar.
  const quiet = Array.from({ length: 29 }, (_, i) => (i % 2 === 0 ? 0.04 : 0.06));
  assert.deepEqual(run(daily("S", [...quiet, 0.6])).anomalies, [], "over the line, not a dollar above the median");
  assert.equal(run(daily("S", [...quiet, 1.06])).anomalies.length, 1);
  // A very noisy service: a dollar above the median is well inside its normal range.
  const loud = Array.from({ length: 29 }, (_, i) => [50, 60, 70][i % 3]!);
  assert.deepEqual(run(daily("S", [...loud, 75])).anomalies, [], "over the floor, under the line");
});

// ---- Spikes, order, totals ----

test("anomalies are listed largest increase first, a tie by name, with a total", () => {
  const days = together(
    daily("Amazon S3", [...repeat(2, 29), 9]),
    daily("Amazon EC2", [...repeat(40, 29), 100]),
    daily("AWS Lambda", [...repeat(2, 29), 9]),
    daily("Amazon RDS", repeat(30, 30)),
  );
  const report = run(days);
  assert.deepEqual(report.anomalies.map((a) => [a.service, a.increaseUsd]), [["Amazon EC2", 60], ["AWS Lambda", 7], ["Amazon S3", 7]]);
  assert.equal(report.totalIncreaseUsd, 74);
  assert.equal(report.totalMonthlyIfContinuesUsd, 2220);
  assert.equal(report.servicesChecked, 4);
});

test("the same days in any order give the same report", () => {
  const days = together(daily("Amazon S3", [...repeat(2, 29), 9]), daily("Amazon EC2", [...repeat(40, 29), 100]));
  const shuffled = [...days].reverse().map((d) => ({ ...d, costs: Object.fromEntries(Object.entries(d.costs).reverse()) }));
  assert.deepEqual(run(shuffled), run(days));
  assert.deepEqual(run(days), run(days));
});

test("a service with no entry on a day that Cost Explorer did return cost nothing that day", () => {
  // Twenty-six days of nothing and three of 5.00: the usual day is 0.00, and 5.00 is not new, since it has cost before.
  const sparse = daily("Amazon Glacier", [...repeat(0, 10), 5, ...repeat(0, 10), 5, ...repeat(0, 6), 5, 5]);
  const days = together(sparse.map((d) => (d.costs["Amazon Glacier"] === 0 ? { day: d.day, costs: {} } : d)), daily("Other", repeat(1, 30)));
  const found = only(run(days));
  assert.equal(found.service, "Amazon Glacier");
  assert.equal(found.kind, "spike");
  assert.equal(found.medianUsd, 0);
});

// ---- New spend ----

test("a service with no cost in the baseline that now costs at least the floor is new spend", () => {
  const days = together(daily("Amazon EC2", repeat(20, 30)), daily("Amazon Bedrock", [...repeat(0, 29), 12.5]));
  const found = only(run(days));
  assert.deepEqual([found.service, found.kind, found.medianUsd, found.madUsd, found.costUsd, found.increaseUsd, found.baselineDays], ["Amazon Bedrock", "new", 0, 0, 12.5, 12.5, 29]);
  assert.equal(found.monthlyIfContinuesUsd, 375);
});

test("new spend under the floor is not flagged, and a service that stopped is not an anomaly", () => {
  const days = together(daily("Amazon EC2", repeat(20, 30)), daily("Amazon Bedrock", [...repeat(0, 29), 0.99]));
  assert.deepEqual(run(days).anomalies, []);
  const stopped = together(daily("Amazon EC2", repeat(20, 30)), daily("Old thing", [...repeat(8, 29), 0]));
  assert.deepEqual(run(stopped).anomalies, []);
});

test("a service that appears only on the latest day is new spend even though no earlier day lists it", () => {
  const days = together(daily("Amazon EC2", repeat(20, 30)), [{ day: "2026-09-30", costs: { "AWS Shield": 3000 } }]);
  assert.equal(only(run(days)).kind, "new");
});

// ---- History ----

test("with fewer than 7 earlier days nothing is judged, and the report says why", () => {
  const six = run(daily("S", [...repeat(1, 6), 500]));
  assert.equal(six.status, "not-enough-history");
  assert.deepEqual(six.anomalies, []);
  assert.equal(six.baselineDaysFound, 6);
  assert.equal(six.latestDay, "2026-09-30");
  const seven = run(daily("S", [...repeat(1, 7), 500]));
  assert.equal(seven.status, "ok", "seven earlier days is enough");
  assert.equal(only(seven).baselineDays, 7);
});

test("no days at all, or only days still in progress, is no data and not an error", () => {
  assert.equal(run([]).status, "no-data");
  assert.equal(run([{ day: TODAY, costs: { S: 5 } }]).status, "no-data");
  assert.deepEqual(run([]).anomalies, []);
});

test("days that Cost Explorer returned nothing for are not counted as days", () => {
  // Thirty-two days asked for, ten of them missing from the answer entirely: twenty-two remain, 21 of them baseline.
  const all = daily("S", [...repeat(10, 31), 40]);
  const kept = all.filter((_, i) => i < 12 || i > 21);
  const report = run(kept);
  assert.equal(report.baseline!.days, kept.length - 1);
  assert.equal(only(report).baselineDays, kept.length - 1);
});

// ---- The day in progress ----

test("the current day is never judged and never part of the baseline, however large it is", () => {
  const days = [...daily("S", repeat(10, 30)), { day: TODAY, costs: { S: 900 } }, { day: "2026-10-02", costs: { S: 900 } }];
  const report = run(days);
  assert.deepEqual(report.anomalies, []);
  assert.equal(report.latestDay, "2026-09-30");
  assert.equal(report.baseline!.to, "2026-09-29");
  // And a partial day does not drag the usual cost down: a tiny figure for today changes nothing either.
  assert.deepEqual(run([...daily("S", repeat(10, 29).concat(16)), { day: TODAY, costs: { S: 0.01 } }]).anomalies.map((a) => a.costUsd), [16]);
  // The date is the caller's: the same days one day later judge the day that was "today" before.
  const later = run(days, {}, "2026-10-02");
  assert.equal(later.latestDay, "2026-10-01");
  assert.equal(only(later).costUsd, 900);
});

test("the latest day is the latest complete day Cost Explorer has, even when it is older than yesterday", () => {
  const report = run(daily("S", [...repeat(10, 29), 30], "2026-09-30"));
  assert.equal(report.latestDay, "2026-09-29");
  assert.equal(only(report).day, "2026-09-29");
});

test("an estimated latest day is carried through", () => {
  const days = daily("S", [...repeat(10, 29), 30]);
  days[days.length - 1]!.estimated = true;
  assert.equal(run(days).latestDayEstimated, true);
  assert.equal(run(daily("S", repeat(10, 30))).latestDayEstimated, false);
});

// ---- Weekly patterns ----

/** Daily cost for the 56 days before `today`, from the weekday (0 is Sunday) of each day. */
function weekly(service: string, cost: (weekday: number) => number, today: string): DayCost[] {
  return Array.from({ length: 56 }, (_, i) => {
    const day = addDays(today, i - 56);
    return { day, costs: { [service]: cost(new Date(`${day}T00:00:00Z`).getUTCDay()) } };
  });
}

test("a service that costs more on weekdays than at weekends is not flagged on any ordinary day of the week", () => {
  const weekdays = (d: number) => (d === 0 || d === 6 ? 5 : 20);
  for (let shift = 0; shift < 14; shift++) {
    const today = addDays(TODAY, shift);
    const report = run(weekly("Amazon EC2", weekdays, today), {}, today);
    assert.deepEqual(report.anomalies, [], `the day before ${today}`);
  }
});

test("the same holds when the weekday cost has ordinary noise", () => {
  const noisy = (d: number) => (d === 0 || d === 6 ? 5 : 20) + [0, 0.5, -0.5, 1, -1][(d * 3) % 5]!;
  for (let shift = 0; shift < 14; shift++) {
    const today = addDays(TODAY, shift);
    assert.deepEqual(run(weekly("S", noisy, today), {}, today).anomalies, [], `the day before ${today}`);
  }
});

test("known limit: a cost that is high on a few days of the week, such as a weekly job, is flagged on those days", () => {
  // The rule cannot tell a weekly pattern from a spike when the busy days are the minority: the usual day is the
  // quiet one, so a busy day is more than half again as much. The README says so.
  const weeklyJob = (d: number) => (d === 6 ? 40 : 5);
  const saturdayTwoWeeks = "2026-10-04";
  assert.equal(new Date("2026-10-03T00:00:00Z").getUTCDay(), 6);
  assert.equal(only(run(weekly("Nightly export", weeklyJob, saturdayTwoWeeks), {}, saturdayTwoWeeks)).day, "2026-10-03");
  const sunday = "2026-10-05";
  assert.deepEqual(run(weekly("Nightly export", weeklyJob, sunday), {}, sunday).anomalies, [], "and not on the days around it");
});

// ---- Rounding, merging ----

test("figures are judged in whole cents, and what is shown is what was judged", () => {
  const found = only(run(daily("S", [...repeat(10.004, 29), 16.006])));
  assert.equal(found.medianUsd, 10);
  assert.equal(found.costUsd, 16.01);
  assert.equal(found.increaseUsd, 6.01);
  assert.equal(found.monthlyIfContinuesUsd, 180.3);
  assert.equal(Math.round((found.costUsd - found.medianUsd) * 100) / 100, found.increaseUsd);
});

test("pages of one answer merge by day, adding a day's services together and oldest first", () => {
  const merged = mergeDays([
    { day: "2026-09-02", costs: { A: 1 } },
    { day: "2026-09-01", costs: { A: 2, B: 3 } },
    { day: "2026-09-01", costs: { B: 1, C: 4 }, estimated: true },
  ]);
  assert.deepEqual(merged, [
    { day: "2026-09-01", costs: { A: 2, B: 4, C: 4 }, estimated: true },
    { day: "2026-09-02", costs: { A: 1 } },
  ]);
});

// ---- What is printed ----

const CONTEXT = { accountId: "123456789012", days: 30, requests: 1 };
const spiking = () => run(together(daily("Amazon EC2", [...repeat(12.3, 29), 45.2]), daily("Amazon S3", repeat(3, 30)), daily("Amazon Bedrock", [...repeat(0, 29), 8])));

test("the text names the service, the day, the cost, the usual cost, the rise and the 30-day sum as a condition", () => {
  const text = renderAnomalies(spiking(), CONTEXT);
  assert.match(text, /^Spend anomalies for AWS account 123456789012$/m);
  assert.match(text, /2 services cost more than usual on 2026-09-30:/);
  assert.match(text, /1\. Amazon EC2\n\s+2026-09-30\s+\$45\.20\n\s+usual day\s+\$12\.30\s+\(median of the 29 days before\)\n\s+difference\s+\+\$32\.90 a day; if this continues, about \+\$987\.00 over 30 days/);
  assert.match(text, /2\. Amazon Bedrock\n.*\n\s+usual day\s+\$0\.00\s+\(no cost at all in the 29 days before: new spend\)/);
  assert.match(text, /Total: \+\$40\.90 a day more than usual across 2 services\. If all of it continued, that would add up to about \$1227\.00 over 30 days\./);
  assert.match(text, /Judged: 2026-09-30, the latest complete day, against the 29 days before it \(2026-09-01 to 2026-09-29\)\./);
  assert.match(text, /not a forecast/);
  assert.match(text, /Cost Explorer requests made: 1 \(AWS charges \$0\.01 each\)\./);
  // Never worded as a fact.
  assert.doesNotMatch(text, /will (cost|add|spend)|you will|wasted|saves?\b/i);
});

test("the text says the day in progress is left out and that the last days can still change", () => {
  const text = renderAnomalies(spiking(), CONTEXT);
  assert.match(text, /Today \(2026-10-01\) is still in progress and is not used\./);
  assert.match(text, /Cost Explorer can take a day or two to settle, so the figures for the last day or two may still change\./);
  assert.doesNotMatch(text, /marks .* as an estimate/);
  const days = daily("S", repeat(10, 30));
  days[29]!.estimated = true;
  assert.match(renderAnomalies(run(days), CONTEXT), /AWS still marks 2026-09-30 as an estimate\./);
  assert.match(renderAnomalies(run(daily("S", repeat(10, 30), "2026-09-30"), {}, TODAY), CONTEXT), /Cost Explorer had no data after 2026-09-29 yet\./);
});

test("when nothing is unusual it says so in one calm line", () => {
  const text = renderAnomalies(run(daily("Amazon EC2", repeat(12, 30))), CONTEXT);
  const calm = text.split("\n").filter((l) => l.startsWith("Nothing unusual"));
  assert.deepEqual(calm, ["Nothing unusual on 2026-09-30: no service cost at least $1.00 a day more than its usual day and beyond its normal range (1 service checked)."]);
  assert.doesNotMatch(text, /Total:/);
});

test("with too little history, or none, it says that and not that nothing is unusual", () => {
  const little = renderAnomalies(run(daily("S", [...repeat(1, 3), 9])), CONTEXT);
  assert.match(little, /Not enough history to judge: 3 complete days before 2026-09-30, and at least 7 are needed to say what a usual day costs\. Nothing was flagged\./);
  assert.doesNotMatch(little, /Nothing unusual/);
  const none = renderAnomalies(run([]), CONTEXT);
  assert.match(none, /Cost Explorer returned no cost data for those days, so nothing was judged\./);
  assert.doesNotMatch(none, /Today \(/, "with no day found there is nothing to say about the days around it");
});

test("a replay prints that no request was made", () => {
  assert.match(renderAnomalies(spiking(), { ...CONTEXT, requests: 0 }), /Cost Explorer requests made: 0 \(read from the recording\)\./);
});

test("the JSON has a documented shape: the charge, the rule, the days and every anomaly", () => {
  const json = JSON.parse(JSON.stringify(anomaliesJson(spiking(), CONTEXT)));
  assert.deepEqual(Object.keys(json), [
    "command", "accountId", "charge", "status", "today", "windowDays", "latestDay", "latestDayEstimated", "baseline", "baselineDaysFound",
    "servicesChecked", "rule", "anomalies", "totalIncreaseUsd", "totalMonthlyIfContinuesUsd", "note",
  ]);
  assert.equal(json.command, "anomalies");
  assert.deepEqual(json.charge, { requests: 1, usdPerRequest: 0.01, notice: CHARGE_NOTICE });
  assert.deepEqual(json.rule, { sensitivity: 3, minIncreaseUsd: 1, madScale: 1.4826, flatRise: 0.5, minBaselineDays: 7, projectionDays: 30 });
  assert.deepEqual(json.baseline, { days: 29, from: "2026-09-01", to: "2026-09-29" });
  assert.deepEqual([json.status, json.today, json.latestDay, json.windowDays, json.servicesChecked], ["ok", "2026-10-01", "2026-09-30", 30, 3]);
  assert.deepEqual(Object.keys(json.anomalies[0]), ["service", "kind", "day", "costUsd", "medianUsd", "madUsd", "increaseUsd", "monthlyIfContinuesUsd", "baselineDays"]);
  assert.deepEqual([json.totalIncreaseUsd, json.totalMonthlyIfContinuesUsd], [40.9, 1227]);
  // A run that could not judge has the same keys, an empty list and nulls where there is no day.
  const empty = JSON.parse(JSON.stringify(anomaliesJson(run([]), CONTEXT)));
  assert.deepEqual([empty.status, empty.latestDay, empty.baseline, empty.anomalies], ["no-data", null, null, []]);
  assert.deepEqual(Object.keys(empty), Object.keys(json));
});
