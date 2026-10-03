/**
 * Saves what the Kubernetes waste lab answers to every read CloudPilot makes,
 * so the offline tests can replay a real cluster:
 *
 *   npx tsx test/kube-lab/record-fixture.ts > test/fixtures/kube-lab.json
 *
 * Run it when the reads change, with the lab up (k8s-lab/up.sh --confirm) and
 * at least ten minutes of history in its Prometheus. Nothing secret is read:
 * only pods, workloads, volumes, services and Prometheus query results.
 */
import { collectCluster, kubectlReader, type KubeReader } from "../../src/kube.js";

export const LAB_CONTEXT = "kind-cloudpilot-lab";
export const LAB_LOOKBACK_HOURS = 1;

/** Server-side bookkeeping that no rule reads and that would triple the file. */
function trimmed(value: any): any {
  if (Array.isArray(value)) return value.map(trimmed);
  if (!value || typeof value !== "object") return value;
  const { managedFields: _dropped, ...rest } = value;
  return Object.fromEntries(Object.entries(rest).map(([key, inner]) => [key, trimmed(inner)]));
}

const live = kubectlReader(LAB_CONTEXT);
const responses: Record<string, unknown> = {};
const recording: KubeReader = {
  identity: () => live.identity(),
  get: async (path) => (responses[path] = trimmed(await live.get(path))),
};

const now = new Date();
const inventory = await collectCluster(recording, { lookbackHours: LAB_LOOKBACK_HOURS, now });
if (inventory.warnings.length > 0) throw new Error(`The lab could not be read in full:\n${inventory.warnings.join("\n")}`);
console.log(JSON.stringify({ recordedAt: now.toISOString(), identity: await live.identity(), lookbackHours: LAB_LOOKBACK_HOURS, responses }, null, 1));
