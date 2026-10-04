/**
 * Everything CloudPilot reads from a Kubernetes cluster.
 *
 * The only way in is `kubectl get --raw <path>`, which can do nothing but GET.
 * kubectl brings whatever sign-in the cluster needs (certificates, tokens,
 * the EKS, GKE and AKS plugins), so CloudPilot holds no credentials of its
 * own. Usage history comes from the cluster's Prometheus, reached through the
 * API server's service proxy with the same access.
 */
import { execFile } from "node:child_process";

export interface KubeReader {
  /** GET one path on the API server and parse the JSON it answers with. */
  get(path: string): Promise<any>;
  /** The kubectl context being read, and the server behind it. Inside a cluster with no kubeconfig, `context` is the name the cluster was given and `inCluster` is true. */
  identity(): Promise<{ context: string; server?: string; inCluster?: boolean }>;
}

/** kubectl is not installed, or not on the PATH. */
export class KubectlNotFoundError extends Error {
  constructor() {
    super("kubectl was not found on your PATH. CloudPilot reads a cluster through kubectl, with the access you already have.");
    this.name = "KubectlNotFoundError";
  }
}

/** Running in a cluster, with no kubeconfig context to name it, and told no name for it. */
export class ClusterNameRequiredError extends Error {
  constructor() {
    super(
      "CloudPilot is running inside a cluster, where there is no kubeconfig and so no context name. " +
        "Name the cluster with --cluster-name <name> (or CLOUDPILOT_CLUSTER_NAME): the kubectl context name your team uses for it on their own machines. " +
        "The fix commands CloudPilot prints carry --context <name>, so that a pasted command cannot reach a different cluster.",
    );
    this.name = "ClusterNameRequiredError";
  }
}

/**
 * Every pod is told where its API server is. kubectl reads the same two
 * variables, and the pod's service account, when it has no kubeconfig. This is
 * the one test for "running in a cluster", and it decides whether a name given
 * for the cluster is used at all: everything that speaks about a cluster
 * before it has been read asks here rather than guessing.
 */
export const inCluster = () => Boolean(process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT);

/**
 * The name given to a cluster that has no context. It goes into `--context`
 * in commands people paste, so it must be one word a shell passes on as it is:
 * context names such as an EKS ARN or a GKE name are fine, quotes and spaces are not.
 */
export function parseClusterName(text: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@=+,-]*$/.test(text) || text.length > 253) {
    throw new Error(`"${text}" cannot be a cluster name: use the kubectl context name your team uses for it, which has no spaces, quotes or shell characters in it.`);
  }
  return text;
}

/**
 * Reads through the kubectl on the PATH. It has no way to write. With a
 * timeout, a call that has not answered by then is stopped. With no context
 * and no kubeconfig context to find, inside a cluster, kubectl uses the pod's
 * service account and the cluster is known by `clusterName`.
 */
