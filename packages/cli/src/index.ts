#!/usr/bin/env node
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { buildTools, clusterWorkloads, forModel, MCP_CLUSTER_INSTRUCTIONS, MCP_INSTRUCTIONS, MissingCredentialsError, type Provider, type ToolSpec } from "./advisor.js";
import { ask, describeApiError, resolveProvider, summarize } from "./assistant.js";
import { anomaliesJson, CHARGE_NOTICE, DEFAULT_DAYS, DEFAULT_MIN_INCREASE_USD, DEFAULT_SENSITIVITY, findAnomalies, MAX_DAYS, MIN_DAYS, renderAnomalies, REPLAY_CHARGE_NOTICE, type AnomalyReport, type AnomalyRule } from "./anomaly.js";
import { apply, ApplyError, isAuditEntry, plan, programRunner, renderAudit, type AuditEntry } from "./apply.js";
import { callerAccount, collect, enabledRegions, mapLimit, readBill, readCpu, readDailyCosts } from "./collect.js";
import { compareScans, isScanResult } from "./compare.js";
import { detect, mergeScans, withBill } from "./detect.js";
import { loadEnvFile } from "./env.js";
import { evaluate, renderEvaluation } from "./evaluate.js";
import { renderHtml } from "./html.js";
import { now } from "./clock.js";
import { collectCluster, inCluster, kubectlReader, parseClusterName, parsePrometheusRef, type ClusterInventory, type KubeReader } from "./kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "./kube-detect.js";
import { serveMcp } from "./mcp.js";
import { deliver, freshFindings, httpSender, notifyUrls, parseTargets, subjectOf, type Notice, type Target } from "./notify.js";
import { allowedValues, unsupportedValues, type Allowed } from "./output-check.js";
import { awsProbes, KUBECTL_TIMEOUT_MS, preflight, renderPreflight, type PreflightOptions } from "./preflight.js";
import { fetchPrices, isEmpty, loadPriceFile, noPrices } from "./pricing.js";
import {
  type ClusterSession,
  enableRedaction,
  kubeReader,
  loadManifest,
  mode,
  NotRecordedError,
  redact,
  REDACTED_ACCOUNT,
  replayMiss,
  saveClusterRecording,
  saveRecording,
  type SessionMeta,
  sessionIdFor,
  startLive,
  startRecord,
  startReplay,
} from "./recording.js";
import { READ_ONLY_POLICY } from "./policy.js";
import { advisoryDigest, header, money, renderMarkdown, renderPlainText, renderText, type ReportOptions, templatedSummary } from "./report.js";
import type { ClusterPrices, Inventory, PriceBook, RegionScan, ScanResult } from "./types.js";
import { httpUploader, parseDestination, scanJson, TOKEN_VARIABLE, upload, type Destination } from "./upload.js";
import { DEFAULT_EVERY, parseEvery, parseMaxRuns, reasonOf, sleep, watch } from "./watch.js";

const LAST_SCAN = ".cloudpilot/last-scan.json";

const NOTIFY_HELP =
  "tell this Slack, Discord or other https webhook what is new (repeatable; or CLOUDPILOT_NOTIFY, comma-separated). The URL is a secret and is never printed";

const NO_ADVISORIES_HELP =
  "leave out the advisories: the things to look at that are not waste (out-of-memory kills, restarts, missing requests, pods that cannot be scheduled, spare node capacity). Also skips reading the cluster's nodes";

const UPLOAD_HELP = `send each scan's full result as JSON to this https address, the hosted service's upload endpoint. The token for it is read only from ${TOKEN_VARIABLE}, never from a flag, because a flag ends up in shell history and in the process list`;

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
  bill?: boolean;
}

/** What to scan: one named region, or every enabled one (region null). */
interface Scope {
  /** Where the account-level lookups (identity, list of regions) are sent. */
  homeRegion: string;
  region: string | null;
}

/** Where AWS calls go when no region is named. */
const defaultRegion = () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

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

interface UploadGuard {
  upload?: string;
  replay?: string;
  redactAccount?: boolean;
  answerKey?: string;
}

/**
 * Where --upload sends scans, settled before anything is read. What would put
 * the wrong thing into the hosted history is refused here, and says why.
 */
function uploadDestination(options: UploadGuard): Destination | undefined {
  if (options.upload === undefined) return undefined;
  if (options.replay) throw new Error("--upload cannot be used with --replay: a recording is not the account as it is now, and uploading it would put old findings into the hosted history as if they were current.");
  if (options.redactAccount) throw new Error("--upload cannot be used with --redact-account: the stand-in account ID is the same for every account, so the hosted history would merge different accounts into one.");
  if (options.answerKey) throw new Error("--upload cannot be used with --answer-key: that run scores a lab against its answer key and keeps no scan, and a lab is not a cluster whose history is worth keeping.");
  const destination = parseDestination(options.upload, process.env[TOKEN_VARIABLE]);
  // Held in memory from here on: kubectl and the AWS credential helpers a scan starts must not inherit it.
  delete process.env[TOKEN_VARIABLE];
  return destination;
}

/**
 * Upload the result of a scan that runs once, and say what came of it on
 * stderr. A failure also sets the exit code, after the report has been printed,
 * so a cron job or CI step cannot take a missing scan for a stored one.
 */
