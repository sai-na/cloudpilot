#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Command } from "commander";
import { buildTools, forModel, MCP_INSTRUCTIONS, MissingCredentialsError, type Provider, type ToolSpec } from "./advisor.js";
import { ask, describeApiError, resolveProvider, summarize } from "./assistant.js";
import { callerAccount, collect, enabledRegions, readCpu } from "./collect.js";
import { compareScans, isScanResult } from "./compare.js";
import { detect, mergeScans } from "./detect.js";
import { loadEnvFile } from "./env.js";
import { evaluate, renderEvaluation } from "./evaluate.js";
import { renderHtml } from "./html.js";
import { collectCluster, kubectlReader, parsePrometheusRef, type KubeReader } from "./kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "./kube-detect.js";
import { serveMcp } from "./mcp.js";
import { deliver, freshFindings, httpSender, notifyUrls, parseTargets, subjectOf, type Notice, type Target } from "./notify.js";
import { allowedValues, unsupportedValues, type Allowed } from "./output-check.js";
import { fetchPrices, isEmpty, loadPriceFile, noPrices } from "./pricing.js";
import {
  enableRedaction,
  loadManifest,
  mode,
  NotRecordedError,
  redact,
  REDACTED_ACCOUNT,
  replayMiss,
  saveRecording,
  sessionIdFor,
  startLive,
  startRecord,
  startReplay,
} from "./recording.js";
import { money, renderMarkdown, renderPlainText, renderText, type ReportOptions, templatedSummary } from "./report.js";
import type { ClusterPrices, Inventory, PriceBook, RegionScan, ScanResult } from "./types.js";
import { DEFAULT_EVERY, parseEvery, parseMaxRuns, reasonOf, sleep, watch } from "./watch.js";

const LAST_SCAN = ".cloudpilot/last-scan.json";

const NOTIFY_HELP =
  "tell this Slack, Discord or other https webhook what is new (repeatable; or CLOUDPILOT_NOTIFY, comma-separated). The URL is a secret and is never printed";

/** Regions read at the same time. Enough to finish an account in seconds without tripping API throttles. */
const REGIONS_AT_ONCE = 6;

// API keys may live in a .env file next to where the command is run.
loadEnvFile(".env");

interface CommonOptions {
  profile?: string;
  region?: string;
  allRegions?: boolean;
  lookbackHours: string;
  priceFile?: string;
  offline?: boolean;
  model?: string;
  provider?: Provider;
  bedrockProfile?: string;
  bedrockRegion?: string;
  record?: string;
  replay?: string;
  liveLlm?: boolean;
  redactAccount?: boolean;
  /** Set once the notify targets are settled, so a replay's banner can say it still sends them. */
  notifying?: boolean;
}

/** What to scan: one named region, or every enabled one (region null). */
interface Scope {
  /** Where the account-level lookups (identity, list of regions) are sent. */
  homeRegion: string;
  region: string | null;
}

const llmOptions = (options: CommonOptions, homeRegion: string) => ({
  model: options.model,
  provider: options.provider,
  bedrockProfile: options.bedrockProfile,
  bedrockRegion: options.bedrockRegion ?? homeRegion,
});

/** Progress and warnings go to stderr so stdout stays clean for --json. */
const note = (message: string) => process.stderr.write(`${message}\n`);

/** Raised after the reason has already been printed. */
class Stop extends Error {}

const collectUrls = (value: string, previous: string[] = []) => [...previous, value];

/** The webhooks to tell, from --notify or CLOUDPILOT_NOTIFY. Settled before anything is read, so a typo costs no scan. */
const notifyTargets = (option: string[] | undefined): Target[] => parseTargets(notifyUrls(option));

/** The names of the targets, which is all that is ever shown of them. */
const hostsOf = (targets: Target[]) => targets.map((t) => t.host).join(", ");

/**
 * Send a notice once, for a scan that runs once. Says what happened on stderr
 * and returns whether every target has the message; a failure also sets the
 * exit code, so a cron job or CI step cannot take a lost message for a quiet day.
 */
async function notifyOnce(targets: Target[], notice: Notice | undefined): Promise<boolean> {
  if (targets.length === 0) return true;
  if (!notice) {
    note(`Nothing new, so nothing was sent to ${hostsOf(targets)}.`);
    return true;
  }
  const { failures } = await deliver(targets, notice, httpSender, new AbortController().signal);
  if (failures.length > 0) {
    note(`Could not send the message: ${failures.join("; ")}. The findings stay new for the next run.`);
    process.exitCode = 1;
    return false;
  }
  note(`Sent to ${hostsOf(targets)}.`);
  return true;
}

