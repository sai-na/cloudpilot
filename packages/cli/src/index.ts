#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Command } from "commander";
import { buildTools, forModel, MCP_INSTRUCTIONS, MissingCredentialsError, type Provider, type ToolSpec } from "./advisor.js";
import { ask, describeApiError, resolveProvider, summarize } from "./assistant.js";
import { callerAccount, collect, enabledRegions, readCpu } from "./collect.js";
import { detect, mergeScans } from "./detect.js";
import { loadEnvFile } from "./env.js";
import { evaluate, renderEvaluation } from "./evaluate.js";
import { renderHtml } from "./html.js";
import { serveMcp } from "./mcp.js";
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
import { money, renderMarkdown, renderText, templatedSummary } from "./report.js";
import type { Inventory, PriceBook, RegionScan, ScanResult } from "./types.js";

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
  const tail = options.liveLlm ? "No live AWS calls; the model is called live." : "No live calls.";
  const banner = `REPLAY MODE: recorded ${session.recordedAt} from account ${account}, ${where}. ${tail}`;
  if (json) note(banner);
  else console.log(`${banner}\n`);
  return { banner, scope: { homeRegion: session.homeRegion, region: session.region } };
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
  // A convenience copy; skipped quietly where the working directory cannot be written to.
  await mkdir(dirname(LAST_SCAN), { recursive: true })
    .then(() => writeFile(LAST_SCAN, redact(JSON.stringify(result, null, 2))))
    .catch(() => {});
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
    return templatedSummary(result);
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

const program = new Command()
  .name("cloudpilot")
  .description("Read-only agent that finds wasted AWS spend and proposes the fix commands.")
  .version(VERSION);

withCommonOptions(program.command("scan", { isDefault: true }).description("Scan the account and report wasted spend (the default command)"))
  .option("--json", "print the result as JSON instead of a report")
  .option("--out <file>", "also write the report as Markdown")
  .option("--html <file>", "also write the report as one self-contained HTML file")
  .option("--explain", "have a model write the summary (needs a model API key; templated otherwise)")
  .action(async (options: CommonOptions & { json?: boolean; out?: string; html?: string; explain?: boolean }) => {
    const { result, banner, scope } = await runScan(options, "scan", undefined, Boolean(options.json));

    // Every scan ends with a summary: written by a model on request, built from the findings otherwise.
    const summary = options.explain
      ? await modelText(() => summarize(result, llmOptions(options, scope.homeRegion)), allowedValues(result), result)
      : templatedSummary(result);

    if (options.json) {
      console.log(JSON.stringify({ ...result, summary, ...(banner ? { replay: banner } : {}) }, null, 2));
    } else {
      console.log(renderText(result));
      console.log(`\nSummary\n\n${summary}`);
    }
    if (options.out) {
      await writeFile(options.out, redact(renderMarkdown(result, summary, banner)));
      note(`Report written to ${options.out}`);
    }
    if (options.html) {
      await writeFile(options.html, redact(renderHtml(result, { summary, banner })));
      note(`HTML report written to ${options.html}`);
    }
    finish(result);
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