async function uploadOnce(destination: Destination | undefined, body: () => object): Promise<void> {
  if (!destination) return;
  const outcome = await upload(destination, JSON.stringify(body()), { send: httpUploader, pause: sleep }, new AbortController().signal);
  note(outcome.line);
  if (!outcome.ok) process.exitCode = 1;
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

/**
 * What a cluster check is about before its context is known: whatever was
 * asked for. Inside a cluster there is no context to name, so the name given
 * for the cluster stands in for one: a failure before the first read still
 * says which cluster could not be read. Anywhere else that name is going to be
 * ignored, and naming a cluster that was never going to be read would be worse
 * than saying only which cluster kubectl would have chosen.
 */
const contextSubject = (options: { context?: string; clusterName?: string }) =>
  `cluster ${options.context || (inCluster() ? clusterNameGiven(options) : undefined) || "(the current context)"}`;

/** What a replay of this kind of run is called when the recording has none. */
const RECORDED_AS: Record<SessionMeta["command"], string> = { scan: "scan", ask: "ask", kube: "cluster scan", "kube-ask": "cluster question", anomalies: "spend anomalies check" };

/**
 * The recorded session a replay repeats. A question the recording does not
 * hold is refused, unless the model is live: then the recorded scan is the
 * session to read from, and the model answers the new question.
 */
function replaySession(dir: string, command: SessionMeta["command"], question: string | undefined, liveLlm: boolean) {
  const manifest = loadManifest(dir);
  let session = manifest.sessions.find((s) => s.id === sessionIdFor(command, question));
  if (!session && (command === "ask" || command === "kube-ask")) {
    const scan = manifest.sessions.find((s) => s.id === (command === "ask" ? "scan" : "kube"));
    const recorded = manifest.sessions.filter((s) => s.command === command).map((s) => `  - ${s.question}`);
    if (liveLlm && scan) {
      // A new question: the scan comes from the recording, the model answers live.
      session = scan;
    } else if (scan || recorded.length) {
      // The recording is of this kind of run, so what is missing is the question itself.
      note(["This question was not recorded. Recorded questions:", ...(recorded.length ? recorded : ["  (none)"])].join("\n"));
      throw new Stop();
    }
  }
  if (!session) throw new Error(`${dir} holds no recorded ${RECORDED_AS[command]}. Record one with --record first.`);
  return { manifest, session };
}

/** Say that a run is a replay, before anything else is printed. */
function announce(banner: string, json: boolean): void {
  if (json) note(banner);
  else console.log(`${banner}\n`);
}

/** What a replay banner says about live calls: the same words for an account and for a cluster, and a replay that was given --notify still sends. */
const replayTail = (what: "AWS" | "kubectl", options: { liveLlm?: boolean; notifying?: boolean }) =>
  `${options.liveLlm ? `No live ${what} calls; the model is called live.` : "No live calls."}${options.notifying ? " Notifications are still sent." : ""}`;

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

  const { manifest, session } = replaySession(options.replay, command, question, Boolean(options.liveLlm));
  if (session.command !== "scan" && session.command !== "ask") throw new Error(`${options.replay} holds no recorded ${RECORDED_AS[command]}. Record one with --record first.`);
  if (!manifest.accountId) throw new Error(`${options.replay} holds no recorded account. Record one with --record first.`);

  startReplay(options.replay, session, { redact: redactAccount, liveLlm: Boolean(options.liveLlm) });
  enableRedaction(manifest.accountId);
  const account = redactAccount ? REDACTED_ACCOUNT : manifest.accountId;
  const where = session.regions.length === 1 ? `region ${session.regions[0]}` : `${session.regions.length} regions`;
  const tail = replayTail("AWS", options);
  const banner = `REPLAY MODE: recorded ${session.recordedAt} from account ${account}, ${where}. ${tail}`;
  announce(banner, json);
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

  const merged = mergeScans(accountId, scans);
  // Cost Explorer charges for each request, so the bill is read once, and only when asked for.
  const result = options.bill ? withBill(merged, await readBill({ profile })) : merged;
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

/** The model options, shared by every command a model can write for. */
function withModelOptions(command: Command): Command {
  return command
    .option("--provider <name>", "model provider for the AI summary and ask: anthropic, openai or bedrock (default: whichever key is set)")
    .option("--model <id>", "model to use for whatever this command does, over CLOUDPILOT_MODEL_SUMMARY and CLOUDPILOT_MODEL_ASK (default: a small, fast model for the AI summary, a stronger one for ask)")
    .option("--bedrock-profile <name>", "use Claude through Amazon Bedrock with this AWS profile instead of an Anthropic key", process.env.CLOUDPILOT_BEDROCK_PROFILE)
    .option("--bedrock-region <region>", "Bedrock region (defaults to the home region)");
}

function withRecordingOptions(command: Command): Command {
  return command
    .option("--record <dir>", "run live and save everything needed to replay this run into <dir>")
    .option("--replay <dir>", "repeat a recorded run from <dir> with no network calls")
    .option("--live-llm", "with --replay: AWS (or the cluster) from the recording, the model called live");
}

function withCommonOptions(command: Command): Command {
  return withRecordingOptions(
    withModelOptions(
      command
        .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
        .option("--region <region>", "scan only this region")
        .option("--all-regions", "scan every region enabled for the account (the default when --region is not given)")
        .option("--lookback-hours <n>", "hours of CPU history used to judge idleness", "24")
        .option("--price-file <path>", "saved price table to fall back on when the Price List API is unreachable")
        .option("--offline", "use only --price-file for prices"),
    ),
  ).option("--redact-account", `show the account ID as ${REDACTED_ACCOUNT} in output and recordings`);
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
    console.log(JSON.stringify(scanJson(result, summary, banner), null, 2));
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
  clusterName?: string;
  namespace?: string;
  prometheus?: string;
  lookbackHours: string;
  cpuHourUsd?: string;
  memoryGibHourUsd?: string;
  storageGibMonthUsd?: string;
  /** --no-advisories sets this to false. Anything else, including unset, reads and lists them. */
  advisories?: boolean;
  compare?: string | false;
  onlyNew?: boolean;
  answerKey?: string;
  notify?: string[];
  /** Set once the notify targets are settled, so a replay's banner can say it still sends them. */
  notifying?: boolean;
  upload?: string;
  explain?: boolean;
  model?: string;
  provider?: Provider;
  bedrockProfile?: string;
  bedrockRegion?: string;
  record?: string;
  replay?: string;
  liveLlm?: boolean;
}

/** The saved scan of one cluster, so scanning a second cluster never replaces the first one's baseline. */
const clusterFile = (prefix: string, context: string) => `.cloudpilot/${prefix}-${context.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;

function amount(text: string, flag: string): number {
  // Number("") is 0, which would quietly read an unset shell variable as a deliberate zero.
  const value = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} takes a number that is zero or more. Got "${text}".`);
  return value;
}