/** What a one-shot scan owes its targets: the new findings, or the full report when there was nothing to compare with. */
function findingsNotice(result: ScanResult, compared: boolean, banner?: string): Notice | undefined {
  const notice: Notice = { kind: "findings", result, first: !compared, banner };
  return freshFindings(result, !compared).length > 0 ? notice : undefined;
}

/** A check that failed is a message of its own: silence must only ever mean that nothing is new. */
async function notifyFailed(targets: Target[], subject: string, err: unknown): Promise<void> {
  if (targets.length === 0) return;
  const notice: Notice = { kind: "failed", subject, reason: reasonOf(err), at: new Date().toISOString(), watching: false };
  const { failures } = await deliver(targets, notice, httpSender, new AbortController().signal);
  note(failures.length > 0 ? `Could not send the message that the check failed: ${failures.join("; ")}.` : `Told ${hostsOf(targets)} that the check failed.`);
}

/**
 * Run part of a check with its targets told if it throws. Everything a check
 * needs before it can read anything - which cluster kubectl points at, for one
 * - belongs in here too: a failure there is just as much a failed check, and
 * going quiet on it would make silence mean something other than "nothing new".
 */
async function notifying<T>(targets: Target[], subject: () => string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    await notifyFailed(targets, subject(), err);
    throw err;
  }
}

/** What a cluster check is about before its context is known: whatever was asked for. */
const contextSubject = (context: string | undefined) => `cluster ${context ?? "(the current context)"}`;

/**
 * Put the run into live, record or replay mode and settle what it scans.
 * A replay announces itself here, before anything else is printed.
 */
function begin(options: CommonOptions, command: "scan" | "ask", question: string | undefined, json: boolean): { banner?: string; scope: Scope } {
  const redactAccount = Boolean(options.redactAccount);
  if (options.record && options.replay) throw new Error("Use --record or --replay, not both.");
  if (options.liveLlm && !options.replay) throw new Error("--live-llm only applies to --replay.");
  if (options.region && options.allRegions) throw new Error("Use --region or --all-regions, not both.");

  if (!options.replay) {
    const scope: Scope = {
      homeRegion: options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
      region: options.region ?? null,
    };
    if (options.record) {
      startRecord(options.record, { id: sessionIdFor(command, question), command, question, ...scope }, { redact: redactAccount });
    } else {
      startLive({ redact: redactAccount });
    }
    return { scope };
  }

  const manifest = loadManifest(options.replay);
  let session = manifest.sessions.find((s) => s.id === sessionIdFor(command, question));
  if (!session && command === "ask") {
    const scan = manifest.sessions.find((s) => s.id === "scan");
    if (options.liveLlm && scan) {
      // A new question: AWS comes from the recorded scan, the model answers live.
      session = scan;
    } else {
      const recorded = manifest.sessions.filter((s) => s.command === "ask").map((s) => `  - ${s.question}`);
      note(["This question was not recorded. Recorded questions:", ...(recorded.length ? recorded : ["  (none)"])].join("\n"));
      throw new Stop();
    }
  }
  if (!session) throw new Error(`${options.replay} holds no recorded ${command}. Record one with --record first.`);

  startReplay(options.replay, session, { redact: redactAccount, liveLlm: Boolean(options.liveLlm) });
  enableRedaction(manifest.accountId);
  const account = redactAccount ? REDACTED_ACCOUNT : manifest.accountId;
  const where = session.regions.length === 1 ? `region ${session.regions[0]}` : `${session.regions.length} regions`;
  const tail = `${options.liveLlm ? "No live AWS calls; the model is called live." : "No live calls."}${options.notifying ? " Notifications are still sent." : ""}`;
  const banner = `REPLAY MODE: recorded ${session.recordedAt} from account ${account}, ${where}. ${tail}`;
  if (json) note(banner);
  else console.log(`${banner}\n`);
  return { banner, scope: { homeRegion: session.homeRegion, region: session.region } };
}

interface CompareOptions {
  compare?: string | false;
  replay?: string;
  record?: string;
}

/**
 * The earlier scan to compare with. By default that is the last scan made
 * from this directory, so a repeat scan says what changed without being asked.
 */
