/** What every model provider shares: the ground rules, the summary request and the lookup tools. */
import type { Inventory, PriceBook, ScanResult } from "./types.js";

export type Provider = "anthropic" | "bedrock" | "openai";

/** Which model answers, and how to reach it. */
export interface LlmOptions {
  /** Left unset, the provider is chosen from whichever credentials are present. */
  provider?: Provider;
  model?: string;
  /** AWS profile allowed to invoke Bedrock models. Setting it selects Bedrock. */
  bedrockProfile?: string;
  bedrockRegion?: string;
}

export const GROUND_RULES = `You are CloudPilot, a read-only cloud cost advisor for AWS.

A deterministic scanner has already inspected the account and priced every finding from the AWS Price List. Your job is to explain those results to an engineer, not to recompute them.

Rules:
- Every dollar figure, resource ID and command you give must come from the scan data or a tool result. Never estimate a number yourself; if the data does not contain it, say so.
- You cannot change anything in the account and neither can the scanner. The fix commands are proposals for a human to review and run. Never say or imply that something was fixed, deleted or changed.
- Each fix carries a risk level and a "way back" note. When you recommend a fix marked dangerous, say what is permanent about it.
- Costs for snapshots and AMIs are upper bounds (provisioned size); say so when you quote them.
- Quote dollar amounts and resource IDs exactly as they appear in the data. Do not add amounts together, convert them to yearly figures or round them differently; text containing a figure or ID that is not in the data is discarded.
- Resources tagged cloudpilot:ignore=true were skipped on purpose and are listed under skippedByTag; mention how many when you summarise.
- Write plain text for a terminal: short paragraphs and simple lists, no Markdown tables or headings.`;

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The scan as the model sees it: money as "$8.91" strings, so it is quoted exactly as the report shows it. */
export function forModel(result: ScanResult) {
  return {
    ...result,
    totalMonthlyWasteUsd: dollars(result.totalMonthlyWasteUsd),
    ...(result.comparison
      ? {
          comparison: {
            ...result.comparison,
            newMonthlyUsd: dollars(result.comparison.newMonthlyUsd),
            resolvedMonthlyUsd: dollars(result.comparison.resolvedMonthlyUsd),
            resolved: result.comparison.resolved.map((r) => ({ ...r, monthlyCostUsd: dollars(r.monthlyCostUsd) })),
          },
        }
      : {}),
    findings: result.findings.map((f) => ({
      ...f,
      monthlyCostUsd: dollars(f.monthlyCostUsd),
      ...(f.alternative ? { alternative: { ...f.alternative, monthlySavingUsd: dollars(f.alternative.monthlySavingUsd) } } : {}),
    })),
  };
}

/** What an MCP client's model is told about these tools. */
export const MCP_INSTRUCTIONS = `CloudPilot is a read-only scanner for wasted AWS spend. Call "scan" first; the other tools read from the latest scan.

- Every dollar figure, resource ID and command you give must come from a tool result. Quote amounts exactly as given; do not add them up, annualise them or estimate your own.
- CloudPilot cannot change anything in the account and has no tool that does. The fix commands are proposals for a person to review and run. Never say or imply that something was fixed or deleted, and do not run the commands yourself unless the user explicitly asks you to.
- Each fix carries a risk level and a "way back" note. When you recommend a fix marked dangerous, say what is permanent about it.
- Costs for snapshots and AMIs are upper bounds based on provisioned size; say so when you quote them.
- Resources tagged cloudpilot:ignore=true were skipped on purpose and are listed under skippedByTag.
- A result that starts with "REPLAY MODE" comes from a recording, not a live account: tell the user.`;

/** Added to the instructions only by a server that offers the cluster tools: a replaying one has no cluster. */
export const MCP_CLUSTER_INSTRUCTIONS = `- For a Kubernetes cluster, call "scan_cluster"; "get_cluster_workloads" reads from the latest cluster scan. A cluster result names the kubectl context where an account result gives the account ID, and namespaces where an account result gives regions. Lowering a request saves money only once the freed capacity lets the cluster run fewer or smaller nodes: say so when you quote such a saving, and say how much usage history the finding rests on.`;