const pricesGiven = (options: KubeOptions) => [options.cpuHourUsd, options.memoryGibHourUsd, options.storageGibMonthUsd].some((v) => v !== undefined);

/** OpenCost's defaults, with whichever prices were given on the command line in their place. */
function clusterPrices(options: KubeOptions): ClusterPrices {
  if (!pricesGiven(options)) return OPENCOST_DEFAULTS;
  return {
    source: "command-line",
    cpuHourUsd: options.cpuHourUsd !== undefined ? amount(options.cpuHourUsd, "--cpu-hour-usd") : OPENCOST_DEFAULTS.cpuHourUsd,
    memoryGibHourUsd: options.memoryGibHourUsd !== undefined ? amount(options.memoryGibHourUsd, "--memory-gib-hour-usd") : OPENCOST_DEFAULTS.memoryGibHourUsd,
    storageGibMonthUsd: options.storageGibMonthUsd !== undefined ? amount(options.storageGibMonthUsd, "--storage-gib-month-usd") : OPENCOST_DEFAULTS.storageGibMonthUsd,
  };
}

const CLUSTER_NAME_HELP =
  "when run inside the cluster with no kubeconfig: what to call it (or CLOUDPILOT_CLUSTER_NAME). Use the kubectl context name your team uses for it on their own machines, because the fix commands carry --context <name> so that a pasted command cannot reach a different cluster. Ignored when kubectl has a context";

/** The name given for a cluster with no context, as it was written: --cluster-name, else CLOUDPILOT_CLUSTER_NAME. */
const clusterNameGiven = (options: { clusterName?: string }) => options.clusterName ?? (process.env.CLOUDPILOT_CLUSTER_NAME?.trim() || undefined);

/** The name a cluster with no context is known by: --cluster-name, else CLOUDPILOT_CLUSTER_NAME. Unused when kubectl has a context. */
function clusterNameOf(options: { context?: string; clusterName?: string }): string | undefined {
  if (options.clusterName !== undefined && options.context) throw new Error("--cluster-name names a cluster read through the pod's own service account, so it cannot be used with --context.");
  const given = clusterNameGiven(options);
  return given ? parseClusterName(given) : undefined;
}

/** What the kube command and `ask --kube` share about where a cluster is and what its units cost. */
function withClusterOptions(command: Command): Command {
  return command
    .option("--context <name>", "kubectl context to read (default: the current one)")
    .option("--cluster-name <name>", CLUSTER_NAME_HELP)
    .option("--namespace <name>", "read only this namespace (default: every namespace except the cluster's own)")
    .option("--prometheus <namespace/service:port>", "the Prometheus holding usage history (default: found among the cluster's services)")
    .option("--cpu-hour-usd <n>", "what one vCPU costs per hour on your nodes (default: OpenCost's 0.031611)")
    .option("--memory-gib-hour-usd <n>", "what one GiB of memory costs per hour (default: OpenCost's 0.004237)")
    .option("--storage-gib-month-usd <n>", "what one GiB of storage costs per month (default: OpenCost's 0.04)");
}

interface ClusterScanOptions {
  namespace?: string;
  prometheus?: string;
  lookbackHours: number;
  prices: ClusterPrices;
  /** Read the nodes and the pods' status for the advisories, and list them. Off only with --no-advisories. */
  advisories: boolean;
}

/**
 * Read a cluster and apply the rules. Used by the kube and ask commands and by
 * the MCP server. The clock is the recording's while replaying, so the scan
 * time and the age of the usage history come out as they did.
 */
async function scanCluster(reader: KubeReader, options: ClusterScanOptions): Promise<{ inventory: ClusterInventory; result: ScanResult }> {
  const inventory = await collectCluster(reader, {
    namespace: options.namespace,
    prometheus: options.prometheus ? parsePrometheusRef(options.prometheus) : undefined,
    lookbackHours: options.lookbackHours,
    now: now(),
    advisories: options.advisories,
  });
  return { inventory, result: detectCluster(inventory, options.prices) };
}

/** The kube flavour of begin(): settle live, record or replay, and what is read. A replay repeats the recorded run unless told otherwise. */
interface ClusterRun {
  banner?: string;
  reader: KubeReader;
  scan: ClusterScanOptions;
}