async function previousScan(options: CompareOptions, saved = LAST_SCAN): Promise<ScanResult | undefined> {
  if (options.compare === false) return undefined;
  const explicit = typeof options.compare === "string";
  // A replay repeats a recording exactly, and a recording has to replay as it
  // ran: the saved last scan is local state no recording can carry, so neither
  // mode picks one up by itself. Both still compare when told what to compare with.
  if (!explicit && (options.replay || options.record)) return undefined;
  const path = explicit ? (options.compare as string) : saved;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (explicit) throw new Error(`Cannot read ${path} to compare with: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
  if (isScanResult(parsed)) return parsed;
  if (explicit) throw new Error(`${path} is not a CloudPilot scan result (save one with --json).`);
  return undefined;
}

/**
 * Why a report has no comparison to show, so it never claims there was no
 * earlier scan when there was one it did not or could not use.
 */
function noComparisonReason(options: CompareOptions, previous: ScanResult | undefined, compared: ScanResult | undefined): ReportOptions["noComparison"] {
  if (compared) return undefined;
  // An earlier scan was read but could not be used: only a different account gets that far.
  if (previous) return "not-comparable";
  return options.compare === false || options.replay || options.record ? "off" : undefined;
}

/** Run a task per item, a few at a time, keeping the results in the order of the items. */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function pricesFor(inventory: Inventory, options: CommonOptions): Promise<PriceBook> {
  if (isEmpty(inventory)) return noPrices(inventory.region);
  const fromFile = async (path: string) => {
    const book = await loadPriceFile(path);
    if (book.region !== inventory.region) {
      throw new Error(`${path} holds prices for ${book.region}, but ${inventory.region} has resources to price as well.`);
    }
    return book;
  };
  if (options.offline) {
    if (!options.priceFile) throw new Error("--offline needs --price-file.");
    return fromFile(options.priceFile);
  }
  try {
    return await fetchPrices(inventory, options.profile);
  } catch (err) {
    if (!options.priceFile || mode() === "replay") throw err;
    note(`Live price lookup failed for ${inventory.region} (${err instanceof Error ? err.message : err}); using ${options.priceFile}.`);
    return fromFile(options.priceFile);
  }
}

/**
 * Keep a scan as the baseline the next one compares with. A replay is a
 * recording, not the account as it is now, and a redacted run hides the
 * account ID the comparison needs, so neither may replace it. Skipped quietly
 * where the working directory cannot be written to.
 */
async function saveBaseline(path: string, result: ScanResult, options: { redactAccount?: boolean }): Promise<void> {
  if (mode() === "replay" || options.redactAccount) return;
  await writeBaseline(path, result).catch(() => {});
}

const writeBaseline = (path: string, result: ScanResult) => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, JSON.stringify(result, null, 2)));

/** A baseline kept earlier, or nothing when there is none or it is not a scan this version can compare with. */
async function readBaseline(path: string): Promise<ScanResult | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isScanResult(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `save` false leaves the baseline alone: the caller keeps it until what is new has been delivered. */
async function runScan(options: CommonOptions, command: "scan" | "ask", question?: string, json = false, save = true) {
  const { banner, scope } = begin(options, command, question, json);
  const profile = options.profile;
  const home = { region: scope.homeRegion, profile };

  const accountId = await callerAccount(home);
  enableRedaction(accountId);
  const regions = scope.region ? [scope.region] : await enabledRegions(home);
  const as = profile ? ` as profile ${profile}` : "";
  note(regions.length === 1 ? `Reading ${regions[0]}${as} (read-only)...` : `Reading ${regions.length} regions${as} (read-only)...`);

  let finished = 0;
  const scans = await mapLimit(regions, REGIONS_AT_ONCE, async (region): Promise<RegionScan> => {
    const inventory = await collect({ region, profile, lookbackHours: Number(options.lookbackHours) }, accountId);
    const prices = await pricesFor(inventory, options);
    const findings = detect(inventory, prices);
    if (regions.length > 1) {
      const total = findings.reduce((sum, f) => sum + f.monthlyCostUsd, 0);
      const found = findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}, ${money(total)} a month` : "nothing found";
      const skipped = inventory.warnings.length ? `, ${inventory.warnings.length} check(s) could not run` : "";
      note(`  [${String(++finished).padStart(String(regions.length).length)}/${regions.length}] ${region.padEnd(16)} ${found}${skipped}`);
    }
    return { inventory, prices, findings };
  });

  const result = mergeScans(accountId, scans);
  // The baseline the next scan compares with.
  if (save) await saveBaseline(LAST_SCAN, result, options);
  return { profile, scope, scans, result, banner };
}

