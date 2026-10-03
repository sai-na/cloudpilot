/** What every model provider shares: the ground rules, the summary request and the lookup tools. */
import type { ClusterInventory } from "./kube.js";
import { cpuQuantity, memoryQuantity } from "./kube-detect.js";
import { sharePhrase } from "./report.js";
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

/**
 * The rules a model is bound by, for whichever kind of scan it is explaining:
 * an AWS account or a Kubernetes cluster. The rules both share are written once.
 */
export function groundRules(result: Pick<ScanResult, "cluster">): string {
  const cluster = Boolean(result.cluster);
  return [
    cluster ? "You are CloudPilot, a read-only cost advisor for Kubernetes clusters." : "You are CloudPilot, a read-only cloud cost advisor for AWS.",
    "",
    cluster
      ? "A deterministic scanner has already read the cluster through kubectl and priced every finding with the unit prices named in the scan data. Your job is to explain those results to an engineer, not to recompute them."
      : "A deterministic scanner has already inspected the account and priced every finding from the AWS Price List. Your job is to explain those results to an engineer, not to recompute them.",
    "",
    "Rules:",
    "- Every dollar figure, resource ID and command you give must come from the scan data or a tool result. Never estimate a number yourself; if the data does not contain it, say so.",
    `- You cannot change anything in the ${cluster ? "cluster" : "account"} and neither can the scan or any tool you have. The fix commands are proposals for a human to review and run. Never say or imply that something was fixed, deleted or changed.`,
    '- Each fix carries a risk level and a "way back" note. When you recommend a fix marked dangerous, say what is permanent about it.',
    ...(cluster
      ? [
          "- The scan names the kubectl context where an AWS scan names an account, and namespaces where it names regions. Say which cluster and which namespaces a result covers.",
          "- Lowering a request saves money only once the freed capacity lets the cluster run fewer or smaller nodes. When you quote such a saving, say so, and never say the bill drops by itself.",
          "- A finding about requests rests on the usage history Prometheus held, which its evidence states. Say how much history each one rests on: a workload whose busy season falls outside it may look over-requested.",
        ]
      : ["- Costs for snapshots and AMIs are upper bounds (provisioned size); say so when you quote them."]),
    cluster
      ? "- Quote dollar amounts, resource IDs such as deployment/reports, namespaces and CPU and memory quantities exactly as they appear in the data. Do not add amounts together, convert them to yearly figures, round them differently or convert units (300m to 0.3, 1Gi to 1024Mi); text containing a figure or ID that is not in the data is discarded."
      : "- Quote dollar amounts and resource IDs exactly as they appear in the data. Do not add amounts together, convert them to yearly figures or round them differently; text containing a figure or ID that is not in the data is discarded.",
    ...(cluster
      ? [
          "- Objects labelled or annotated cloudpilot/ignore=true were skipped on purpose and are listed under skippedByTag (a Kubernetes label, not an AWS tag); mention how many when you summarise.",
          "- A warnings entry means part of the cluster could not be read, so the findings and workloads are incomplete. Say that instead of calling something absent or fine.",
        ]
      : [
          "- Resources tagged cloudpilot:ignore=true were skipped on purpose and are listed under skippedByTag; mention how many when you summarise.",
          "- When the scan has a \"bill\", it is last month's actual spend. Quote its total and its wasteSharePct exactly as given, worded \"about N% of last month's bill\": the waste is an estimate per month at current prices and the bill is last month's actual total. Never work out another percentage or ratio. If the bill has an \"unavailable\" reason, say the bill could not be read and why; never state a figure for it.",
        ]),
    "- Write plain text for a terminal: short paragraphs and simple lists, no Markdown tables or headings.",
  ].join("\n");
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The scan as the model sees it: money as "$8.91" strings, so it is quoted exactly as the report shows it. */
export function forModel(result: ScanResult) {
  return {
    ...result,
    totalMonthlyWasteUsd: dollars(result.totalMonthlyWasteUsd),
    ...(result.bill
      ? {
          bill: {
            ...result.bill,
            ...(result.bill.totalUsd !== undefined ? { totalUsd: dollars(result.bill.totalUsd) } : {}),
            // The percentage as the report words it, so it is quoted exactly and never recomputed.
            ...(result.bill.wasteSharePct !== undefined ? { wasteSharePct: sharePhrase(result.bill.wasteSharePct) } : {}),
          },
        }
      : {}),
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
- This server cannot change anything in the account and has no tool that does. The fix commands are proposals for a person to review and run. Never say or imply that something was fixed or deleted, and do not run the commands yourself unless the user explicitly asks you to.
- Each fix carries a risk level and a "way back" note. When you recommend a fix marked dangerous, say what is permanent about it.
- Costs for snapshots and AMIs are upper bounds based on provisioned size; say so when you quote them.
- Resources tagged cloudpilot:ignore=true were skipped on purpose and are listed under skippedByTag.
- When a result has a "bill", it is last month's actual spend. Quote its total and its wasteSharePct exactly as given, worded "about N% of last month's bill", and never work out another percentage. An "unavailable" reason means the bill could not be read: say so and never state a figure for it.
- A result that starts with "REPLAY MODE" comes from a recording, not a live account: tell the user.`;

/** Added to the instructions only by a server that offers the cluster tools: a replaying one has no cluster. */
export const MCP_CLUSTER_INSTRUCTIONS = `- For a Kubernetes cluster, call "scan_cluster"; "get_cluster_workloads" reads from the latest cluster scan. A cluster result names the kubectl context where an account result gives the account ID, and namespaces where an account result gives regions. Lowering a request saves money only once the freed capacity lets the cluster run fewer or smaller nodes: say so when you quote such a saving, and say how much usage history the finding rests on. A cluster object is excluded by the label or annotation cloudpilot/ignore=true on it, not by the AWS tag; those objects are the ones listed under skippedByTag. A warnings entry means part of the cluster could not be read, so the lists are incomplete: say that instead of calling something absent.`;

export const summaryRequest = (result: ScanResult) =>
  result.cluster
    ? `Here is the scan result as JSON:\n\n${JSON.stringify(forModel(result))}\n\nWrite a summary for the engineer who owns this cluster: the total monthly waste, then the findings in the order they should be dealt with, grouping ones that are the same kind of problem. For each, give the monthly cost, why it is waste in one sentence, and how risky the fix is. Say how much usage history the requests findings rest on, and that their saving is only realised once the cluster can run fewer or smaller nodes. Finish with the single action that saves the most for the least risk. Keep it under 300 words.`
    : `Here is the scan result as JSON:\n\n${JSON.stringify(forModel(result))}\n\nWrite a summary for the engineer who owns this account: the total monthly waste, then the findings in the order they should be dealt with, grouping ones that are the same kind of problem. For each, give the monthly cost, why it is waste in one sentence, and how risky the fix is. Finish with the single action that saves the most for the least risk. Keep it under 250 words.`;

/**
 * How long one model request may take, and one retry. The provider SDKs wait
 * ten minutes and retry twice by default, which leaves a scan that has already
 * finished looking hung; past this the summary falls back to the templated one.
 */
export const modelRequest = () => ({ timeout: Number(process.env.CLOUDPILOT_MODEL_TIMEOUT_MS) || 120_000, maxRetries: 1 });

export class MissingCredentialsError extends Error {
  constructor() {
    super("No model access configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --bedrock-profile to use Claude through Amazon Bedrock.");
  }
}

interface AskBase {
  result: ScanResult;
  llm?: LlmOptions;
  /** Called with the name of each tool the model uses, for progress output. */
  onToolUse?: (name: string) => void;
}

export interface AccountAskContext extends AskBase {
  /** One inventory and one price book per scanned region. */
  inventories: Inventory[];
  prices: PriceBook[];
  /** Live, read-only CPU lookup for one instance. */
  cpuHistory: (region: string, instanceId: string, hours: number) => Promise<unknown>;
}

/** A cluster question is answered from the scan alone: the model never reads the cluster. */
export interface ClusterAskContext extends AskBase {
  cluster: ClusterInventory;
}

export type AskContext = AccountAskContext | ClusterAskContext;

/** A lookup the model may call. Every one is read-only. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties: false };
  /** Arguments come from the model, so each tool checks them itself. */
  run: (args: Record<string, unknown>) => Promise<string>;
}

const INVENTORY_KINDS = ["volumes", "snapshots", "images", "instances", "rdsInstances", "addresses", "natGateways", "loadBalancers", "buckets"] as const;
type InventoryKind = (typeof INVENTORY_KINDS)[number];

/** The findings, the same lookup for an account and for a cluster. */
const listFindings = (result: () => ScanResult): ToolSpec => ({
  name: "list_findings",
  description:
    "Return every waste finding from the scan: pattern, resource IDs, evidence, monthly cost in USD, the proposed fix commands with their risk level, and the total. Call this first for any question about savings or what to fix.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async () => JSON.stringify(forModel(result())),
});

/**
 * A cluster's workloads as a model should read them: requests and peaks in the
 * units a manifest uses, under the identity of the scan they come from, so a
 * model never reads one cluster's workloads as another's.
 */
export function workloadsForModel(inventory: ClusterInventory) {
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

/** What the model is told a cluster's workloads lookup holds. The MCP server adds how it gets a cluster to read. */
const WORKLOADS_DESCRIPTION =
  "Return the kubectl context, namespaces, Prometheus, lookback and time of the latest cluster scan, whatever it could not read (warnings), and every Deployment, StatefulSet and DaemonSet it read, including those NOT flagged: replicas, and for each container its CPU and memory request, its peak use over the history Prometheus holds, how many hours of history that is, and whether it has been killed for running out of memory. Use it to answer what a workload asks for and uses, or why one was not flagged. A warning means the list is incomplete: say so rather than calling a workload absent.";

/** The cluster's workloads, flagged or not. Used by the ask command and by the MCP server, which says more about when it scans. */
export const clusterWorkloads = (read: () => Promise<ClusterInventory>, addendum = ""): ToolSpec => ({
  name: "get_cluster_workloads",
  description: `${WORKLOADS_DESCRIPTION}${addendum}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run: async () => JSON.stringify(workloadsForModel(await read())),
});

export function buildTools(ctx: AskContext): ToolSpec[] {
  if ("cluster" in ctx) return [listFindings(() => ctx.result), clusterWorkloads(async () => ctx.cluster)];
  return [
    listFindings(() => ctx.result),
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