function beginCluster(options: KubeOptions, command: "kube" | "kube-ask", question: string | undefined, lookbackGiven: boolean, json: boolean): ClusterRun {
  if (options.record && options.replay) throw new Error("Use --record or --replay, not both.");
  if (options.liveLlm && !options.replay) throw new Error("--live-llm only applies to --replay.");
  const lookbackHours = amount(options.lookbackHours, "--lookback-hours");
  if (lookbackHours === 0) throw new Error("--lookback-hours must be more than zero.");
  const scan: ClusterScanOptions = { namespace: options.namespace, prometheus: options.prometheus, lookbackHours, prices: clusterPrices(options), advisories: options.advisories !== false };

  if (!options.replay) {
    if (options.record) {
      const { namespace, prometheus, lookbackHours, prices, advisories } = scan;
      startRecord(options.record, { id: sessionIdFor(command, question), command, question, namespace: namespace ?? null, prometheus: prometheus ?? null, lookbackHours, prices, advisories }, { redact: false });
    } else {
      startLive({ redact: false });
    }
    return { reader: kubeReader(() => kubectlReader(options.context, undefined, clusterNameOf(options))), scan };
  }

  const { session } = replaySession(options.replay, command, question, Boolean(options.liveLlm));
  if (session.command !== "kube" && session.command !== "kube-ask") throw new Error(`${options.replay} holds no recorded ${RECORDED_AS[command]}. Record one with --record first.`);
  startReplay(options.replay, session, { redact: false, liveLlm: Boolean(options.liveLlm) });
  // What was read is what the recording holds: only the lookback and the prices may be asked for afresh, as they are with an account.
  const replayed: ClusterScanOptions = {
    namespace: session.namespace ?? undefined,
    prometheus: session.prometheus ?? undefined,
    lookbackHours: lookbackGiven ? lookbackHours : session.lookbackHours,
    prices: pricesGiven(options) ? scan.prices : session.prices,
    // The recording holds the nodes only if the run that made it read them: an older one is replayed without advisories, as it was run.
    advisories: scan.advisories && session.advisories === true,
  };
  const where = session.namespaces.length === 1 ? `namespace ${session.namespaces[0]}` : `${session.namespaces.length} namespaces`;
  const tail = replayTail("kubectl", options);
  const banner = `REPLAY MODE: recorded ${session.recordedAt} from cluster ${session.context}, ${where}. ${tail}`;
  announce(banner, json);
  return { banner, reader: kubeReader(() => kubectlReader()), scan: replayed };
}

/** The line that says a cluster is being read, and how kubectl gets in. */
const readingCluster = (context: string, inCluster?: boolean) =>
  inCluster ? `Reading cluster ${context} from inside it, as this pod's service account (read-only)...` : `Reading cluster ${context} through kubectl (read-only)...`;

/** Read a cluster live, or from a recording, and apply the rules. */
async function runKube(
  options: KubeOptions,
  command: "kube" | "kube-ask",
  question: string | undefined,
  lookbackGiven: boolean,
  json: boolean,
  save = true,
  /** Told which cluster this is as soon as that is known, so a failure after it can name the cluster. */
  onContext: (context: string) => void = () => {},
) {
  const run = beginCluster(options, command, question, lookbackGiven, json);
  const { context, inCluster } = await run.reader.identity();
  onContext(context);
  // One saved scan per cluster, so scanning a second cluster never replaces the first one's baseline.
  const saved = clusterFile("last-kube-scan", context);
  const previous = command === "kube" ? await previousScan(options, saved) : undefined;

  note(mode() === "replay" ? `Reading cluster ${context} from the recording (no kubectl)...` : readingCluster(context, inCluster));
  const { inventory, result } = await scanCluster(run.reader, run.scan);
  // A replay that could not find a read has not repeated the run, however the scan treated the gap.
  const miss = replayMiss();
  if (miss) throw miss;

  // A replay is a recording, not the cluster as it is now, so it may not replace the baseline (saveBaseline refuses).
  // `save` false leaves it to the caller, who keeps it until what is new has been delivered.
  if (save && !options.answerKey) await saveBaseline(saved, result, {});
  return { banner: run.banner, inventory, result, previous, saved };
}

/** In record mode, write the capture of a cluster run once it has finished. */
function finishCluster(inventory: ClusterInventory): void {
  if (mode() === "record") note(`Recorded to ${saveClusterRecording({ context: inventory.context, namespaces: inventory.namespaces })}`);
}

const program = new Command()
  .name("cloudpilot")
  .description("Finds wasted AWS spend and proposes the fix commands. A scan is read-only; apply runs a fix only when you name and approve it.")
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
  .option("--upload <url>", UPLOAD_HELP)
  .option("--bill", "also read last month's total spend from Cost Explorer and say what share of it the waste is. AWS charges $0.01 for this one request, so it is never made unless you ask")
  .action(async (options: CommonOptions & { json?: boolean; out?: string; html?: string; explain?: boolean; compare?: string | false; onlyNew?: boolean; notify?: string[]; upload?: string }) => {
    const destination = uploadDestination(options);
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
    await uploadOnce(destination, () => scanJson(result, summary, banner));
    finish(result);
  });