/** In record mode, write the capture once the run has finished. */
function finish(result: ScanResult): void {
  if (mode() === "record") note(`Recorded to ${saveRecording({ accountId: result.accountId, regions: result.regions })}`);
}

/**
 * Get model-written text, or the templated summary when there is no model or
 * its text cannot be trusted. The reason is always stated.
 */
async function modelText(run: () => Promise<string>, allowed: Allowed, result: ScanResult): Promise<string> {
  const fallback = (why: string) => {
    note(`${why} Showing the templated summary instead.`);
    return templatedSummary(result, { shortenIds: true });
  };
  let text: string;
  try {
    text = await run();
  } catch (err) {
    if (err instanceof MissingCredentialsError) return fallback("AI explanations are unavailable: no model API key is set.");
    if (err instanceof NotRecordedError) return fallback(err.message);
    return fallback(`AI explanations are unavailable: ${describeApiError(err)}`);
  }
  const miss = replayMiss();
  if (miss) throw miss;
  const bad = unsupportedValues(text, allowed);
  if (bad.length > 0) return fallback(`AI text discarded: it mentioned ${bad.join(", ")}, which is not in the scan data.`);
  return text;
}

function withCommonOptions(command: Command): Command {
  return command
    .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
    .option("--region <region>", "scan only this region")
    .option("--all-regions", "scan every region enabled for the account (the default when --region is not given)")
    .option("--lookback-hours <n>", "hours of CPU history used to judge idleness", "24")
    .option("--price-file <path>", "saved price table to fall back on when the Price List API is unreachable")
    .option("--offline", "use only --price-file for prices")
    .option("--provider <name>", "model provider for the AI summary and ask: anthropic, openai or bedrock (default: whichever key is set)")
    .option("--model <id>", "model for the AI summary and ask")
    .option("--bedrock-profile <name>", "use Claude through Amazon Bedrock with this AWS profile instead of an Anthropic key", process.env.CLOUDPILOT_BEDROCK_PROFILE)
    .option("--bedrock-region <region>", "Bedrock region (defaults to the home region)")
    .option("--record <dir>", "run live and save everything needed to replay this run into <dir>")
    .option("--replay <dir>", "repeat a recorded run from <dir> with no network calls")
    .option("--live-llm", "with --replay: AWS from the recording, the model called live")
    .option("--redact-account", `show the account ID as ${REDACTED_ACCOUNT} in output and recordings`);
}

const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

interface OutputOptions {
  json?: boolean;
  out?: string;
  html?: string;
}

/** Print the report, and write the files that were asked for. */
async function present(result: ScanResult, summary: string, view: ReportOptions, options: OutputOptions, banner?: string): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify({ ...result, summary, ...(banner ? { replay: banner } : {}) }, null, 2));
  } else {
    console.log(renderText(result, view));
    console.log(`\nSummary\n\n${summary}`);
  }
  if (options.out) {
    // Markdown by default; a .txt name gets the terminal report as plain text, ready to email.
    const plain = options.out.toLowerCase().endsWith(".txt");
    await writeFile(options.out, redact(plain ? renderPlainText(result, summary, banner, view) : renderMarkdown(result, summary, banner, view)));
    note(`Report written to ${options.out}`);
  }
  if (options.html) {
    await writeFile(options.html, redact(renderHtml(result, { summary, banner, ...view })));
    note(`HTML report written to ${options.html}`);
  }
}

interface KubeOptions extends OutputOptions {
  context?: string;
  namespace?: string;
  prometheus?: string;
  lookbackHours: string;
  cpuHourUsd?: string;
  memoryGibHourUsd?: string;
  storageGibMonthUsd?: string;
  compare?: string | false;
  onlyNew?: boolean;
  answerKey?: string;
  notify?: string[];
}

/** Read the cluster through kubectl, once, and find the waste in it. */
async function scanCluster(reader: KubeReader, context: string, options: KubeOptions, lookbackHours: number, prices: ClusterPrices): Promise<ScanResult> {
  note(`Reading cluster ${context} through kubectl (read-only)...`);
  const inventory = await collectCluster(reader, {
    namespace: options.namespace,
    prometheus: options.prometheus ? parsePrometheusRef(options.prometheus) : undefined,
    lookbackHours,
  });
  return detectCluster(inventory, prices);
}

