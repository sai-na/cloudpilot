#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Command } from "commander";
import { buildTools, forModel, MCP_CLUSTER_INSTRUCTIONS, MCP_INSTRUCTIONS, MissingCredentialsError, type Provider, type ToolSpec } from "./advisor.js";
import { ask, describeApiError, resolveProvider, summarize } from "./assistant.js";
import { callerAccount, collect, enabledRegions, readCpu } from "./collect.js";
import { compareScans, isScanResult } from "./compare.js";
import { detect, mergeScans } from "./detect.js";
import { loadEnvFile } from "./env.js";
import { evaluate, renderEvaluation } from "./evaluate.js";
import { renderHtml } from "./html.js";
import { collectCluster, kubectlReader, parsePrometheusRef, type ClusterInventory } from "./kube.js";
import { cpuQuantity, detectCluster, memoryQuantity, OPENCOST_DEFAULTS } from "./kube-detect.js";
import { serveMcp } from "./mcp.js";
import { allowedValues, unsupportedValues, type Allowed } from "./output-check.js";
import { awsProbes, KUBECTL_TIMEOUT_MS, preflight, renderPreflight, type PreflightOptions } from "./preflight.js";
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
import { READ_ONLY_POLICY } from "./policy.js";
import { header, money, renderMarkdown, renderPlainText, renderText, type ReportOptions, templatedSummary } from "./report.js";
import type { ClusterPrices, Inventory, PriceBook, RegionScan, ScanResult } from "./types.js";

const LAST_SCAN = ".cloudpilot/last-scan.json";

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

/** The region the account-level lookups go to when none is named. */
const defaultRegion = () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

/** Progress and warnings go to stderr so stdout stays clean for --json. */
const note = (message: string) => process.stderr.write(`${message}\n`);

/** Raised after the reason has already been printed. */
class Stop extends Error {}

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
      homeRegion: options.region ?? defaultRegion(),
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
  const tail = options.liveLlm ? "No live AWS calls; the model is called live." : "No live calls.";
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

async function runScan(options: CommonOptions, command: "scan" | "ask", question?: string, json = false) {
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
  // The baseline the next scan compares with. A replay is a recording, not the
  // account as it is now, and a redacted run hides the account ID the
  // comparison needs, so neither may replace it. Skipped quietly where the
  // working directory cannot be written to.
  if (mode() !== "replay" && !options.redactAccount) {
    await mkdir(dirname(LAST_SCAN), { recursive: true })
      .then(() => writeFile(LAST_SCAN, JSON.stringify(result, null, 2)))
      .catch(() => {});
  }
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
}

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

interface ClusterScanOptions {
  context?: string;
  namespace?: string;
  prometheus?: string;
  lookbackHours: number;
  prices: ClusterPrices;
}

/** Read a cluster and apply the rules. Used by the kube command and by the MCP server. */
async function scanCluster(options: ClusterScanOptions): Promise<{ inventory: ClusterInventory; result: ScanResult }> {
  const inventory = await collectCluster(kubectlReader(options.context), {
    namespace: options.namespace,
    prometheus: options.prometheus ? parsePrometheusRef(options.prometheus) : undefined,
    lookbackHours: options.lookbackHours,
  });
  return { inventory, result: detectCluster(inventory, options.prices) };
}

/**
 * A cluster's workloads as a model should read them: requests and peaks in the
 * units a manifest uses, under the identity of the scan they come from, so a
 * model never reads one cluster's workloads as another's.
 */