withRecordingOptions(
  withModelOptions(
    withClusterOptions(
      program
        .command("kube")
        .description("Scan a Kubernetes cluster for workloads that request more than they use and for unused volumes, and list things worth a look that are not waste (read-only, through kubectl)")
        .option("--lookback-hours <n>", "hours of usage history to judge requests by", "168"),
    ),
  ),
)
  .option("--json", "print the result as JSON instead of a report")
  .option("--out <file>", "also write the report to a file: Markdown, or plain text when the name ends in .txt")
  .option("--html <file>", "also write the report as one self-contained HTML file")
  .option("--explain", "have a model write the summary (needs a model API key; templated otherwise)")
  .option("--compare <file>", "say what changed since this earlier scan (default: the last scan of this cluster made from this directory)")
  .option("--no-compare", "do not compare with an earlier scan")
  .option("--only-new", "list only the findings that are new since the earlier scan")
  .option("--answer-key <path>", "score the findings against a lab's answer key instead of printing the report")
  .option("--no-advisories", NO_ADVISORIES_HELP)
  .option("--notify <url>", NOTIFY_HELP, collectUrls)
  .option("--upload <url>", UPLOAD_HELP)
  .action(async (options: KubeOptions, command: Command) => {
    const destination = uploadDestination(options);
    const targets = notifyTargets(options.notify);
    if (targets.length > 0 && (options.compare === false || options.answerKey)) {
      throw new Error(`--notify needs the comparison to know what is new, so it cannot be used with ${options.answerKey ? "--answer-key" : "--no-compare"}.`);
    }
    const lookbackGiven = command.getOptionValueSource("lookbackHours") !== "default";
    // Reading which cluster this is can fail on its own (no kubectl, no current context), and that is a failed check too.
    // With a webhook to tell, the baseline moves only once it has been told.
    let known: string | undefined;
    const { banner, inventory, result: scanned, previous, saved } = await notifying(
      targets,
      () => (known ? `cluster ${known}` : contextSubject(options)),
      () => runKube({ ...options, notifying: targets.length > 0 }, "kube", undefined, lookbackGiven, Boolean(options.json), targets.length === 0, (context) => (known = context)),
    );

    if (options.answerKey) {
      const evaluation = await evaluate(scanned, options.answerKey);
      console.log(renderEvaluation(evaluation));
      if (!evaluation.passed) process.exitCode = 1;
      finishCluster(inventory);
      return;
    }

    const compared = previous ? compareScans(previous, scanned) : undefined;
    if (previous && !compared && typeof options.compare === "string") note("The scan to compare with is of a different cluster; comparison skipped.");
    const result = compared ?? scanned;
    const view: ReportOptions = { onlyNew: Boolean(options.onlyNew), noComparison: noComparisonReason(options, previous, compared) };

    const summary = options.explain
      ? await modelText(() => summarize(result, llmOptions(options, defaultRegion())), allowedValues(result), result)
      : templatedSummary(result, { shortenIds: true });
    await present(result, summary, view, options, banner);
    if (targets.length > 0 && (await notifyOnce(targets, findingsNotice(result, Boolean(compared), banner)))) await saveBaseline(saved, scanned, {});
    await uploadOnce(destination, () => scanJson(result, summary, banner));
    finishCluster(inventory);
  });

interface AnomaliesOptions {
  profile?: string;
  days?: string;
  sensitivity: string;
  minIncrease: string;
  /** Commander sets it to false for --no-weekday-check. */
  weekdayCheck: boolean;
  json?: boolean;
  notify?: string[];
  record?: string;
  replay?: string;
  redactAccount?: boolean;
  /** Set once the notify targets are settled, so a replay's banner can say it still sends them. */
  notifying?: boolean;
}

/** The rule's two settings, and the days asked for if any, settled before anything is read, so a typo costs no request. */
function anomalySettings(options: AnomaliesOptions): { rule: AnomalyRule; days?: number } {
  const sensitivity = Number(options.sensitivity);
  if (options.sensitivity.trim() === "" || !Number.isFinite(sensitivity) || sensitivity <= 0) throw new Error(`--sensitivity takes a number above zero. Got "${options.sensitivity}".`);
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && (!/^\d+$/.test(options.days!.trim()) || days < MIN_DAYS || days > MAX_DAYS)) {
    throw new Error(`--days takes a whole number from ${MIN_DAYS} to ${MAX_DAYS}. Got "${options.days}".`);
  }
  return { rule: { sensitivity, minIncreaseUsd: amount(options.minIncrease, "--min-increase"), weekdayCheck: options.weekdayCheck !== false }, days };
}

/**
 * Read the daily cost per service, live or from a recording, and apply the
 * rule. The charge is said before the request is made. A replay reads the
 * days it was recorded with unless told otherwise, and says it makes no request.
 */
async function runAnomalies(options: AnomaliesOptions, rule: AnomalyRule, daysGiven: number | undefined) {
  if (options.record && options.replay) throw new Error("Use --record or --replay, not both.");
  const json = Boolean(options.json);
  const redactAccount = Boolean(options.redactAccount);
  let homeRegion = defaultRegion();
  let days = daysGiven ?? DEFAULT_DAYS;
  let banner: string | undefined;

  if (!options.replay) {
    if (options.record) startRecord(options.record, { id: sessionIdFor("anomalies"), command: "anomalies", homeRegion, region: null, days }, { redact: redactAccount });
    else startLive({ redact: redactAccount });
  } else {
    const { manifest, session } = replaySession(options.replay, "anomalies", undefined, false);
    if (session.command !== "anomalies") throw new Error(`${options.replay} holds no recorded ${RECORDED_AS.anomalies}. Record one with --record first.`);
    if (!manifest.accountId) throw new Error(`${options.replay} holds no recorded account. Record one with --record first.`);
    startReplay(options.replay, session, { redact: redactAccount, liveLlm: false });
    enableRedaction(manifest.accountId);
    homeRegion = session.homeRegion;
    days = daysGiven ?? session.days ?? DEFAULT_DAYS;
    banner = `REPLAY MODE: recorded ${session.recordedAt} from account ${redactAccount ? REDACTED_ACCOUNT : manifest.accountId}, the last ${days} days of cost. ${replayTail("AWS", options)}`;
    announce(banner, json);
  }

  const profile = options.profile;
  const accountId = await callerAccount({ region: homeRegion, profile });
  enableRedaction(accountId);
  // Said before the request, and first on stdout in a text run; --json keeps stdout for the JSON.
  const charge = mode() === "replay" ? REPLAY_CHARGE_NOTICE : CHARGE_NOTICE;
  if (json) note(charge);
  else console.log(`${charge}\n`);

  const read = await readDailyCosts({ profile, days });
  const requests = mode() === "replay" ? 0 : read.requests;
  const report = findAnomalies(read.days, now().toISOString().slice(0, 10), rule);
  return { report, accountId, days, requests, banner };
}

/** In record mode, write the capture once the run has finished. */
function finishAnomalies(accountId: string): void {
  if (mode() === "record") note(`Recorded to ${saveRecording({ accountId, regions: [] })}`);
}

