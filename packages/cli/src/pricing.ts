import { readFile } from "node:fs/promises";
import { GetProductsCommand, PricingClient, type Filter } from "@aws-sdk/client-pricing";
import { now } from "./clock.js";
import { clientConfig } from "./collect.js";
import { DEFAULT_DETECT_OPTIONS, idleLoadBalancers, idleNatGateways, idleRdsInstances, oversizedCandidates, type DetectOptions } from "./detect.js";
import { labelClient } from "./recording.js";
import { RDS_PRICED_ENGINES, RDS_PRICED_STORAGE, rdsHourKey, rdsStorageKey, type Inventory, type PriceBook } from "./types.js";

/** The Price List Query API is only served from a few regions. */
export const PRICING_ENDPOINT_REGION = "us-east-1";

interface Product {
  usagetype: string;
  attributes: Record<string, string>;
  usd: number;
}

async function products(client: PricingClient, serviceCode: string, attrs: Record<string, string>): Promise<Product[]> {
  const filters: Filter[] = Object.entries(attrs).map(([Field, Value]) => ({ Type: "TERM_MATCH", Field, Value }));
  const res = await client.send(new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters }));
  const out: Product[] = [];
  for (const raw of res.PriceList ?? []) {
    // Each entry is a JSON document; the SDK hands it over as a string-like object.
    const item = JSON.parse(String(raw));
    const attributes: Record<string, string> = item.product?.attributes ?? {};
    const usagetype: string = attributes.usagetype ?? "";
    for (const term of Object.values<any>(item.terms?.OnDemand ?? {})) {
      // Tiered prices (S3): the first tier is the one a small account is in.
      const dims = Object.values<any>(term.priceDimensions ?? {}).sort(
        (a, b) => Number(a.beginRange) - Number(b.beginRange),
      );
      const usd = Number(dims[0]?.pricePerUnit?.USD);
      if (Number.isFinite(usd)) out.push({ usagetype, attributes, usd });
    }
  }
  return out;
}

async function singleProduct(client: PricingClient, what: string, serviceCode: string, attrs: Record<string, string>, usagetypeSuffix?: string) {
  let found = await products(client, serviceCode, attrs);
  if (usagetypeSuffix) found = found.filter((p) => p.usagetype.endsWith(usagetypeSuffix));
  if (found.length !== 1) throw new Error(`price lookup for ${what} returned ${found.length} products, expected 1`);
  return found[0]!;
}

const single = async (...args: Parameters<typeof singleProduct>) => (await singleProduct(...args)).usd;

/**
 * Like `singleProduct`, but a price the Price List does not have (a size that
 * does not exist, a type not sold in the region) is simply absent. That
 * leaves a finding unreported rather than ending the scan. A failed request,
 * or filters that match more than one product, still throws.
 */
async function optionalProduct(client: PricingClient, what: string, serviceCode: string, attrs: Record<string, string>, usagetype?: RegExp) {
  let found = await products(client, serviceCode, attrs);
  // Where a family also lists other charges (data processed, Outposts, a regional variant), the usage type picks the hourly one.
  if (usagetype) found = found.filter((p) => usagetype.test(p.usagetype));
  if (found.length > 1) throw new Error(`price lookup for ${what} returned ${found.length} products, expected 1`);
  return found[0];
}

/** The usage type of an hourly charge, with or without the region prefix (APS3-NatGateway-Hours, NatGateway-Hours). */
const hourlyUsagetype = (name: string) => new RegExp(`^(?:[A-Z0-9]+-)?${name}$`);

/** "4" and "16 GiB" as numbers, or undefined when the Price List gives something else. */
const spec = (p: Product) => {
  const vcpu = Number(p.attributes.vcpu);
  // Large sizes are written with a thousands separator: "1,024 GiB".
  const memoryGib = Number(/^([\d.,]+) GiB$/.exec(p.attributes.memory ?? "")?.[1]?.replace(/,/g, ""));
  return Number.isFinite(vcpu) && Number.isFinite(memoryGib) ? { vcpu, memoryGib } : undefined;
};

