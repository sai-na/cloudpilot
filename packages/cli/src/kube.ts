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
  /** The kubectl context being read, and the server behind it. */
  identity(): Promise<{ context: string; server?: string }>;
}

/** kubectl is not installed, or not on the PATH. */
export class KubectlNotFoundError extends Error {
  constructor() {
    super("kubectl was not found on your PATH. CloudPilot reads a cluster through kubectl, with the access you already have.");
    this.name = "KubectlNotFoundError";
  }
}

/** Reads through the kubectl on the PATH. It has no way to write. With a timeout, a call that has not answered by then is stopped. */
export function kubectlReader(context?: string, timeoutMs?: number): KubeReader {
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
      const view = JSON.parse(await run(["config", "view", "--minify", "-o", "json"]));
      const name = view.contexts?.[0]?.name ?? view["current-context"];
      if (!name) throw new Error("kubectl has no current context. Choose one with --context.");
      return { context: String(name), server: view.clusters?.[0]?.cluster?.server };
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

  const pods = (await list(reader, scoped("/api/v1", "pods"))).filter((p) => wanted.has(p.metadata.namespace));
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
  for (const pod of pods) {
    if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
    const owner = (pod.metadata.ownerReferences ?? []).find((o: any) => o.controller) ?? pod.metadata.ownerReferences?.[0];
    if (!owner) continue;
    const namespace: string = pod.metadata.namespace;
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
      workload = { kind, name, namespace, replicas: 0, ignored: false, containers: [] };
      workloads.set(key, workload);
    }
    workload.replicas += 1;
    workload.ignored ||= isIgnored(pod.metadata);
    workloadOfPod.set(`${namespace}/${pod.metadata.name}`, workload);
    for (const spec of pod.spec?.containers ?? []) {
      let container = workload.containers.find((c) => c.name === spec.name);
      if (!container) {
        container = {
          name: spec.name,
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

  const mounted = new Map<string, string[]>();
  for (const pod of pods) {
    if (["Succeeded", "Failed"].includes(pod.status?.phase)) continue;
    for (const volume of pod.spec?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const key = `${pod.metadata.namespace}/${claim}`;
      mounted.set(key, [...(mounted.get(key) ?? []), pod.metadata.name]);
    }
  }
  const policyOf = new Map<string, string>(volumes.map((v) => [String(v.metadata.name), String(v.spec?.persistentVolumeReclaimPolicy ?? "")]));

  return {
    context,
    server,
    collectedAt: now.toISOString(),
    namespaces,
    workloads: [...workloads.values()].sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)),
    claims: claims.map((c) => ({
      name: c.metadata.name,
      namespace: c.metadata.namespace,
      phase: c.status?.phase ?? "",
      capacityBytes: parseBytes(c.status?.capacity?.storage ?? c.spec?.resources?.requests?.storage) ?? 0,
      storageClass: c.spec?.storageClassName,
      volumeName: c.spec?.volumeName,
      reclaimPolicy: policyOf.get(c.spec?.volumeName) || undefined,
      createdAt: c.metadata.creationTimestamp,
      mountedBy: mounted.get(`${c.metadata.namespace}/${c.metadata.name}`) ?? [],
      ignored: isIgnored(c.metadata),
    })),
    volumes: volumes
      .filter((v) => !namespace || v.spec?.claimRef?.namespace === namespace)
      .map((v) => ({
        name: v.metadata.name,
        phase: v.status?.phase ?? "",
        capacityBytes: parseBytes(v.spec?.capacity?.storage) ?? 0,
        storageClass: v.spec?.storageClassName,
        reclaimPolicy: v.spec?.persistentVolumeReclaimPolicy,
        claim: v.spec?.claimRef ? { namespace: v.spec.claimRef.namespace, name: v.spec.claimRef.name } : undefined,
        ignored: isIgnored(v.metadata),
      })),
    prometheus: prometheus ? prometheusLabel(prometheus) : undefined,
    lookbackHours: options.lookbackHours,
    warnings,
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
    return workload?.containers.find((c) => c.name === s.container);
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
