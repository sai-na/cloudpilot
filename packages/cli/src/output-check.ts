/**
 * Guard on model-written text: every resource ID and dollar amount in it must
 * already exist in the scan data. One invented value and the text is thrown away.
 * For a cluster scan the guard also covers workload and volume IDs, the
 * namespaces and context a command names, and CPU and memory quantities.
 */
import { workloadsForModel } from "./advisor.js";
import type { ClusterInventory } from "./kube.js";
import type { Inventory, PriceBook, ScanResult } from "./types.js";

const RESOURCE_ID = /\b(?:vol|snap|ami|i|eipalloc|eipassoc|eni|lt|sg|subnet|vpc)-[0-9a-f]{8,}\b/g;
const DOLLARS = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;

/**
 * A Kubernetes object as kubectl names it: the whole kind, a slash and the
 * name, optionally with its namespace in front (shop/deployment/reports).
 * Only whole kinds count. Short forms (deploy, pvc, sts) are also everyday
 * words and file names, and every ID a scan prints uses the whole kind.
 * Read whatever the case, because the data also names kinds as Kubernetes
 * does (resourceType "Deployment", the workloads lookup's kind), and a name
 * and a namespace are both DNS-1123, so one object has one lower-case form.
 * Not preceded by a word character, dot or hyphen, so neither a longer word
 * nor a name ending in one of these kinds (non-deployment/x) is read as one.
 */
const OBJECT = /(?<![\w.-])(?:([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/)?(deployment|statefulset|daemonset|persistentvolumeclaim|persistentvolume)\/([a-z0-9](?:[-a-z0-9.]*[a-z0-9])?)(?![\w/-])/gi;
/**
 * Address in a URL, which can look like an object (docs/deployment/rolling) and
 * is not one. Stopped at a quote or backslash as well as whitespace: the scan
 * data is read as JSON, where one unbounded match would swallow every field
 * after the API server's address.
 */
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`\\]*/gi;
/**
 * Where a command is pointed: --namespace=shop, --context kind-lab, and -n shop
 * on a line that runs kubectl: elsewhere "-n" is just as likely to be prose.
 */
const NAMESPACE_FLAG = /(?<![\w-])--namespace[ =]([a-z0-9][-a-z0-9]*)/g;
const SHORT_NAMESPACE_FLAG = /(?<![\w-])-n[ =]([a-z0-9][-a-z0-9]*)/g;
const CONTEXT_FLAG = /(?<![\w-])--context[ =]([^\s'"`]+)/g;
/** A Kubernetes quantity: 300m of a CPU, or memory in binary units. Whole CPUs and plain bytes are not matched. */
const QUANTITY = /(?<![\w.])\d+(?:\.\d+)?(?:m|Ki|Mi|Gi|Ti)(?!\w)/g;
/** Names that are kinds themselves, as in the prose "deployment/statefulset": never a workload's name. */
const KIND_WORDS = new Set(["deployment", "statefulset", "daemonset", "persistentvolumeclaim", "persistentvolume"]);
/** Objects with no namespace of their own. */
const CLUSTER_SCOPED = new Set(["persistentvolume"]);

export interface Allowed {
  ids: Set<string>;
  amounts: number[];
  /** Only for a cluster scan: what a cluster's text may name. */
  cluster?: {
    /** shop/deployment/reports, for the objects that have a namespace. */
    qualified: Set<string>;
    namespaces: Set<string>;
    contexts: Set<string>;
    quantities: Set<string>;
  };
}

interface ObjectMention {
  /** As written in the text. */
  written: string;
  namespace?: string;
  id: string;
  kind: string;
}

function objectsIn(text: string): ObjectMention[] {
  return [...text.replace(URL, " ").matchAll(OBJECT)]
    .map((m) => ({ written: m[0], namespace: m[1]?.toLowerCase(), kind: m[2]!.toLowerCase(), name: m[3]!.toLowerCase() }))
    .filter(({ name }) => !KIND_WORDS.has(name))
    .map(({ written, namespace, kind, name }) => ({ written, namespace, kind, id: `${kind}/${name}` }));
}