export function kubectlReader(context?: string, timeoutMs?: number, clusterName?: string): KubeReader {
  const scoped = context ? ["--context", context] : [];
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile("kubectl", [...scoped, ...args], { maxBuffer: 512 * 1024 * 1024, ...(timeoutMs ? { timeout: timeoutMs } : {}) }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new KubectlNotFoundError());
        if (error.killed && timeoutMs) return reject(new Error(`kubectl did not answer within ${timeoutMs / 1000} seconds.`));
        reject(new Error((stderr || error.message).trim()));
      });
    });
  return {
    get: async (path) => JSON.parse(await run(["get", "--raw", path])),
    identity: async () => {
      // A pod has no kubeconfig, and `config view --minify` then fails for want of a current context.
      const podLike = !context && inCluster();
      let view: any = {};
      try {
        view = JSON.parse(await run(["config", "view", "--minify", "-o", "json"]));
      } catch (err) {
        if (!podLike || !/current-context/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
      const name = view.contexts?.[0]?.name ?? view["current-context"];
      if (name) return { context: String(name), server: view.clusters?.[0]?.cluster?.server };
      if (!podLike) throw new Error("kubectl has no current context. Choose one with --context.");
      if (!clusterName) throw new ClusterNameRequiredError();
      const host = process.env.KUBERNETES_SERVICE_HOST!;
      return { context: clusterName, server: `https://${host.includes(":") ? `[${host}]` : host}:${process.env.KUBERNETES_SERVICE_PORT}`, inCluster: true };
    },
  };
}

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

export interface WorkloadContainer {
  name: string;
  cpuRequestCores?: number;
  memoryRequestBytes?: number;
  /** A pod of this workload has had this container killed for running out of memory. */
  oomKilled: boolean;
  /** The busiest five minutes of any pod of the workload, over the history Prometheus holds. */
  cpuPeakCores?: number;
  memoryPeakBytes?: number;
  /** How much of the window asked for Prometheus actually has figures for. */
  historyHours?: number;
}

export interface Workload {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  /** Pods of the workload that are running or about to. */
  replicas: number;
  /** Labelled or annotated cloudpilot/ignore=true, so no finding is raised for it. */
  ignored: boolean;
  containers: WorkloadContainer[];
  /** How many of its pods are bound to each node, by node name. Absent when no pod of it is bound to a node. */
  nodes?: Record<string, number>;
}

/** Why a node takes no part in the question of which nodes could be removed. */
export type NodeLeftOut = "control-plane" | "tainted" | "cordoned";

/** One node, with the requests of the pods bound to it. Only read for the advisories. */
export interface NodeInfo {
  name: string;
  /** What the node offers to pods: its capacity less what the system reserves. */
  allocatableCpuCores: number;
  allocatableMemoryBytes: number;
  /** Set when the node runs the control plane, carries a NoSchedule or NoExecute taint, or is cordoned. */
  leftOut?: NodeLeftOut;
  /** The requests of every pod bound to it that has not finished, in every namespace. */
  requestedCpuCores: number;
  requestedMemoryBytes: number;
  pods: number;
}

/** What one container's pod status says. Only what the advisories read. */
export interface ContainerFacts {
  name: string;
  cpuRequestCores?: number;
  memoryRequestBytes?: number;
  memoryLimitBytes?: number;
  restartCount: number;
  /** The reason the container is waiting, for example CrashLoopBackOff. */
  waitingReason?: string;
  /** How it last stopped, from lastState or, for a container that has stopped for good, state. */
  terminated?: { reason?: string; exitCode?: number; finishedAt?: string };
}

/** One pod that has not finished, as the advisories read it. */
export interface PodFacts {
  namespace: string;
  name: string;
  phase: string;
  /** What owns it: the workload for a pod of a Deployment, StatefulSet or DaemonSet, the controller otherwise, nothing for a bare pod. */
  owner?: { kind: string; name: string };
  /** Whether its owner is a workload that rules judge: a Deployment, StatefulSet or DaemonSet. */
  ownerIsWorkload: boolean;
  createdAt?: string;
  containers: ContainerFacts[];
  /** Set when the scheduler has said it cannot place the pod: its PodScheduled condition is False. */
  unscheduled?: { reason?: string; message?: string; since?: string };
  /** The pod or its workload is labelled cloudpilot/ignore=true. */
  ignored: boolean;
}

export interface ClaimInfo {
  name: string;
  namespace: string;
  phase: string;
  capacityBytes: number;
  storageClass?: string;
  volumeName?: string;
  /** What happens to the data when the claim is deleted: Delete or Retain. */
  reclaimPolicy?: string;
  createdAt?: string;
  /** Pods that mount it and have not finished. */
  mountedBy: string[];
  ignored: boolean;
}

export interface PersistentVolumeInfo {
  name: string;
  phase: string;
  capacityBytes: number;
  storageClass?: string;
  reclaimPolicy?: string;
  /** The claim it was last bound to. */
  claim?: { namespace: string; name: string };
  ignored: boolean;
}

export interface ClusterInventory {
  context: string;
  server?: string;
  collectedAt: string;
  /** Every namespace that was read. */
  namespaces: string[];
  workloads: Workload[];
  claims: ClaimInfo[];
  volumes: PersistentVolumeInfo[];
  /** The Prometheus the usage figures came from, as namespace/service:port. Undefined when none answered. */
  prometheus?: string;
  lookbackHours: number;
  /** Reads that failed. Findings that depend on them are skipped. */
  warnings: string[];
  /** Absent when the advisories were not asked for, or in an inventory built without them. */
  advisories?: {
    /** Every node of the cluster. Absent when they could not be read. */
    nodes?: NodeInfo[];
    /** Pods that have not finished, in the namespaces read. */
    pods: PodFacts[];
    /** Advisory reads that could not be made. Kept apart from `warnings`: they never make a comparison doubt the findings. */
    warnings: string[];
  };
}

/** Run by the cluster itself and not the reader's to resize. */
const SYSTEM_NAMESPACES = new Set(["kube-system", "kube-public", "kube-node-lease"]);

const CPU_SUFFIX: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3 };
const BYTE_SUFFIX: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