export const summaryRequest = (result: ScanResult) =>
  `Here is the scan result as JSON:\n\n${JSON.stringify(forModel(result))}\n\nWrite a summary for the engineer who owns this account: the total monthly waste, then the findings in the order they should be dealt with, grouping ones that are the same kind of problem. For each, give the monthly cost, why it is waste in one sentence, and how risky the fix is. Finish with the single action that saves the most for the least risk. Keep it under 250 words.`;

export class MissingCredentialsError extends Error {
  constructor() {
    super("No model access configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --bedrock-profile to use Claude through Amazon Bedrock.");
  }
}

export interface AskContext {
  result: ScanResult;
  /** One inventory and one price book per scanned region. */
  inventories: Inventory[];
  prices: PriceBook[];
  /** Live, read-only CPU lookup for one instance. */
  cpuHistory: (region: string, instanceId: string, hours: number) => Promise<unknown>;
  llm?: LlmOptions;
  /** Called with the name of each tool the model uses, for progress output. */
  onToolUse?: (name: string) => void;
}

/** A lookup the model may call. Every one is read-only. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties: false };
  /** Arguments come from the model, so each tool checks them itself. */
  run: (args: Record<string, unknown>) => Promise<string>;
}

const INVENTORY_KINDS = ["volumes", "snapshots", "images", "instances", "addresses", "buckets"] as const;
type InventoryKind = (typeof INVENTORY_KINDS)[number];

export function buildTools(ctx: AskContext): ToolSpec[] {
  return [
    {
      name: "list_findings",
      description:
        "Return every waste finding from the scan: pattern, resource IDs, evidence, monthly cost in USD, the proposed fix commands with their risk level, and the total. Call this first for any question about savings or what to fix.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => JSON.stringify(forModel(ctx.result)),
    },
    {
      name: "get_inventory",
      description:
        "Return the raw inventory the scanner read from AWS for one kind of resource across every scanned region, including resources that were NOT flagged. Each item carries its region. Use it to answer questions about what exists, or to check why something was or was not flagged.",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", enum: INVENTORY_KINDS } },
        required: ["kind"],
        additionalProperties: false,
      },
      run: async ({ kind }) => {
        if (!INVENTORY_KINDS.includes(kind as InventoryKind)) return `Unknown kind. Use one of: ${INVENTORY_KINDS.join(", ")}.`;
        return JSON.stringify(
          ctx.inventories.flatMap((inventory) =>
            (inventory[kind as InventoryKind] as object[]).map((item) => ({ region: inventory.region, ...item })),
          ),
        );
      },
    },
    {
      name: "get_prices",
      description: "Return the unit prices (USD) used to cost the findings, one price book per region that has resources, with their source and fetch time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => JSON.stringify(ctx.prices.filter((book) => book.snapshotGbMonth > 0)),
    },
    {
      name: "get_cpu_history",
      description:
        "Read CloudWatch CPUUtilization for one EC2 instance over the last N hours (live, read-only). Returns average and maximum percent and how many hours of data exist. Use it when asked whether an instance is really idle.",
      inputSchema: {
        type: "object",
        properties: {
          instance_id: { type: "string", description: "EC2 instance ID, e.g. i-0123456789abcdef0" },
          hours: { type: "integer", description: "How many hours back to read, 1 to 336" },
        },
        required: ["instance_id", "hours"],
        additionalProperties: false,
      },
      run: async ({ instance_id, hours }) => {
        const home = ctx.inventories.find((inventory) => inventory.instances.some((i) => i.id === instance_id));
        if (typeof instance_id !== "string" || !home) return `No instance ${String(instance_id)} in the scanned regions.`;
        const wanted = Number(hours);
        const stats = await ctx.cpuHistory(home.region, instance_id, Number.isFinite(wanted) ? Math.min(Math.max(wanted, 1), 336) : 24);
        // Three decimals is more than CloudWatch's precision warrants and reads cleanly.
        return stats
          ? JSON.stringify(stats, (_key, value) => (typeof value === "number" ? Number(value.toFixed(3)) : value))
          : "CloudWatch has no CPU data for that instance in that window.";
      },
    },
  ];
}
