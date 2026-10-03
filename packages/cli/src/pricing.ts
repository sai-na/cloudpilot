import { readFile } from "node:fs/promises";
import { GetProductsCommand, PricingClient, type Filter } from "@aws-sdk/client-pricing";
import { now } from "./clock.js";
import { clientConfig } from "./collect.js";
import { labelClient } from "./recording.js";
import type { Inventory, PriceBook } from "./types.js";

/** The Price List Query API is only served from a few regions. */
const PRICING_ENDPOINT_REGION = "us-east-1";

interface Product {
  usagetype: string;
  usd: number;
}

async function products(client: PricingClient, serviceCode: string, attrs: Record<string, string>): Promise<Product[]> {
  const filters: Filter[] = Object.entries(attrs).map(([Field, Value]) => ({ Type: "TERM_MATCH", Field, Value }));
  const res = await client.send(new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters }));
  const out: Product[] = [];
  for (const raw of res.PriceList ?? []) {
    // Each entry is a JSON document; the SDK hands it over as a string-like object.
    const item = JSON.parse(String(raw));
    const usagetype: string = item.product?.attributes?.usagetype ?? "";
    for (const term of Object.values<any>(item.terms?.OnDemand ?? {})) {
      // Tiered prices (S3): the first tier is the one a small account is in.
      const dims = Object.values<any>(term.priceDimensions ?? {}).sort(
        (a, b) => Number(a.beginRange) - Number(b.beginRange),
      );
      const usd = Number(dims[0]?.pricePerUnit?.USD);
      if (Number.isFinite(usd)) out.push({ usagetype, usd });
    }
  }
  return out;
}

async function single(client: PricingClient, what: string, serviceCode: string, attrs: Record<string, string>, usagetypeSuffix?: string) {
  let found = await products(client, serviceCode, attrs);
  if (usagetypeSuffix) found = found.filter((p) => p.usagetype.endsWith(usagetypeSuffix));
  if (found.length !== 1) throw new Error(`price lookup for ${what} returned ${found.length} products, expected 1`);
  return found[0]!.usd;
}

/** True when a region holds nothing CloudPilot looks at, so no prices are needed for it. */
export const isEmpty = (inventory: Inventory) =>
  [inventory.volumes, inventory.snapshots, inventory.images, inventory.instances, inventory.addresses, inventory.buckets].every(
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
  s3StandardGbMonth: 0,
});

/** Live prices for exactly the volume and instance types the inventory contains. */
export async function fetchPrices(inventory: Inventory, profile?: string): Promise<PriceBook> {
  const client = labelClient(new PricingClient(clientConfig({ region: PRICING_ENDPOINT_REGION, profile })), "Pricing");
  const regionCode = inventory.region;

  const volumeTypes = [...new Set(["gp2", "gp3", ...inventory.volumes.map((v) => v.type)])];
  const instanceTypes = [...new Set(inventory.instances.filter((i) => i.state === "running").map((i) => i.type))];

  const [ebs, instances, snapshotGbMonth, idleIpv4Hour, s3StandardGbMonth] = await Promise.all([
    Promise.all(
      volumeTypes.map(async (type) => {
        const usd = await single(client, `EBS ${type}`, "AmazonEC2", { regionCode, productFamily: "Storage", volumeApiName: type });
        return [type, usd] as const;
      }),
    ),
    Promise.all(
      instanceTypes.map(async (type) => {
        const usd = await single(client, `EC2 ${type}`, "AmazonEC2", {
          regionCode,
          instanceType: type,
          operatingSystem: "Linux",
          tenancy: "Shared",
          preInstalledSw: "NA",
          capacitystatus: "Used",
        });
        return [type, usd] as const;
      }),
    ),
    single(client, "EBS snapshot", "AmazonEC2", { regionCode, productFamily: "Storage Snapshot" }, "EBS:SnapshotUsage"),
    single(client, "idle public IPv4", "AmazonVPC", { regionCode, group: "VPCPublicIPv4Address" }, "PublicIPv4:IdleAddress"),
    single(client, "S3 Standard", "AmazonS3", { regionCode, storageClass: "General Purpose", volumeType: "Standard" }),
  ]);

  return {
    region: regionCode,
    source: "aws-price-list-api",
    fetchedAt: now().toISOString(),
    ebsGbMonth: Object.fromEntries(ebs),
    snapshotGbMonth,
    idleIpv4Hour,
    instanceHour: Object.fromEntries(instances),
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
    s3StandardGbMonth: usd("s3_standard_gb_month"),
  };
}