function quantity(value: unknown, suffixes: Record<string, number>): number | undefined {
  if (value === undefined || value === null) return undefined;
  const match = /^([0-9.]+(?:e[+-]?[0-9]+)?)([A-Za-z]*)$/.exec(String(value).trim());
  const scale = match ? suffixes[match[2]!] : undefined;
  return match && scale !== undefined ? Number(match[1]) * scale : undefined;
}

/** A Kubernetes CPU quantity ("500m", "2") in cores. */
export const parseCpu = (value: unknown) => quantity(value, CPU_SUFFIX);
/** A Kubernetes memory or storage quantity ("64Mi", "1Gi") in bytes. */
export const parseBytes = (value: unknown) => quantity(value, BYTE_SUFFIX);

const isIgnored = (meta: any) => meta?.labels?.["cloudpilot/ignore"] === "true" || meta?.annotations?.["cloudpilot/ignore"] === "true";

/** Every item of a list endpoint, following the continue token page by page. */
export async function list(reader: KubeReader, path: string): Promise<any[]> {
  const items: any[] = [];
  let next = "";
  do {
    const page = await reader.get(`${path}?limit=500${next ? `&continue=${encodeURIComponent(next)}` : ""}`);
    items.push(...(page.items ?? []));
    next = page.metadata?.continue ?? "";
  } while (next);
  return items;
}

/** The characters Kubernetes draws generated name suffixes from. */
const HASH = "[bcdfghjklmnpqrstvwxz2456789]";

/** Matches the pods a workload has had, including ones already gone, by how Kubernetes names them. */
function podPattern(workload: Pick<Workload, "kind" | "name">): RegExp {
  const name = workload.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (workload.kind === "Deployment") return new RegExp(`^${name}-${HASH}{5,10}-${HASH}{5}$`);
  if (workload.kind === "StatefulSet") return new RegExp(`^${name}-[0-9]+$`);
  return new RegExp(`^${name}-${HASH}{5}$`);
}

export interface PrometheusRef {
  namespace: string;
  service: string;
  port: string;
}

export const prometheusLabel = (p: PrometheusRef) => `${p.namespace}/${p.service}:${p.port}`;

/**
 * Kubernetes names a namespace or a service with a DNS-1123 label. Names are
 * put into API server paths and into PromQL label matchers, so one holding a
 * slash or a quote would change which path is read or which series a query
 * selects: refuse it instead.
 */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function dnsLabel(what: string, value: string): string {
  if (!DNS_LABEL.test(value) || value.length > 63) {
    throw new Error(`"${value}" is not a Kubernetes ${what} name: lower-case letters, digits and dashes, up to 63 characters.`);
  }
  return value;
}

/** A service port as the API server's proxy path takes it: a number, or a named port. */
function servicePort(value: string): string {
  const number = /^[0-9]+$/.test(value) ? Number(value) : undefined;
  const bad = number === undefined ? !DNS_LABEL.test(value) || value.length > 15 : number < 1 || number > 65535;
  if (bad) throw new Error(`"${value}" is not a service port: a number from 1 to 65535, or a port name.`);
  return value;
}

export function parsePrometheusRef(text: string): PrometheusRef {
  const match = /^([^/\s]+)\/([^:\s]+):([^\s]+)$/.exec(text);
  if (!match) throw new Error(`--prometheus takes namespace/service:port, for example monitoring/prometheus:9090. Got "${text}".`);
  return { namespace: dnsLabel("namespace", match[1]!), service: dnsLabel("service", match[2]!), port: servicePort(match[3]!) };
}

/** Services that look like a Prometheus server, likeliest first. */
export function prometheusCandidates(services: any[]): PrometheusRef[] {
  const others = /alertmanager|exporter|operator|pushgateway|kube-state-metrics|adapter|blackbox/;
  return services
    .filter((s) => /prometheus/.test(s.metadata?.name ?? "") && !others.test(s.metadata?.name ?? ""))
    .flatMap((s) => {
      const ports: any[] = s.spec?.ports ?? [];
      const port = ports.find((p) => p.port === 9090) ?? ports.find((p) => ["http", "web", "http-web"].includes(p.name)) ?? ports.find((p) => p.port === 80);
      return port ? [{ namespace: s.metadata.namespace, service: s.metadata.name, port: String(port.port) }] : [];
    })
    .sort((a, b) => a.service.length - b.service.length);
}