function workloadsForModel(inventory: ClusterInventory) {
  const optional = <T>(value: T | undefined, format: (v: T) => string) => (value === undefined ? null : format(value));
  return {
    context: inventory.context,
    namespaces: inventory.namespaces,
    prometheus: inventory.prometheus ?? null,
    lookbackHours: inventory.lookbackHours,
    collectedAt: inventory.collectedAt,
    warnings: inventory.warnings,
    workloads: inventory.workloads.map((w) => ({
      namespace: w.namespace,
      kind: w.kind,
      name: w.name,
      replicas: w.replicas,
      skippedByLabel: w.ignored,
      containers: w.containers.map((c) => ({
        name: c.name,
        cpuRequest: optional(c.cpuRequestCores, cpuQuantity),
        // Peaks are rounded up to a whole millicore or mebibyte, so they never read as less than they were.
        cpuPeak: optional(c.cpuPeakCores, (cores) => cpuQuantity(Math.ceil(cores * 1000 - 1e-9) / 1000)),
        memoryRequest: optional(c.memoryRequestBytes, memoryQuantity),
        memoryPeak: optional(c.memoryPeakBytes, (bytes) => memoryQuantity(Math.ceil(bytes / 2 ** 20 - 1e-9) * 2 ** 20)),
        // Three figures rather than one decimal: a container with minutes of history must not read as having none.
        historyHours: c.historyHours === undefined ? null : Number(c.historyHours.toPrecision(3)),
        killedForMemory: c.oomKilled,
      })),
    })),
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
  .action(async (options: CommonOptions & { json?: boolean; out?: string; html?: string; explain?: boolean; compare?: string | false; onlyNew?: boolean }) => {
    // Read the earlier scan first: this run saves its own result over it.
    const previous = await previousScan(options);
    const { result: scanned, banner, scope } = await runScan(options, "scan", undefined, Boolean(options.json));
    const compared = previous ? compareScans(previous, scanned) : undefined;
    if (previous && !compared && typeof options.compare === "string") note("The scan to compare with is of a different account; comparison skipped.");
    const result = compared ?? scanned;
    const view: ReportOptions = { onlyNew: Boolean(options.onlyNew), noComparison: noComparisonReason(options, previous, compared) };

    // Every scan ends with a summary: written by a model on request, built from the findings otherwise.
    const summary = options.explain
      ? await modelText(() => summarize(result, llmOptions(options, scope.homeRegion)), allowedValues(result), result)
      : templatedSummary(result, { shortenIds: true });

    await present(result, summary, view, options, banner);
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
  .action(async (options: KubeOptions) => {
    startLive({ redact: false });
    const lookbackHours = amount(options.lookbackHours, "--lookback-hours");
    if (lookbackHours === 0) throw new Error("--lookback-hours must be more than zero.");
    const prices = clusterPrices(options);
    const reader = kubectlReader(options.context);
    const { context } = await reader.identity();
    // One saved scan per cluster, so scanning a second cluster never replaces the first one's baseline.
    const saved = `.cloudpilot/last-kube-scan-${context.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
    const previous = await previousScan(options, saved);

    note(`Reading cluster ${context} through kubectl (read-only)...`);
    const { result: scanned } = await scanCluster({ context: options.context, namespace: options.namespace, prometheus: options.prometheus, lookbackHours, prices });

    if (options.answerKey) {
      const evaluation = await evaluate(scanned, options.answerKey);
      console.log(renderEvaluation(evaluation));
      if (!evaluation.passed) process.exitCode = 1;
      return;
    }

    await mkdir(dirname(saved), { recursive: true })
      .then(() => writeFile(saved, JSON.stringify(scanned, null, 2)))
      .catch(() => {});
    const compared = previous ? compareScans(previous, scanned) : undefined;
    if (previous && !compared && typeof options.compare === "string") note("The scan to compare with is of a different cluster; comparison skipped.");
    const result = compared ?? scanned;
    const view: ReportOptions = { onlyNew: Boolean(options.onlyNew), noComparison: noComparisonReason(options, previous, compared) };
    await present(result, templatedSummary(result, { shortenIds: true }), view, options);
  });

program
  .command("init")
  .description("Check that a scan will work from here and say what is missing: credentials, read access, kubectl, Prometheus (creates and changes nothing)")
  .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
  .option("--region <region>", "try the AWS reads in this region (default: the region a scan starts from)")
  .option("--context <name>", "kubectl context to check (default: the current one)")
  .option("--prometheus <namespace/service:port>", "the Prometheus holding usage history (default: found among the cluster's services)")
  .option("--json", "print the result as JSON")
  .option("--print-policy", "print the read-only IAM policy a scan needs, as JSON, and stop")
  .action(async (options: { profile?: string; region?: string; context?: string; prometheus?: string; json?: boolean; printPolicy?: boolean }) => {
    if (options.printPolicy) {
      console.log(JSON.stringify(READ_ONLY_POLICY, null, 2));
      return;
    }
    startLive({ redact: false });
    const checking: PreflightOptions = {
      region: options.region ?? defaultRegion(),
      regionGiven: Boolean(options.region),
      profile: options.profile,
      context: options.context,
      prometheus: options.prometheus ? parsePrometheusRef(options.prometheus) : undefined,
    };
    const result = await preflight(checking, { aws: awsProbes(checking), kube: kubectlReader(options.context, KUBECTL_TIMEOUT_MS) });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderPreflight(result, checking));
    process.exitCode = result.ready ? 0 : 1;
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

    // Clusters. A recording holds an AWS account only, so a replaying server has no cluster to offer.
    const offersCluster = !options.replay;
    if (offersCluster) {
      type ClusterScan = Awaited<ReturnType<typeof scanCluster>>;
      let cluster: ClusterScan | undefined;
      let scanning: Promise<ClusterScan> | undefined;
      const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
      const readCluster = (args: Record<string, unknown>) => {
        const hours = Number(args.lookback_hours);
        const pending = scanCluster({
          context: text(args.context),
          namespace: text(args.namespace),
          prometheus: text(args.prometheus),
          lookbackHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168,
          prices: OPENCOST_DEFAULTS,
        }).then((scanned) => (cluster = scanned));
        // A failed scan leaves nothing behind to hand the next caller.
        const settled = () => {
          if (scanning === pending) scanning = undefined;
        };
        scanning = pending;
        pending.then(settled, settled);
        return pending;
      };
      // Calls arrive concurrently: a scan already under way is the scan to read, never a second one.
      const currentCluster = async () => cluster ?? (await (scanning ?? readCluster({})));
      tools.push(
        {
          name: "scan_cluster",
          description:
            "Scan a Kubernetes cluster for waste, read-only through kubectl, and return a summary plus every finding: workloads that request more CPU or memory than they use (with the kubectl command that lowers the request and the old values as the way back), volume claims no pod mounts, and Released volumes. Reads the current kubectl context unless one is given. Usage comes from the cluster's Prometheus. Costs use the OpenCost project's default unit prices, which the result states.",
          inputSchema: {
            type: "object",
            properties: {
              context: { type: "string", description: "kubectl context to read. Default: the current one." },
              namespace: { type: "string", description: "Read only this namespace. Default: every namespace except the cluster's own." },
              prometheus: { type: "string", description: "Where usage history is, as namespace/service:port. Default: found among the cluster's services." },
              lookback_hours: { type: "integer", description: "Hours of usage history to judge requests by. Default 168 (a week)." },
            },
            additionalProperties: false,
          },
          run: async (args) => {
            const { result } = await readCluster(args);
            return `${header(result).join("\n")}\n\n${templatedSummary(result)}\n\nFindings as JSON:\n${JSON.stringify(forModel(result))}`;
          },
        },
        {
          name: "get_cluster_workloads",
          description:
            "Return the kubectl context, namespaces, Prometheus, lookback and time of the latest cluster scan, whatever it could not read (warnings), and every Deployment, StatefulSet and DaemonSet it read, including those NOT flagged: replicas, and for each container its CPU and memory request, its peak use over the history Prometheus holds, how many hours of history that is, and whether it has been killed for running out of memory. Use it to answer what a workload asks for and uses, or why one was not flagged. A warning means the list is incomplete: say so rather than calling a workload absent. Runs scan_cluster with its defaults first if no cluster has been scanned yet.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          run: async () => JSON.stringify(workloadsForModel((await currentCluster()).inventory)),
        },
      );
    }

    // The instructions name only the tools this server offers: a replaying one must not promise a cluster scan.
    const instructions = offersCluster ? `${MCP_INSTRUCTIONS}\n${MCP_CLUSTER_INSTRUCTIONS}` : MCP_INSTRUCTIONS;
    await serveMcp({ name: "cloudpilot", version: VERSION, instructions, tools });
    // The client has gone; do not let idle AWS connections keep the process alive.
    process.exit(0);
  });

program.parseAsync().catch((err) => {
  if (!(err instanceof Stop)) note(`cloudpilot: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