/** True when a region holds nothing CloudPilot looks at, so no prices are needed for it. */
export const isEmpty = (inventory: Inventory) =>
  [
    inventory.volumes,
    inventory.snapshots,
    inventory.images,
    inventory.instances,
    inventory.rdsInstances,
    inventory.addresses,
    inventory.natGateways,
    inventory.loadBalancers,
    inventory.buckets,
  ].every(
    (list) => list.length === 0,
  );

/** Stand-in prices for an empty region: nothing there is ever priced. */
export const noPrices = (region: string): PriceBook => ({
  region,
  source: "aws-price-list-api",
  fetchedAt: now().toISOString(),
  ebsGbMonth: {},
  snapshotGbMonth: 0,
  idleIpv4Hour: 0,
  instanceHour: {},
  rdsInstanceHour: {},
  rdsStorageGbMonth: {},
  instanceSpecs: {},
  natGatewayHour: 0,
  loadBalancerHour: {},
  s3StandardGbMonth: 0,
});

/** What to ask the Price List for one EC2 instance type: On-Demand, Linux, shared hardware. */
const ec2Instance = (regionCode: string, instanceType: string) => ({
  regionCode,
  instanceType,
  operatingSystem: "Linux",
  tenancy: "Shared",
  preInstalledSw: "NA",
  capacitystatus: "Used",
});