type Series = Array<{ namespace: string; pod: string; container: string; value: number }>;

export async function query(reader: KubeReader, prometheus: PrometheusRef, promql: string): Promise<Series> {
  const path = `/api/v1/namespaces/${prometheus.namespace}/services/${prometheus.service}:${prometheus.port}/proxy/api/v1/query?query=${encodeURIComponent(promql)}`;
  const answer = await reader.get(path);
  if (answer?.status !== "success") throw new Error(answer?.error ?? "Prometheus did not answer the query");
  return (answer.data?.result ?? []).map((r: any) => ({
    namespace: String(r.metric?.namespace ?? ""),
    pod: String(r.metric?.pod ?? ""),
    container: String(r.metric?.container ?? ""),
    value: Number(r.value?.[1]),
  }));
}

export interface CollectClusterOptions {
  /** Read only this namespace. */
  namespace?: string;
  /** Where Prometheus is; found by looking at the cluster's services when not given. */
  prometheus?: PrometheusRef;
  lookbackHours: number;
  now?: Date;
  /** Also read what the advisories need: the nodes, and the pods' status. On unless set to false. */
  advisories?: boolean;
}

/**
 * Text a cluster hands back, made safe to print: no control characters, none of
 * the invisible marks that change the direction or the joining of what follows
 * them, and no longer than `max`. The second group goes too because the text is
 * printed to a terminal and written into the Markdown and HTML reports, and in
 * all three a left-over override can make a line read as something other than
 * what the cluster stored.
 */
export function safeText(text: unknown, max = 240): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/**
 * A name from the cluster, made safe to print. The API server checks most
 * names, but an owner reference's kind and name only have to be non-empty, so
 * a name can hold anything. Every character outside a valid name's own is shown
 * as "?" (not trimmed or collapsed, so a name never reads as another object's),
 * which keeps terminal control bytes, quotes, backticks and markup out of
 * everything printed. A valid name comes back as it was.
 */
export function displayName(value: unknown, max = 253): string {
  const text = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "?");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** A DNS-1123 subdomain: how Kubernetes names most objects, pods, nodes, claims and volumes among them. */
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const isSubdomain = (value: string) => value.length <= 253 && DNS_SUBDOMAIN.test(value);
const isLabel = (value: string) => value.length <= 63 && DNS_LABEL.test(value);

/**
 * The first of these names that is not a valid Kubernetes name, shown safely, or
 * undefined when all are. A namespace or a container is a DNS-1123 label, the
 * rest a subdomain. A command is printed only for names that pass. What comes
 * back is never the empty string, so a caller may read it as a plain yes or no:
 * an empty name is itself invalid, and the one it is most important to catch.
 */
export function invalidName(names: { subdomain?: string[]; label?: string[] }): string | undefined {
  const bad = names.subdomain?.find((n) => !isSubdomain(n)) ?? names.label?.find((n) => !isLabel(n));
  return bad === undefined ? undefined : displayName(bad) || "(empty)";
}

/** Why a finding for an object with an invalid name carries no command. */
export const noCommandFor = (shown: string) => `No command is printed for it: "${shown}" is not a valid Kubernetes name, and a command pasted with a name like that could act on something else.`;

const requestOf = (pod: any, resource: "cpu" | "memory") =>
  (pod.spec?.containers ?? []).reduce((sum: number, c: any) => sum + ((resource === "cpu" ? parseCpu(c.resources?.requests?.cpu) : parseBytes(c.resources?.requests?.memory)) ?? 0), 0);

const CONTROL_PLANE_ROLES = ["node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master"];