/** The saved scan of one cluster, so scanning a second cluster never replaces the first one's baseline. */
const clusterFile = (prefix: string, context: string) => `.cloudpilot/${prefix}-${context.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;

function amount(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} takes a number that is zero or more. Got "${text}".`);
  return value;
}

/** OpenCost's defaults, with whichever prices were given on the command line in their place. */
function clusterPrices(options: KubeOptions): ClusterPrices {
  const given = [options.cpuHourUsd, options.memoryGibHourUsd, options.storageGibMonthUsd].some((v) => v !== undefined);
  if (!given) return OPENCOST_DEFAULTS;
  return {
    source: "command-line",
    cpuHourUsd: options.cpuHourUsd !== undefined ? amount(options.cpuHourUsd, "--cpu-hour-usd") : OPENCOST_DEFAULTS.cpuHourUsd,
    memoryGibHourUsd: options.memoryGibHourUsd !== undefined ? amount(options.memoryGibHourUsd, "--memory-gib-hour-usd") : OPENCOST_DEFAULTS.memoryGibHourUsd,
    storageGibMonthUsd: options.storageGibMonthUsd !== undefined ? amount(options.storageGibMonthUsd, "--storage-gib-month-usd") : OPENCOST_DEFAULTS.storageGibMonthUsd,
  };
}

const program = new Command()
  .name("cloudpilot")
  .description("Read-only agent that finds wasted AWS spend and proposes the fix commands.")
  .version(VERSION);

withCommonOptions(program.command("scan", { isDefault: true }).description("Scan the account and report wasted spend (the default command)"))
  .option("--json", "print the result as JSON instead of a report")
  .option("--out <file>", "also write the report to a file: Markdown, or plain text when the name ends in .txt")
  .option("--html <file>", "also write the report as one self-contained HTML file")
  .option("--explain", "have a model write the summary (needs a model API key; templated otherwise)")
  .option("--compare <file>", "say what changed since this earlier scan (default: the last scan made from this directory)")
  .option("--no-compare", "do not compare with an earlier scan")
  .option("--only-new", "list only the findings that are new since the earlier scan")
  .option("--notify <url>", NOTIFY_HELP, collectUrls)
  .action(async (options: CommonOptions & { json?: boolean; out?: string; html?: string; explain?: boolean; compare?: string | false; onlyNew?: boolean; notify?: string[] }) => {
    const targets = notifyTargets(options.notify);
    if (targets.length > 0 && options.compare === false) throw new Error("--notify needs the comparison to know what is new, so it cannot be used with --no-compare.");
    // Read the earlier scan first: this run saves its own result over it.
    const previous = await previousScan(options);
    // With a webhook to tell, the baseline moves only once it has been told (see below).
    let ran: Awaited<ReturnType<typeof runScan>>;
    try {
      ran = await runScan({ ...options, notifying: targets.length > 0 }, "scan", undefined, Boolean(options.json), targets.length === 0);
    } catch (err) {
      await notifyFailed(targets, previous ? subjectOf(previous) : "your AWS account", err);
      throw err;
    }
    const { result: scanned, banner, scope } = ran;
    const compared = previous ? compareScans(previous, scanned) : undefined;
    if (previous && !compared && typeof options.compare === "string") note("The scan to compare with is of a different account; comparison skipped.");
    const result = compared ?? scanned;
    const view: ReportOptions = { onlyNew: Boolean(options.onlyNew), noComparison: noComparisonReason(options, previous, compared) };

    // Every scan ends with a summary: written by a model on request, built from the findings otherwise.
    const summary = options.explain
      ? await modelText(() => summarize(result, llmOptions(options, scope.homeRegion)), allowedValues(result), result)
      : templatedSummary(result, { shortenIds: true });

    await present(result, summary, view, options, banner);
    // A message that was not delivered leaves the findings new: the saved scan stays as it was, so the next run says them again.
    if (targets.length > 0 && (await notifyOnce(targets, findingsNotice(result, Boolean(compared), banner)))) await saveBaseline(LAST_SCAN, scanned, options);
    finish(result);
  });