/** Live prices for exactly the volume, instance, database, NAT gateway and load balancer kinds the inventory contains. */
export async function fetchPrices(inventory: Inventory, profile?: string, options: DetectOptions = DEFAULT_DETECT_OPTIONS): Promise<PriceBook> {
  const client = labelClient(new PricingClient(clientConfig({ region: PRICING_ENDPOINT_REGION, profile })), "Pricing");
  const regionCode = inventory.region;

  const volumeTypes = [...new Set(["gp2", "gp3", ...inventory.volumes.map((v) => v.type)])];
  const instanceTypes = [...new Set(inventory.instances.filter((i) => i.state === "running").map((i) => i.type))];
  // The size below a running instance is priced only where the rules could report it.
  const smallerTypes = [...new Set(oversizedCandidates(inventory, options).map((c) => c.smaller))].filter((t) => !instanceTypes.includes(t));
  // Each distinct database and storage kind once, and only for instances the idle rule could report.
  const idleDbs = idleRdsInstances(inventory, options);
  const dbHours = new Map(idleDbs.map((d) => [rdsHourKey(d.instanceClass, RDS_PRICED_ENGINES[d.engine]!, d.multiAz), d]));
  const dbStorage = new Map(idleDbs.map((d) => [rdsStorageKey(d.storageType, RDS_PRICED_ENGINES[d.engine]!, d.multiAz), d]));
  // The NAT gateway and each kind of load balancer are priced once, and only if a rule could report one.
  const anyIdleNat = idleNatGateways(inventory, options).length > 0;
  const idleBalancerTypes = [...new Set(idleLoadBalancers(inventory, options).map((i) => i.balancer.type))];

  const [ebs, instances, smaller, dbHour, dbGb, nat, balancers, snapshotGbMonth, idleIpv4Hour, s3StandardGbMonth] = await Promise.all([
    Promise.all(
      volumeTypes.map(async (type) => {
        const usd = await single(client, `EBS ${type}`, "AmazonEC2", { regionCode, productFamily: "Storage", volumeApiName: type });
        return [type, usd] as const;
      }),
    ),
    Promise.all(
      instanceTypes.map(async (type) => {
        const product = await singleProduct(client, `EC2 ${type}`, "AmazonEC2", ec2Instance(regionCode, type));
        return [type, product] as const;
      }),
    ),
    Promise.all(smallerTypes.map(async (type) => [type, await optionalProduct(client, `EC2 ${type}`, "AmazonEC2", ec2Instance(regionCode, type))] as const)),
    Promise.all(
      [...dbHours].map(async ([key, d]) => {
        const product = await optionalProduct(client, `RDS ${key}`, "AmazonRDS", {
          regionCode,
          instanceType: d.instanceClass,
          databaseEngine: RDS_PRICED_ENGINES[d.engine]!,
          deploymentOption: d.multiAz ? "Multi-AZ" : "Single-AZ",
          licenseModel: "No license required",
        });
        return [key, product?.usd] as const;
      }),
    ),
    Promise.all(
      [...dbStorage].map(async ([key, d]) => {
        const product = await optionalProduct(client, `RDS storage ${key}`, "AmazonRDS", {
          regionCode,
          productFamily: "Database Storage",
          databaseEngine: RDS_PRICED_ENGINES[d.engine]!,
          deploymentOption: d.multiAz ? "Multi-AZ" : "Single-AZ",
          volumeType: RDS_PRICED_STORAGE[d.storageType]!,
        });
        return [key, product?.usd] as const;
      }),
    ),
    anyIdleNat
      ? optionalProduct(client, "NAT gateway", "AmazonEC2", { regionCode, productFamily: "NAT Gateway", operation: "NatGateway", locationType: "AWS Region" }, hourlyUsagetype("NatGateway-Hours"))
      : undefined,
    Promise.all(
      idleBalancerTypes.map(async (type) => {
        const product = await optionalProduct(
          client,
          `${type} load balancer`,
          "AWSELB",
          {
            regionCode,
            productFamily: type === "application" ? "Load Balancer-Application" : "Load Balancer-Network",
            locationType: "AWS Region",
            // Not the trust store charge, which has a usage type of its own in the same family.
            groupDescription: `LoadBalancer hourly usage by ${type === "application" ? "Application" : "Network"} Load Balancer`,
          },
          hourlyUsagetype("LoadBalancerUsage"),
        );
        return [type, product?.usd] as const;
      }),
    ),
    single(client, "EBS snapshot", "AmazonEC2", { regionCode, productFamily: "Storage Snapshot" }, "EBS:SnapshotUsage"),
    single(client, "idle public IPv4", "AmazonVPC", { regionCode, group: "VPCPublicIPv4Address" }, "PublicIPv4:IdleAddress"),
    single(client, "S3 Standard", "AmazonS3", { regionCode, storageClass: "General Purpose", volumeType: "Standard" }),
  ]);

  const everyInstance = [...instances, ...smaller.filter((e): e is readonly [string, Product] => e[1] !== undefined)];
  const present = <T>(entries: ReadonlyArray<readonly [string, T | undefined]>) =>
    Object.fromEntries(entries.filter((e): e is readonly [string, T] => e[1] !== undefined));
  return {
    region: regionCode,
    source: "aws-price-list-api",
    fetchedAt: now().toISOString(),
    ebsGbMonth: Object.fromEntries(ebs),
    snapshotGbMonth,
    idleIpv4Hour,
    instanceHour: Object.fromEntries(everyInstance.map(([type, p]) => [type, p.usd])),
    rdsInstanceHour: present(dbHour),
    rdsStorageGbMonth: present(dbGb),
    instanceSpecs: present(everyInstance.map(([type, p]) => [type, spec(p)] as const)),
    natGatewayHour: nat?.usd ?? 0,
    loadBalancerHour: present(balancers),
    s3StandardGbMonth,
  };
}

/**
 * Offline prices from a saved table (the lab's pricing/ap-south-1.json format).
 * Covers only the types that file lists.
 */
export async function loadPriceFile(path: string): Promise<PriceBook> {
  const table = JSON.parse(await readFile(path, "utf8"));
  const usd = (key: string): number => {
    const value = table.prices?.[key]?.usd;
    if (typeof value !== "number") throw new Error(`${path} has no price for ${key}`);
    return value;
  };
  return {
    region: table.region,
    source: "price-file",
    fetchedAt: table.fetched_at,
    ebsGbMonth: { gp2: usd("ebs_gp2_gb_month"), gp3: usd("ebs_gp3_gb_month") },
    snapshotGbMonth: usd("ebs_snapshot_gb_month"),
    idleIpv4Hour: usd("eip_idle_hour"),
    instanceHour: { "t3.micro": usd("ec2_t3_micro_hour") },
    // The price file has no database or instance-size prices, so those checks report nothing offline.
    rdsInstanceHour: {},
    rdsStorageGbMonth: {},
    instanceSpecs: {},
    // Nor does it have NAT gateway or load balancer prices.
    natGatewayHour: 0,
    loadBalancerHour: {},
    s3StandardGbMonth: usd("s3_standard_gb_month"),
  };
}