/** The nodes, each with what the pods bound to it request. A node whose allocatable CPU or memory is missing, or is not a figure above zero, can hold nothing and cannot be counted: it is named in `skipped`. */
function nodesFrom(nodes: any[], pods: any[], skipped: string[]): NodeInfo[] {
  const load = new Map<string, { cpu: number; memory: number; pods: number }>();
  for (const pod of pods) {
    const node = pod.spec?.nodeName;
    if (!node || ["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
    const seen = load.get(node) ?? { cpu: 0, memory: 0, pods: 0 };
    load.set(node, { cpu: seen.cpu + requestOf(pod, "cpu"), memory: seen.memory + requestOf(pod, "memory"), pods: seen.pods + 1 });
  }
  const out: NodeInfo[] = [];
  for (const node of nodes) {
    const raw = String(node.metadata?.name ?? "");
    const name = displayName(raw);
    const cpu = parseCpu(node.status?.allocatable?.cpu);
    const memory = parseBytes(node.status?.allocatable?.memory);
    if (!raw || !cpu || !memory) {
      skipped.push(name || "(unnamed)");
      continue;
    }
    const labels = node.metadata?.labels ?? {};
    const tainted = (node.spec?.taints ?? []).some((t: any) => t.effect === "NoSchedule" || t.effect === "NoExecute");
    const leftOut: NodeLeftOut | undefined = CONTROL_PLANE_ROLES.some((role) => role in labels) ? "control-plane" : tainted ? "tainted" : node.spec?.unschedulable ? "cordoned" : undefined;
    const used = load.get(raw);
    out.push({ name, allocatableCpuCores: cpu, allocatableMemoryBytes: memory, ...(leftOut ? { leftOut } : {}), requestedCpuCores: Math.round((used?.cpu ?? 0) * 1000) / 1000, requestedMemoryBytes: used?.memory ?? 0, pods: used?.pods ?? 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the cluster's workloads, volumes and usage history. Nothing here can change the cluster. */
export async function collectCluster(reader: KubeReader, options: CollectClusterOptions): Promise<ClusterInventory> {
  const now = options.now ?? new Date();
  const namespace = options.namespace === undefined ? undefined : dnsLabel("namespace", options.namespace);
  const { context, server } = await reader.identity();
  const warnings: string[] = [];
  const scoped = (group: string, resource: string) => (namespace ? `${group}/namespaces/${namespace}/${resource}` : `${group}/${resource}`);
  const attempt = async (what: string, path: string): Promise<any[]> => {
    try {
      return await list(reader, path);
    } catch (err) {
      warnings.push(`${what} could not be read: ${firstLine(err)}`);
      return [];
    }
  };

  const namespaces = namespace
    ? [namespace]
    : (await list(reader, "/api/v1/namespaces")).map((n) => String(n.metadata.name)).filter((n) => !SYSTEM_NAMESPACES.has(n)).sort();
  const wanted = new Set(namespaces);

  // Every pod the API server returned: a node is loaded by the pods of every namespace, the cluster's own included.
  const everyPod = await list(reader, scoped("/api/v1", "pods"));
  const pods = everyPod.filter((p) => wanted.has(p.metadata.namespace));
  const replicaSets = await attempt("ReplicaSets", scoped("/apis/apps/v1", "replicasets"));
  const claims = (await attempt("PersistentVolumeClaims", scoped("/api/v1", "persistentvolumeclaims"))).filter((c) => wanted.has(c.metadata.namespace));
  const volumes = await attempt("PersistentVolumes", "/api/v1/persistentvolumes");

  // A Deployment's pods belong to a ReplicaSet, which belongs to the Deployment.
  const deploymentOf = new Map<string, string>();
  for (const rs of replicaSets) {
    const owner = (rs.metadata.ownerReferences ?? []).find((o: any) => o.kind === "Deployment");
    if (owner) deploymentOf.set(`${rs.metadata.namespace}/${rs.metadata.name}`, owner.name);
  }

  const workloads = new Map<string, Workload>();
  const workloadOfPod = new Map<string, Workload>();
  const wantAdvisories = options.advisories !== false;
  const podFacts: PodFacts[] = [];
  // Maps are keyed by the names as the cluster gave them; what is stored and printed is the safe form.
  const podKeys: string[] = [];
  for (const pod of pods) {
    if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
    const owner = (pod.metadata.ownerReferences ?? []).find((o: any) => o.controller) ?? pod.metadata.ownerReferences?.[0];
    const namespace: string = pod.metadata.namespace;
    if (wantAdvisories) {
      podFacts.push(podFactsOf(pod, owner, deploymentOf));
      podKeys.push(`${namespace}/${pod.metadata.name}`);
    }
    if (!owner) continue;
    let kind: WorkloadKind;
    let name: string = owner.name;
    if (owner.kind === "ReplicaSet") {
      const deployment = deploymentOf.get(`${namespace}/${owner.name}`);
      if (!deployment) continue;
      kind = "Deployment";
      name = deployment;
    } else if (owner.kind === "StatefulSet" || owner.kind === "DaemonSet") {
      kind = owner.kind;
    } else {
      // Jobs and bare pods come and go: there is no standing request to resize.
      continue;
    }

    const key = `${namespace}/${kind}/${name}`;
    let workload = workloads.get(key);
    if (!workload) {
      workload = { kind, name: displayName(name), namespace: displayName(namespace, 63), replicas: 0, ignored: false, containers: [] };
      workloads.set(key, workload);
    }
    workload.replicas += 1;
    if (pod.spec?.nodeName) {
      const node = displayName(pod.spec.nodeName);
      workload.nodes ??= {};
      workload.nodes[node] = (workload.nodes[node] ?? 0) + 1;
    }
    workload.ignored ||= isIgnored(pod.metadata);
    workloadOfPod.set(`${namespace}/${pod.metadata.name}`, workload);
    for (const spec of pod.spec?.containers ?? []) {
      const containerName = displayName(spec.name, 63);
      let container = workload.containers.find((c) => c.name === containerName);
      if (!container) {
        container = {
          name: containerName,
          cpuRequestCores: parseCpu(spec.resources?.requests?.cpu),
          memoryRequestBytes: parseBytes(spec.resources?.requests?.memory),
          oomKilled: false,
        };
        workload.containers.push(container);
      }
      const status = (pod.status?.containerStatuses ?? []).find((s: any) => s.name === spec.name);
      if (status?.lastState?.terminated?.reason === "OOMKilled" || status?.state?.terminated?.reason === "OOMKilled") container.oomKilled = true;
    }
  }

  // The label is usually put on the workload itself, which its pods do not inherit.
  for (const [kind, resource] of [["Deployment", "deployments"], ["StatefulSet", "statefulsets"], ["DaemonSet", "daemonsets"]] as const) {
    if (![...workloads.values()].some((w) => w.kind === kind)) continue;
    for (const object of await attempt(`${kind}s`, scoped("/apis/apps/v1", resource))) {
      const workload = workloads.get(`${object.metadata.namespace}/${kind}/${object.metadata.name}`);
      if (workload && isIgnored(object.metadata)) workload.ignored = true;
    }
  }

  const prometheus = await readUsage(reader, {
    given: options.prometheus,
    namespace,
    lookbackHours: options.lookbackHours,
    now,
    workloads: [...workloads.values()],
    workloadOfPod,
    warnings,
  });

  let advisories: ClusterInventory["advisories"];
  if (wantAdvisories) {
    const advisoryWarnings: string[] = [];
    let nodes: NodeInfo[] | undefined;
    if (namespace) {
      advisoryWarnings.push("Spare node capacity was not checked: --namespace reads the pods of one namespace only, and a node is loaded by the pods of every namespace.");
    } else {
      try {
        const skipped: string[] = [];
        nodes = nodesFrom(await list(reader, "/api/v1/nodes"), everyPod, skipped);
        if (skipped.length > 0) advisoryWarnings.push(`${skipped.length === 1 ? "A node" : `${skipped.length} nodes`} reported no allocatable CPU or memory and ${skipped.length === 1 ? "was" : "were"} left out of the spare node capacity check: ${skipped.join(", ")}`);
      } catch (err) {
        advisoryWarnings.push(`Spare node capacity could not be checked: the nodes could not be read: ${firstLine(err)}`);
      }
    }
    // A label on the workload is not on its pods: a pod belongs to whatever its workload says.
    podFacts.forEach((fact, n) => (fact.ignored ||= workloadOfPod.get(podKeys[n]!)?.ignored ?? false));
    advisories = { nodes, pods: podFacts, warnings: advisoryWarnings };
  }

  const mounted = new Map<string, string[]>();
  for (const pod of pods) {
    if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
    for (const volume of pod.spec?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const key = `${pod.metadata.namespace}/${claim}`;
      mounted.set(key, [...(mounted.get(key) ?? []), displayName(pod.metadata.name)]);
    }
  }
  const policyOf = new Map<string, string>(volumes.map((v) => [String(v.metadata.name), displayName(v.spec?.persistentVolumeReclaimPolicy)]));

  return {
    context,
    server,
    collectedAt: now.toISOString(),
    namespaces: namespaces.map((n) => displayName(n, 63)),
    workloads: [...workloads.values()].sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)),
    claims: claims.map((c) => ({
      name: displayName(c.metadata.name),
      namespace: displayName(c.metadata.namespace, 63),
      phase: c.status?.phase ?? "",
      capacityBytes: parseBytes(c.status?.capacity?.storage ?? c.spec?.resources?.requests?.storage) ?? 0,
      storageClass: c.spec?.storageClassName === undefined ? undefined : displayName(c.spec.storageClassName),
      volumeName: c.spec?.volumeName === undefined ? undefined : displayName(c.spec.volumeName),
      reclaimPolicy: policyOf.get(c.spec?.volumeName) || undefined,
      createdAt: c.metadata.creationTimestamp,
      mountedBy: mounted.get(`${c.metadata.namespace}/${c.metadata.name}`) ?? [],
      ignored: isIgnored(c.metadata),
    })),
    volumes: volumes
      .filter((v) => !namespace || v.spec?.claimRef?.namespace === namespace)
      .map((v) => ({
        name: displayName(v.metadata.name),
        phase: v.status?.phase ?? "",
        capacityBytes: parseBytes(v.spec?.capacity?.storage) ?? 0,
        storageClass: v.spec?.storageClassName === undefined ? undefined : displayName(v.spec.storageClassName),
        reclaimPolicy: v.spec?.persistentVolumeReclaimPolicy === undefined ? undefined : displayName(v.spec.persistentVolumeReclaimPolicy),
        claim: v.spec?.claimRef ? { namespace: displayName(v.spec.claimRef.namespace, 63), name: displayName(v.spec.claimRef.name) } : undefined,
        ignored: isIgnored(v.metadata),
      })),
    prometheus: prometheus ? prometheusLabel(prometheus) : undefined,
    lookbackHours: options.lookbackHours,
    warnings,
    ...(advisories ? { advisories } : {}),
  };
}

/** What the advisories read of one pod. `owner` is resolved to the Deployment for a pod of a ReplicaSet that belongs to one. */
function podFactsOf(pod: any, owner: any, deploymentOf: Map<string, string>): PodFacts {
  const namespace: string = pod.metadata.namespace;
  let resolved: PodFacts["owner"];
  if (owner?.kind === "ReplicaSet" && deploymentOf.has(`${namespace}/${owner.name}`)) resolved = { kind: "Deployment", name: displayName(deploymentOf.get(`${namespace}/${owner.name}`)!) };
  else if (owner) resolved = { kind: displayName(owner.kind, 63), name: displayName(owner.name) };
  const scheduled = (pod.status?.conditions ?? []).find((c: any) => c.type === "PodScheduled");
  const containers: ContainerFacts[] = (pod.spec?.containers ?? []).map((spec: any) => {
    const status = (pod.status?.containerStatuses ?? []).find((s: any) => s.name === spec.name);
    const stopped = status?.lastState?.terminated ?? status?.state?.terminated;
    return {
      name: displayName(spec.name, 63),
      cpuRequestCores: parseCpu(spec.resources?.requests?.cpu),
      memoryRequestBytes: parseBytes(spec.resources?.requests?.memory),
      memoryLimitBytes: parseBytes(spec.resources?.limits?.memory),
      restartCount: Number(status?.restartCount ?? 0),
      ...(status?.state?.waiting?.reason ? { waitingReason: safeText(status.state.waiting.reason, 80) } : {}),
      ...(stopped
        ? { terminated: { reason: stopped.reason === undefined ? undefined : safeText(stopped.reason, 80), exitCode: typeof stopped.exitCode === "number" ? stopped.exitCode : undefined, finishedAt: stopped.finishedAt === undefined ? undefined : safeText(stopped.finishedAt, 40) } }
        : {}),
    };
  });
  return {
    namespace: displayName(namespace, 63),
    name: displayName(pod.metadata.name),
    phase: String(pod.status?.phase ?? ""),
    owner: resolved,
    ownerIsWorkload: resolved !== undefined && ["Deployment", "StatefulSet", "DaemonSet"].includes(resolved.kind),
    createdAt: pod.metadata.creationTimestamp,
    containers,
    ...(pod.status?.phase === "Pending" && scheduled?.status === "False"
      ? { unscheduled: { reason: scheduled.reason === undefined ? undefined : safeText(scheduled.reason, 80), message: scheduled.message === undefined ? undefined : String(scheduled.message), since: scheduled.lastTransitionTime === undefined ? undefined : safeText(scheduled.lastTransitionTime, 40) } }
      : {}),
    ignored: isIgnored(pod.metadata),
  };
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** Fill in each container's peak use from Prometheus. Returns the Prometheus that answered, if any did. */
async function readUsage(
  reader: KubeReader,
  input: {
    given?: PrometheusRef;
    namespace?: string;
    lookbackHours: number;
    now: Date;
    workloads: Workload[];
    workloadOfPod: Map<string, Workload>;
    warnings: string[];
  },
): Promise<PrometheusRef | undefined> {
  if (input.workloads.length === 0) return input.given;
  const without = "Requests were not compared with real use.";

  let candidates = input.given ? [input.given] : [];
  if (!input.given) {
    try {
      candidates = prometheusCandidates(await list(reader, "/api/v1/services"));
    } catch (err) {
      input.warnings.push(`Services could not be read to find Prometheus: ${firstLine(err)}. ${without} Name it with --prometheus namespace/service:port.`);
      return undefined;
    }
  }
  if (candidates.length === 0) {
    input.warnings.push(`No Prometheus service was found in the cluster. ${without} Name one with --prometheus namespace/service:port.`);
    return undefined;
  }

  const minutes = Math.max(5, Math.round(input.lookbackHours * 60));
  const where = `container!="",container!="POD"${input.namespace ? `,namespace="${input.namespace}"` : ""}`;
  const by = "by (namespace, pod, container)";
  // Peak CPU is the busiest five minutes; peak memory is the highest working set.
  const cpuQuery = `max ${by} (max_over_time(rate(container_cpu_usage_seconds_total{${where}}[5m])[${minutes}m:1m]))`;
  const memoryQuery = `max ${by} (max_over_time(container_memory_working_set_bytes{${where}}[${minutes}m]))`;
  // The first moment each container has a figure, to say how much history the peak is taken from.
  const firstSeenQuery = `min ${by} (min_over_time(timestamp(container_memory_working_set_bytes{${where}})[${minutes}m:1m]))`;

  let answered: PrometheusRef | undefined;
  let cpu: Series = [];
  let memory: Series = [];
  let firstSeen: Series = [];
  let lastError = "";
  for (const candidate of candidates) {
    try {
      memory = await query(reader, candidate, memoryQuery);
      cpu = await query(reader, candidate, cpuQuery);
      firstSeen = await query(reader, candidate, firstSeenQuery);
      answered = candidate;
      break;
    } catch (err) {
      lastError = firstLine(err);
    }
  }
  if (!answered) {
    input.warnings.push(`Prometheus (${candidates.map(prometheusLabel).join(", ")}) could not be queried: ${lastError}. ${without}`);
    return undefined;
  }
  if (memory.length === 0) {
    input.warnings.push(`Prometheus at ${prometheusLabel(answered)} holds no container figures (container_memory_working_set_bytes). ${without}`);
    return answered;
  }

  const patterns = input.workloads.map((workload) => ({ workload, pattern: podPattern(workload) }));
  const containerFor = (s: Series[number]) => {
    const workload =
      input.workloadOfPod.get(`${s.namespace}/${s.pod}`) ?? patterns.find((p) => p.workload.namespace === s.namespace && p.pattern.test(s.pod))?.workload;
    const container = displayName(s.container, 63);
    return workload?.containers.find((c) => c.name === container);
  };
  for (const s of cpu) {
    const c = containerFor(s);
    if (c && Number.isFinite(s.value)) c.cpuPeakCores = Math.max(c.cpuPeakCores ?? 0, s.value);
  }
  for (const s of memory) {
    const c = containerFor(s);
    if (c && Number.isFinite(s.value)) c.memoryPeakBytes = Math.max(c.memoryPeakBytes ?? 0, s.value);
  }
  for (const s of firstSeen) {
    const c = containerFor(s);
    if (!c || !Number.isFinite(s.value)) continue;
    const hours = Math.min(input.lookbackHours, Math.max(0, (input.now.getTime() / 1000 - s.value) / 3600));
    c.historyHours = Math.max(c.historyHours ?? 0, hours);
  }
  return answered;
}