program
  .command("kube")
  .description("Scan a Kubernetes cluster for workloads that request more than they use and for unused volumes (read-only, through kubectl)")
  .option("--context <name>", "kubectl context to read (default: the current one)")
  .option("--namespace <name>", "read only this namespace (default: every namespace except the cluster's own)")
  .option("--prometheus <namespace/service:port>", "the Prometheus holding usage history (default: found among the cluster's services)")
  .option("--lookback-hours <n>", "hours of usage history to judge requests by", "168")
  .option("--cpu-hour-usd <n>", "what one vCPU costs per hour on your nodes (default: OpenCost's 0.031611)")
  .option("--memory-gib-hour-usd <n>", "what one GiB of memory costs per hour (default: OpenCost's 0.004237)")
  .option("--storage-gib-month-usd <n>", "what one GiB of storage costs per month (default: OpenCost's 0.04)")
  .option("--json", "print the result as JSON instead of a report")
  .option("--out <file>", "also write the report to a file: Markdown, or plain text when the name ends in .txt")
  .option("--html <file>", "also write the report as one self-contained HTML file")
  .option("--compare <file>", "say what changed since this earlier scan (default: the last scan of this cluster made from this directory)")
  .option("--no-compare", "do not compare with an earlier scan")
  .option("--only-new", "list only the findings that are new since the earlier scan")
  .option("--answer-key <path>", "score the findings against a lab's answer key instead of printing the report")
  .option("--notify <url>", NOTIFY_HELP, collectUrls)
  .action(async (options: KubeOptions) => {
    startLive({ redact: false });
    const targets = notifyTargets(options.notify);
    if (targets.length > 0 && (options.compare === false || options.answerKey)) {
      throw new Error(`--notify needs the comparison to know what is new, so it cannot be used with ${options.answerKey ? "--answer-key" : "--no-compare"}.`);
    }
    const lookbackHours = amount(options.lookbackHours, "--lookback-hours");
    if (lookbackHours === 0) throw new Error("--lookback-hours must be more than zero.");
    const prices = clusterPrices(options);
    const reader = kubectlReader(options.context);
    // Reading which cluster this is can fail on its own (no kubectl, no current context), and that is a failed check too.
    const { context } = await notifying(targets, () => contextSubject(options.context), () => reader.identity());
    const saved = clusterFile("last-kube-scan", context);
    const previous = await previousScan(options, saved);
    const scanned = await notifying(targets, () => `cluster ${context}`, () => scanCluster(reader, context, options, lookbackHours, prices));

    if (options.answerKey) {
      const evaluation = await evaluate(scanned, options.answerKey);
      console.log(renderEvaluation(evaluation));
      if (!evaluation.passed) process.exitCode = 1;
      return;
    }

    // With a webhook to tell, the baseline moves only once it has been told.
    if (targets.length === 0) await saveBaseline(saved, scanned, {});
    const compared = previous ? compareScans(previous, scanned) : undefined;
    if (previous && !compared && typeof options.compare === "string") note("The scan to compare with is of a different cluster; comparison skipped.");
    const result = compared ?? scanned;
    const view: ReportOptions = { onlyNew: Boolean(options.onlyNew), noComparison: noComparisonReason(options, previous, compared) };
    await present(result, templatedSummary(result, { shortenIds: true }), view, options);
    if (targets.length > 0 && (await notifyOnce(targets, findingsNotice(result, Boolean(compared))))) await saveBaseline(saved, scanned, {});
  });

interface WatchCommandOptions extends Omit<CommonOptions, "lookbackHours">, Omit<KubeOptions, "lookbackHours" | "compare" | "onlyNew" | "answerKey" | "json" | "out" | "html"> {
  kube?: boolean;
  every: string;
  maxRuns?: string;
  lookbackHours?: string;
}

/** Options that only mean something for one of the two things that can be watched. */
const AWS_ONLY = ["region", "allRegions", "priceFile", "offline", "replay", "redactAccount"] as const;
const KUBE_ONLY = ["context", "namespace", "prometheus", "cpuHourUsd", "memoryGibHourUsd", "storageGibMonthUsd"] as const;
const FLAG: Record<string, string> = {
  region: "--region", allRegions: "--all-regions", priceFile: "--price-file", offline: "--offline", replay: "--replay", redactAccount: "--redact-account",
  context: "--context", namespace: "--namespace", prometheus: "--prometheus", cpuHourUsd: "--cpu-hour-usd", memoryGibHourUsd: "--memory-gib-hour-usd", storageGibMonthUsd: "--storage-gib-month-usd",
};