/** The message for a run that found something, and nothing for one that did not: silence means nothing was unusual. */
const anomaliesNotice = (report: AnomalyReport, accountId: string, banner?: string): Notice | undefined =>
  report.anomalies.length > 0 ? { kind: "anomalies", report, accountId, banner } : undefined;

program
  .command("anomalies")
  .description(
    `Find services that cost unusually much on the latest complete day, from daily Cost Explorer data. AWS charges $0.01 for each Cost Explorer request, and this makes one. A fixed rule (median and median absolute deviation, and the same weekday's earlier days) finds them; no model is involved`,
  )
  .option("--days <n>", `days of cost to read, ${MIN_DAYS} to ${MAX_DAYS}; the latest complete day is compared with the days before it (default ${DEFAULT_DAYS}; with --replay, the days recorded)`)
  .option("--sensitivity <k>", `flag a day above the median plus k times 1.4826 times the median absolute deviation (default ${DEFAULT_SENSITIVITY})`, String(DEFAULT_SENSITIVITY))
  .option("--min-increase <dollars>", `never flag a day that is less than this many dollars above the median (default ${DEFAULT_MIN_INCREASE_USD.toFixed(2)})`, DEFAULT_MIN_INCREASE_USD.toFixed(2))
  .option("--no-weekday-check", "do not also require the day to be above the earlier days on its own weekday (by default a weekly job is not flagged every week)")
  .option("--json", "print the result as JSON instead of a report")
  .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
  .option("--notify <url>", NOTIFY_HELP.replace("what is new", "which services cost more than usual, only when there is one"), collectUrls)
  .option("--record <dir>", "run live and save everything needed to replay this run into <dir>")
  .option("--replay <dir>", "repeat a recorded run from <dir> with no network calls and no charge")
  .option("--redact-account", `show the account ID as ${REDACTED_ACCOUNT} in output and recordings`)
  .action(async (options: AnomaliesOptions) => {
    const { rule, days } = anomalySettings(options);
    const targets = notifyTargets(options.notify);
    let ran: Awaited<ReturnType<typeof runAnomalies>>;
    try {
      ran = await runAnomalies({ ...options, notifying: targets.length > 0 }, rule, days);
    } catch (err) {
      // A check that failed is a message of its own, so that silence only ever means nothing was unusual.
      await notifyFailed(targets, "your AWS account", err);
      throw err;
    }
    const { report, accountId, banner } = ran;
    const context = { accountId, days: ran.days, requests: ran.requests };
    console.log(options.json ? JSON.stringify(anomaliesJson(report, { ...context, replay: banner }), null, 2) : renderAnomalies(report, context));
    if (targets.length > 0) {
      const notice = anomaliesNotice(report, accountId, banner);
      if (notice) await notifyOnce(targets, notice);
      else note(report.status === "ok" ? `Nothing unusual, so nothing was sent to ${hostsOf(targets)}.` : `Nothing could be judged, so nothing was sent to ${hostsOf(targets)}.`);
    }
    finishAnomalies(accountId);
  });

interface WatchCommandOptions extends Omit<CommonOptions, "lookbackHours">, Omit<KubeOptions, "lookbackHours" | "compare" | "onlyNew" | "answerKey" | "json" | "out" | "html"> {
  kube?: boolean;
  every: string;
  maxRuns?: string;
  lookbackHours?: string;
}

/** Options that only mean something for one of the two things that can be watched. */
const AWS_ONLY = ["region", "allRegions", "priceFile", "offline", "replay", "redactAccount"] as const;
const KUBE_ONLY = ["context", "clusterName", "namespace", "prometheus", "cpuHourUsd", "memoryGibHourUsd", "storageGibMonthUsd"] as const;
const FLAG: Record<string, string> = {
  region: "--region", allRegions: "--all-regions", priceFile: "--price-file", offline: "--offline", replay: "--replay", redactAccount: "--redact-account",
  context: "--context", clusterName: "--cluster-name", namespace: "--namespace", prometheus: "--prometheus", cpuHourUsd: "--cpu-hour-usd", memoryGibHourUsd: "--memory-gib-hour-usd", storageGibMonthUsd: "--storage-gib-month-usd",
};

