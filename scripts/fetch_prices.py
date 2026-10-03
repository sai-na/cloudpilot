#!/usr/bin/env python3
"""Fetch the lab's unit prices from the AWS Price List API into pricing/ap-south-1.json.

Read-only against AWS. Always talks to real AWS (the Price List API has no
emulator equivalent). Fails loudly instead of guessing if a price is missing.
"""

import datetime
import json
import sys

from lab_common import PRICE_FILE, PROFILE, REGION, AwsError, aws

PRICING_ENDPOINT_REGION = "us-east-1"

# price key -> (service code, exact-match filters, expected unit)
QUERIES = {
    "ebs_gp2_gb_month": ("AmazonEC2", {"usagetype": "APS3-EBS:VolumeUsage.gp2"}, "GB-Mo"),
    "ebs_gp3_gb_month": ("AmazonEC2", {"usagetype": "APS3-EBS:VolumeUsage.gp3"}, "GB-Mo"),
    "ebs_snapshot_gb_month": ("AmazonEC2", {"usagetype": "APS3-EBS:SnapshotUsage"}, "GB-Mo"),
    "eip_idle_hour": ("AmazonVPC", {"usagetype": "APS3-PublicIPv4:IdleAddress"}, "Hrs"),
    "ec2_t3_micro_hour": (
        "AmazonEC2",
        {
            "instanceType": "t3.micro",
            "operatingSystem": "Linux",
            "tenancy": "Shared",
            "preInstalledSw": "NA",
            "capacitystatus": "Used",
        },
        "Hrs",
    ),
    "s3_standard_gb_month": (
        "AmazonS3",
        {"storageClass": "General Purpose", "volumeType": "Standard"},
        "GB-Mo",
    ),
}


def fetch(key):
    service, filters, unit = QUERIES[key]
    filters = dict(filters, regionCode=REGION)
    filter_args = ["Type=TERM_MATCH,Field=%s,Value=%s" % kv for kv in sorted(filters.items())]
    out = aws(
        "pricing", "get-products",
        "--service-code", service,
        "--filters", *filter_args,
        region=PRICING_ENDPOINT_REGION,
        force_real=True,
    )
    products = [json.loads(p) for p in out["PriceList"]]
    if len(products) != 1:
        raise SystemExit("%s: expected exactly 1 product, got %d" % (key, len(products)))
    product = products[0]
    terms = list(product["terms"]["OnDemand"].values())
    if len(terms) != 1:
        raise SystemExit("%s: expected exactly 1 on-demand term, got %d" % (key, len(terms)))
    # Tiered prices (S3): take the first tier, which is the one a small lab is in.
    dims = sorted(terms[0]["priceDimensions"].values(), key=lambda d: float(d["beginRange"]))
    dim = dims[0]
    if dim["unit"] != unit:
        raise SystemExit("%s: expected unit %s, got %s" % (key, unit, dim["unit"]))
    return {
        "usd": float(dim["pricePerUnit"]["USD"]),
        "unit": dim["unit"],
        "description": dim["description"],
        "sku": product["product"]["sku"],
        "usagetype": product["product"]["attributes"].get("usagetype"),
        "publication_date": product.get("publicationDate"),
        "tier": "first tier only" if len(dims) > 1 else "flat",
    }


def main():
    try:
        prices = {key: fetch(key) for key in QUERIES}
    except AwsError as err:
        print("Price fetch FAILED, nothing written:\n%s" % err, file=sys.stderr)
        return 1
    table = {
        "region": REGION,
        "currency": "USD",
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "AWS Price List Query API (pricing:GetProducts), endpoint region %s, profile %s"
        % (PRICING_ENDPOINT_REGION, PROFILE),
        "prices": prices,
    }
    PRICE_FILE.parent.mkdir(parents=True, exist_ok=True)
    PRICE_FILE.write_text(json.dumps(table, indent=2) + "\n")
    print("Wrote %s" % PRICE_FILE)
    for key, entry in prices.items():
        print("  %-24s $%-8g per %-6s %s" % (key, entry["usd"], entry["unit"], entry["usagetype"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