program
  .command("watch")
  .description("Scan again and again, and speak up only when something is new (a foreground process: run it under systemd, tmux or a container)")
  .option("--every <interval>", "wait this long between rounds, from 15m to 7d: 30m, 6h, 1d", DEFAULT_EVERY)
  .option("--max-runs <n>", "stop after this many rounds (default: until stopped)")
  .option("--notify <url>", NOTIFY_HELP, collectUrls)
  .option("--kube", "watch the cluster kubectl points at instead of the AWS account")
  .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
  .option("--region <region>", "AWS: scan only this region")
  .option("--all-regions", "AWS: scan every region enabled for the account (the default when --region is not given)")
  .option("--lookback-hours <n>", "hours of history to judge by (default: 24 for AWS, 168 for a cluster)")
  .option("--price-file <path>", "AWS: saved price table to fall back on when the Price List API is unreachable")
  .option("--offline", "AWS: use only --price-file for prices")
  .option("--replay <dir>", "AWS: repeat a recorded run from <dir> with no AWS calls (for tests and demos)")
  .option("--redact-account", `AWS: show the account ID as ${REDACTED_ACCOUNT} in output and messages`)
  .option("--context <name>", "cluster: kubectl context to read (default: the current one, fixed at start)")
  .option("--namespace <name>", "cluster: read only this namespace")
  .option("--prometheus <namespace/service:port>", "cluster: the Prometheus holding usage history (default: found among the cluster's services)")
  .option("--cpu-hour-usd <n>", "cluster: what one vCPU costs per hour on your nodes")
  .option("--memory-gib-hour-usd <n>", "cluster: what one GiB of memory costs per hour")
  .option("--storage-gib-month-usd <n>", "cluster: what one GiB of storage costs per month")
  .action(async (options: WatchCommandOptions) => {
    const everyMs = parseEvery(options.every);
    const maxRuns = options.maxRuns === undefined ? undefined : parseMaxRuns(options.maxRuns);
    const targets = notifyTargets(options.notify);
    for (const key of options.kube ? AWS_ONLY : KUBE_ONLY) {
      if (options[key as keyof WatchCommandOptions] !== undefined) throw new Error(`${FLAG[key]} only applies ${options.kube ? "to the AWS account, not with --kube" : "with --kube"}.`);
    }

    // What differs between watching the account and the cluster: how one round is read, and where what was reported is kept.
    let subject: string;
    let baselinePath: string;
    let scan: () => Promise<{ result: ScanResult; banner?: string }>;
    if (options.kube) {
      startLive({ redact: false });
      const lookbackHours = amount(options.lookbackHours ?? "168", "--lookback-hours");
      if (lookbackHours === 0) throw new Error("--lookback-hours must be more than zero.");
      const prices = clusterPrices(options as KubeOptions);
      // The context in force now, kept for every round: a later `kubectl config use-context` must not move the watch to another cluster.
      // A watch that cannot even start must say so: it is not going to keep trying.
      const { context } = await notifying(targets, () => contextSubject(options.context), () => kubectlReader(options.context).identity());
      const reader = kubectlReader(context);
      subject = `cluster ${context}`;
      baselinePath = clusterFile("watch-kube", context);
      scan = async () => ({ result: await scanCluster(reader, context, options as KubeOptions, lookbackHours, prices) });
    } else {
      const aws: CommonOptions = { ...options, lookbackHours: options.lookbackHours ?? "24", notifying: targets.length > 0 };
      subject = "the AWS account";
      baselinePath = ".cloudpilot/watch-baseline.json";
      scan = async () => {
        const { result, banner } = await runScan(aws, "scan", undefined, false, false);
        return { result, banner };
      };
    }

    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
    note(`Watching ${subject} every ${options.every}, read-only. ${targets.length > 0 ? `Messages go to ${hostsOf(targets)}.` : "No --notify target: results are printed here only."} Ctrl+C stops it.`);

    const end = await watch(
      { everyMs, maxRuns, targets, subject },
      {
        scan,
        baseline: {
          // A redacted run keeps no baseline, as in scan: reading one could put the real account ID in a message.
          load: async () => (options.redactAccount ? undefined : readBaseline(baselinePath)),
          save: async (result) => {
            if (mode() === "replay" || options.redactAccount) return;
            await writeBaseline(baselinePath, result);
          },
        },
        send: httpSender,
        clock: () => new Date(),
        sleep,
        out: (line) => console.log(line),
        err: note,
      },
      stop.signal,
    );
    process.exitCode = end.exitCode;
    // Stopped in the middle of a round: whatever that round had in flight must not keep the process alive.
    if (end.stopped) process.exit(end.exitCode);
  });