program
  .command("watch")
  .description("Scan again and again, and speak up only when something is new (a foreground process: run it under systemd, tmux or a container)")
  .option("--every <interval>", "wait this long between rounds, from 15m to 7d: 30m, 6h, 1d", DEFAULT_EVERY)
  .option("--max-runs <n>", "stop after this many rounds (default: until stopped)")
  .option("--notify <url>", NOTIFY_HELP, collectUrls)
  .option("--upload <url>", UPLOAD_HELP)
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
  .option("--cluster-name <name>", `cluster: ${CLUSTER_NAME_HELP}`)
  .option("--namespace <name>", "cluster: read only this namespace")
  .option("--prometheus <namespace/service:port>", "cluster: the Prometheus holding usage history (default: found among the cluster's services)")
  .option("--cpu-hour-usd <n>", "cluster: what one vCPU costs per hour on your nodes")
  .option("--memory-gib-hour-usd <n>", "cluster: what one GiB of memory costs per hour")
  .option("--storage-gib-month-usd <n>", "cluster: what one GiB of storage costs per month")
  .option("--no-advisories", `cluster: ${NO_ADVISORIES_HELP}`)
  .action(async (options: WatchCommandOptions, command: Command) => {
    const everyMs = parseEvery(options.every);
    const maxRuns = options.maxRuns === undefined ? undefined : parseMaxRuns(options.maxRuns);
    const targets = notifyTargets(options.notify);
    for (const key of options.kube ? AWS_ONLY : KUBE_ONLY) {
      if (options[key as keyof WatchCommandOptions] !== undefined) throw new Error(`${FLAG[key]} only applies ${options.kube ? "to the AWS account, not with --kube" : "with --kube"}.`);
    }
    if (!options.kube && command.getOptionValueSource("advisories") === "cli") throw new Error("--no-advisories only applies with --kube.");

    const destination = uploadDestination(options);

    // What differs between watching the account and the cluster: how one round is read, and where what was reported is kept.
    let subject: string;
    let baselinePath: string;
    let scan: () => Promise<{ result: ScanResult; banner?: string }>;
    if (options.kube) {
      startLive({ redact: false });
      // The context in force now, kept for every round: a later `kubectl config use-context` must not move the watch to another cluster.
      // A watch that cannot even start must say so: it is not going to keep trying.
      const { context, inCluster, clusterName, lookbackHours, prices } = await notifying(
        targets,
        () => contextSubject(options),
        async () => {
          const lookbackHours = amount(options.lookbackHours ?? "168", "--lookback-hours");
          if (lookbackHours === 0) throw new Error("--lookback-hours must be more than zero.");
          const prices = clusterPrices(options as KubeOptions);
          const clusterName = clusterNameOf(options);
          const identity = await kubectlReader(options.context, undefined, clusterName).identity();
          return { ...identity, clusterName, lookbackHours, prices };
        },
      );
      // Inside a cluster there is no context to pin: kubectl uses the pod's service account every round.
      const reader = kubectlReader(inCluster ? undefined : context, undefined, clusterName);
      subject = `cluster ${context}`;
      baselinePath = clusterFile("watch-kube", context);
      scan = async () => {
        note(readingCluster(context, inCluster));
        return { result: (await scanCluster(reader, { namespace: options.namespace, prometheus: options.prometheus, lookbackHours, prices, advisories: options.advisories !== false })).result };
      };
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
    note(`Watching ${subject} every ${options.every}, read-only. ${targets.length > 0 ? `Messages go to ${hostsOf(targets)}.` : "No --notify target: results are printed here only."}${destination ? ` Every round is uploaded to ${destination.host}.` : ""} Ctrl+C stops it.`);

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
        ...(destination ? { upload: (body: string, signal: AbortSignal) => upload(destination, body, { send: httpUploader, pause: sleep }, signal) } : {}),
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

program
  .command("init")
  .description("Check that a scan will work from here and say what is missing: credentials, read access, kubectl, Prometheus (creates and changes nothing)")
  .option("--profile <name>", "AWS profile to read with (default: the standard AWS credential chain)", process.env.AWS_PROFILE)
  .option("--region <region>", "try the AWS reads in this region (default: the region a scan starts from)")
  .option("--context <name>", "kubectl context to check (default: the current one)")
  .option("--cluster-name <name>", CLUSTER_NAME_HELP)
  .option("--prometheus <namespace/service:port>", "the Prometheus holding usage history (default: found among the cluster's services)")
  .option("--json", "print the result as JSON")
  .option("--print-policy", "print the read-only IAM policy a scan needs, as JSON, and stop")
  .action(async (options: { profile?: string; region?: string; context?: string; clusterName?: string; prometheus?: string; json?: boolean; printPolicy?: boolean }) => {
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
      clusterName: options.clusterName,
      prometheus: options.prometheus ? parsePrometheusRef(options.prometheus) : undefined,
    };
    const result = await preflight(checking, { aws: awsProbes(checking), kube: kubectlReader(options.context, KUBECTL_TIMEOUT_MS, clusterNameOf(options)) });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderPreflight(result, checking));
    process.exitCode = result.ready ? 0 : 1;
  });

const AUDIT_LOG = ".cloudpilot/audit.jsonl";

/** Every scan saved in this directory: the account's, and one per cluster. */
async function savedScans(from?: string): Promise<ScanResult[]> {
  const read = async (path: string): Promise<ScanResult | undefined> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return isScanResult(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  if (from) {
    const scan = await read(from);
    if (!scan) throw new ApplyError(`${from} is not a CloudPilot scan result (save one with --json).`);
    return [scan];
  }
  const names = await readdir(dirname(LAST_SCAN)).catch(() => [] as string[]);
  const files = names.filter((name) => name === "last-scan.json" || /^last-kube-scan-.*\.json$/.test(name)).sort();
  const scans = (await Promise.all(files.map((name) => read(join(dirname(LAST_SCAN), name))))).filter((scan): scan is ScanResult => Boolean(scan));
  if (scans.length === 0) throw new ApplyError("There is no saved scan in this directory to take a fix from. Run a scan here first.");
  return scans;
}

/** Who to record as having asked for a fix. A uid with no passwd entry still gets a name. */
function whoAmI(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || `uid ${process.getuid?.() ?? "unknown"}`;
  }
}

/** The audit log, losing only the lines that cannot be read rather than the whole record. */
async function readAudit(): Promise<{ entries: AuditEntry[]; unreadable: number }> {
  const text = await readFile(AUDIT_LOG, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw new ApplyError(`${AUDIT_LOG} is there but could not be read (${err.code ?? err.message}). That file is the record of what apply has run, so this is not an empty record.`);
  });
  const entries: AuditEntry[] = [];
  let unreadable = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (isAuditEntry(parsed)) entries.push(parsed);
    else unreadable++;
  }
  return { entries, unreadable };
}