/** Everything the model was given and may therefore repeat. */
export function allowedValues(result: ScanResult, extra?: { inventories?: Inventory[]; prices?: PriceBook[]; cluster?: ClusterInventory }): Allowed {
  // What the model reads of a cluster beyond the findings is its workloads, flagged or not.
  const workloads = extra?.cluster ? workloadsForModel(extra.cluster) : null;
  const source = JSON.stringify([result, extra?.inventories ?? null, workloads]);
  const amounts = [
    result.totalMonthlyWasteUsd,
    ...(result.comparison
      ? [result.comparison.newMonthlyUsd, result.comparison.resolvedMonthlyUsd, ...result.comparison.resolved.map((r) => r.monthlyCostUsd)]
      : []),
    ...result.findings.flatMap((f) => [f.monthlyCostUsd, ...(f.alternative ? [f.alternative.monthlySavingUsd] : [])]),
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
  const allowed: Allowed = { ids: new Set(source.match(RESOURCE_ID) ?? []), amounts };

  if (result.cluster) {
    const { prices } = result.cluster;
    amounts.push(prices.cpuHourUsd, prices.memoryGibHourUsd, prices.storageGibMonthUsd);
    const qualified = new Set<string>();
    const namespaces = new Set([...result.regions, ...(extra?.cluster?.namespaces ?? [])]);
    const mentioned = [
      // Whatever the scan data names, in its ID fields, commands and notes alike.
      ...objectsIn(source.replace(/\\[nrt"]/g, " ")),
      ...result.findings.flatMap((f) =>
        f.resourceIds.flatMap((id) => objectsIn(id).map((o) => ({ ...o, namespace: CLUSTER_SCOPED.has(o.kind) ? undefined : f.region }))),
      ),
      // A comparison names what the previous scan found and this one no longer does,
      // with its namespace, so the model may name it that way too.
      ...(result.comparison?.resolved ?? []).flatMap((r) =>
        r.resourceIds.flatMap((id) => objectsIn(id).map((o) => ({ ...o, namespace: CLUSTER_SCOPED.has(o.kind) ? undefined : r.region }))),
      ),
      ...(extra?.cluster?.workloads ?? []).map((w) => {
        const kind = w.kind.toLowerCase();
        return { written: "", namespace: w.namespace, kind, id: `${kind}/${w.name}` };
      }),
    ];
    for (const o of mentioned) {
      allowed.ids.add(o.id);
      if (o.namespace) qualified.add(`${o.namespace}/${o.id}`);
    }
    allowed.cluster = {
      qualified,
      namespaces,
      contexts: new Set([result.cluster.context]),
      quantities: new Set(source.match(QUANTITY) ?? []),
    };
  }
  return allowed;
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

  const cluster = allowed.cluster;
  if (cluster) {
    const unknown = new Set<string>();
    for (const o of objectsIn(text)) {
      if (!(o.namespace ? cluster.qualified.has(`${o.namespace}/${o.id}`) : allowed.ids.has(o.id))) unknown.add(o.written);
    }
    const shorts = text.split("\n").filter((line) => line.includes("kubectl")).flatMap((line) => [...line.matchAll(SHORT_NAMESPACE_FLAG)]);
    for (const m of [...text.matchAll(NAMESPACE_FLAG), ...shorts]) {
      if (!cluster.namespaces.has(m[1]!)) unknown.add(m[0]);
    }
    for (const m of text.matchAll(CONTEXT_FLAG)) {
      // Sentence punctuation after a context is not part of its name.
      if (!cluster.contexts.has(m[1]!.replace(/[.,;:)]+$/, ""))) unknown.add(m[0]);
    }
    for (const q of text.match(QUANTITY) ?? []) {
      if (!cluster.quantities.has(q)) unknown.add(q);
    }
    bad.push(...unknown);
  }
  return bad;
}