withCommonOptions(program.command("eval").description("Scan, then score the findings against a waste-lab answer key"))
  .requiredOption("--manifest <path>", "answer key (lab-manifest.json)")
  .action(async (options: CommonOptions & { manifest: string }) => {
    const { result } = await runScan(options, "scan");
    const evaluation = await evaluate(result, options.manifest);
    console.log(renderEvaluation(evaluation));
    if (!evaluation.passed) process.exitCode = 1;
    finish(result);
  });

withCommonOptions(program.command("ask").description("Ask a question about the account in plain English (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)"))
  .argument("<question...>", "the question")
  .action(async (words: string[], options: CommonOptions) => {
    const question = words.join(" ");
    // Without a model there is nothing to ask: say so before reading anything from AWS.
    if (!options.replay || options.liveLlm) resolveProvider(llmOptions(options, ""));

    const { profile, scope, scans, result } = await runScan(options, "ask", question);
    const inventories = scans.map((s) => s.inventory);
    const prices = scans.map((s) => s.prices);
    const answer = await modelText(
      () =>
        ask(question, {
          result,
          inventories,
          prices,
          llm: llmOptions(options, scope.homeRegion),
          cpuHistory: (region, instanceId, hours) => readCpu({ region, profile }, instanceId, hours),
          onToolUse: (name) => note(`  looking up: ${name}`),
        }),
      allowedValues(result, { inventories, prices }),
      result,
    );
    console.log(answer);
    finish(result);
  });

withCommonOptions(program.command("mcp").description("Run as an MCP server over stdio, for Claude Code, Cursor and other MCP clients"))
  .action(async (options: CommonOptions) => {
    if (options.record) throw new Error("--record is not available for the MCP server.");

    type Scan = Awaited<ReturnType<typeof runScan>>;
    let latest: Scan | undefined;
    let running: Promise<Scan> | undefined;
    // Progress goes to stderr and the replay banner into each result: stdout carries only protocol messages.
    const scan = (region?: string) => {
      running = runScan({ ...options, ...(region ? { region, allRegions: false } : {}) }, "scan", undefined, true).then((s) => (latest = s));
      return running;
    };
    const current = async () => latest ?? (await (running ?? scan()));
    const stamped = (s: Scan, text: string) => (s.banner ? `${s.banner}\n\n${text}` : text);
    const scanned = () => {
      if (!latest) throw new Error("No scan has been run yet.");
      return latest;
    };

    // The same read-only lookups the ask command gives its model, over the latest scan.
    const lookups = buildTools({
      get result() {
        return scanned().result;
      },
      get inventories() {
        return scanned().scans.map((s) => s.inventory);
      },
      get prices() {
        return scanned().scans.map((s) => s.prices);
      },
      cpuHistory: (region, instanceId, hours) => readCpu({ region, profile: options.profile }, instanceId, hours),
    });

    const tools: ToolSpec[] = [
      {
        name: "scan",
        description:
          "Scan the AWS account for wasted spend, read-only, and return a summary plus every finding (resource, evidence, monthly cost in USD, proposed fix commands with their risk). Call this first. Scans every enabled region unless a region is given. The other tools read from the latest scan.",
        inputSchema: {
          type: "object",
          properties: { region: { type: "string", description: "Scan only this region, e.g. ap-south-1. Ignored when the server is replaying a recording." } },
          additionalProperties: false,
        },
        run: async ({ region }) => {
          const s = await scan(typeof region === "string" && region ? region : undefined);
          return stamped(s, `${templatedSummary(s.result)}\n\nFindings as JSON:\n${JSON.stringify(forModel(s.result))}`);
        },
      },
      ...lookups.map((tool) => ({
        ...tool,
        run: async (args: Record<string, unknown>) => {
          const s = await current();
          return stamped(s, await tool.run(args));
        },
      })),
    ];

    await serveMcp({ name: "cloudpilot", version: VERSION, instructions: MCP_INSTRUCTIONS, tools });
    // The client has gone; do not let idle AWS connections keep the process alive.
    process.exit(0);
  });

program.parseAsync().catch((err) => {
  if (!(err instanceof Stop)) note(`cloudpilot: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