program
  .command("apply")
  .description("Run the fix for the resources you name, after showing it and asking. The only command that can change anything")
  .argument("<resource...>", "resource IDs exactly as the report shows them, e.g. vol-0123456789abcdef0 or deployment/api")
  .option("--from <file>", "take the fixes from this scan result (default: the scans saved in this directory)")
  .option("--allow-permanent", "choose the fix that cannot be undone; it still needs the resource ID typed back at a terminal")
  .option("--yes", "run fixes that can be undone without asking (never applies to permanent fixes)")
  .option("--dry-run", "show what would run and stop")
  .option("--max-age-hours <n>", "refuse a scan older than this", "24")
  .option("--profile <name>", "AWS profile the aws commands run with (default: the standard AWS credential chain)")
  .action(async (resources: string[], options: { from?: string; allowPermanent?: boolean; yes?: boolean; dryRun?: boolean; maxAgeHours: string; profile?: string }) => {
    const plans = plan(await savedScans(options.from), resources, {
      allowPermanent: options.allowPermanent,
      maxAgeHours: amount(options.maxAgeHours, "--max-age-hours"),
      now: new Date(),
    });
    // Asking needs a person at a terminal on both ends.
    const terminal = process.stdin.isTTY && process.stdout.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    try {
      const outcomes = await apply(plans, {
        runner: programRunner(options.profile ? { ...process.env, AWS_PROFILE: options.profile } : process.env),
        ask: terminal ? (question) => terminal.question(question) : undefined,
        yes: options.yes,
        dryRun: options.dryRun,
        say: (line) => console.log(line),
        record: async (entry) => {
          await mkdir(dirname(AUDIT_LOG), { recursive: true });
          await appendFile(AUDIT_LOG, `${JSON.stringify(entry)}\n`);
        },
        user: whoAmI(),
        now: () => new Date(),
      });
      if (!options.dryRun) note(`\nRecorded in ${AUDIT_LOG}. See it with: cloudpilot audit`);
      if (outcomes.some((o) => o === "failed" || o === "refused")) process.exitCode = 1;
    } finally {
      terminal?.close();
    }
  });

program
  .command("audit")
  .description("Show every fix that apply ran, was told not to run, or refused to run from this directory")
  .option("--json", "print the entries as JSON")
  .action(async (options: { json?: boolean }) => {
    const { entries, unreadable } = await readAudit();
    console.log(options.json ? JSON.stringify(entries, null, 2) : renderAudit(entries));
    if (unreadable > 0) note(`\n${unreadable} line${unreadable === 1 ? "" : "s"} of ${AUDIT_LOG} could not be read and ${unreadable === 1 ? "is" : "are"} not shown above.`);
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

withClusterOptions(withCommonOptions(program.command("ask").description("Ask a question about the account or, with --kube, a cluster in plain English (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)")))
  .option("--kube", "ask about a Kubernetes cluster, read through kubectl, instead of the AWS account")
  .argument("<question...>", "the question")
  .action(async (words: string[], options: CommonOptions & KubeOptions & { kube?: boolean }, command: Command) => {
    const question = words.join(" ");
    const given = (name: string) => command.getOptionValueSource(name) === "cli";
    const cluster = Boolean(options.kube);
    // Each flag belongs to one kind of question: say so rather than ignore it.
    for (const [flag, name] of [["--region", "region"], ["--all-regions", "allRegions"], ["--profile", "profile"], ["--price-file", "priceFile"], ["--offline", "offline"], ["--redact-account", "redactAccount"]] as const) {
      if (cluster && given(name)) throw new Error(`${flag} is for an AWS account and does nothing with --kube.`);
    }
    for (const [flag, name] of [["--context", "context"], ["--cluster-name", "clusterName"], ["--namespace", "namespace"], ["--prometheus", "prometheus"], ["--cpu-hour-usd", "cpuHourUsd"], ["--memory-gib-hour-usd", "memoryGibHourUsd"], ["--storage-gib-month-usd", "storageGibMonthUsd"]] as const) {
      if (!cluster && given(name)) throw new Error(`${flag} is for a cluster: add --kube.`);
    }
    // Without a model there is nothing to ask: say so before reading anything from AWS or the cluster.
    if (!options.replay || options.liveLlm) resolveProvider(llmOptions(options, ""));

    if (cluster) {
      // The common default of 24 hours is a CPU window for instances; usage history is judged over a week unless told otherwise.
      const lookbackGiven = given("lookbackHours");
      const { inventory, result } = await runKube({ ...options, lookbackHours: lookbackGiven ? options.lookbackHours : "168" }, "kube-ask", question, lookbackGiven, false);
      const answer = await modelText(
        () => ask(question, { result, cluster: inventory, llm: llmOptions(options, defaultRegion()), onToolUse: (name) => note(`  looking up: ${name}`) }),
        allowedValues(result, { cluster: inventory }),
        result,
      );
      console.log(answer);
      finishCluster(inventory);
      return;
    }

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
        const pending = scanCluster(kubectlReader(text(args.context), undefined, clusterNameOf({ context: text(args.context) })), {
          namespace: text(args.namespace),
          prometheus: text(args.prometheus),
          lookbackHours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168,
          prices: OPENCOST_DEFAULTS,
          advisories: true,
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
            "Scan a Kubernetes cluster for waste, read-only through kubectl, and return a summary plus every finding: workloads that request more CPU or memory than they use (with the kubectl command that lowers the request and the old values as the way back), volume claims no pod mounts, and Released volumes. It also returns advisories, which are NOT waste and are not in the total: containers killed for running out of memory, containers that keep restarting, workloads with no CPU or memory request, pods that cannot be scheduled, and spare node capacity. Reads the current kubectl context unless one is given. Usage comes from the cluster's Prometheus. Costs use the OpenCost project's default unit prices, which the result states.",
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
            const digest = advisoryDigest(result);
            return `${header(result).join("\n")}\n\n${templatedSummary(result)}\n\n${digest ? `${digest}\n\n` : ""}Findings as JSON:\n${JSON.stringify(forModel(result))}`;
          },
        },
        clusterWorkloads(async () => (await currentCluster()).inventory, " Runs scan_cluster with its defaults first if no cluster has been scanned yet."),
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
