#!/usr/bin/env python3
"""Write lab-manifest.json: the answer key CloudPilot is tested against.

Read-only against AWS. Looks every planted resource up by its tags, so it
must run after `terraform apply` and `scripts/seed.sh --confirm`.
"""

import datetime
import json
import sys

from lab_common import (
    HOURS_PER_MONTH, MANIFEST_FILE, MODE, PATTERNS, PRICE_FILE, REGION, ROOT, SPEC,
    account_id, aws, bucket_name, load_prices, monthly_costs, tag_filters, w1_gp3_saving,
)

LIVE_STATES = "Name=instance-state-name,Values=pending,running,stopping,stopped"
SNAPSHOT_BASIS = (
    "Provisioned size of the source volume x snapshot price. Upper bound: AWS bills "
    "snapshots for stored blocks only."
)
LIFECYCLE_FIX = json.dumps(
    {
        "Rules": [
            {
                "ID": "abort-incomplete-uploads-and-tier-down",
                "Status": "Enabled",
                "Filter": {},
                "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7},
                "Transitions": [{"Days": 30, "StorageClass": "STANDARD_IA"}],
            }
        ]
    },
    separators=(",", ":"),
)


def volumes(pattern):
    out = aws("ec2", "describe-volumes", "--filters", *tag_filters(pattern))
    return sorted(v["VolumeId"] for v in out["Volumes"])


def instances(pattern):
    out = aws("ec2", "describe-instances", "--filters", LIVE_STATES, *tag_filters(pattern))
    return sorted(i["InstanceId"] for r in out["Reservations"] for i in r["Instances"])


def discover():
    acct = account_id()
    bucket = bucket_name(acct)
    found = {"account_id": acct, "bucket": bucket}

    found["W1"] = volumes("W1")
    found["W2"] = volumes("W2")
    found["W3"] = sorted(
        a["AllocationId"]
        for a in aws("ec2", "describe-addresses", "--filters", *tag_filters("W3"))["Addresses"]
    )
    found["W4"] = instances("W4")
    found["W5"] = instances("W5")

    snaps = aws("ec2", "describe-snapshots", "--owner-ids", "self", "--filters", *tag_filters("W6"))
    found["W6"] = sorted(s["SnapshotId"] for s in snaps["Snapshots"])
    found["W6_source_volumes"] = sorted(s["VolumeId"] for s in snaps["Snapshots"])
    found["W6_gb"] = sum(s["VolumeSize"] for s in snaps["Snapshots"])

    images = aws("ec2", "describe-images", "--owners", "self", "--filters", *tag_filters("W7"))["Images"]
    found["W7"] = sorted(i["ImageId"] for i in images)
    found["W7_gb"] = sum(
        m["Ebs"].get("VolumeSize", 0)
        for i in images
        for m in i.get("BlockDeviceMappings", [])
        if m.get("Ebs", {}).get("SnapshotId")
    )
    found["W7_snapshots"] = sorted(
        m["Ebs"]["SnapshotId"]
        for i in images
        for m in i.get("BlockDeviceMappings", [])
        if m.get("Ebs", {}).get("SnapshotId")
    )

    try:
        aws("s3api", "head-bucket", "--bucket", bucket)
        found["W8"] = [bucket]
        objects = aws("s3api", "list-objects-v2", "--bucket", bucket).get("Contents", [])
        found["W8_bytes"] = sum(o["Size"] for o in objects)
        found["W8_objects"] = len(objects)
        uploads = aws("s3api", "list-multipart-uploads", "--bucket", bucket).get("Uploads", [])
        found["W9_uploads"] = [u for u in uploads if u["Key"] == SPEC["w9"]["key"]]
    except Exception:
        found["W8"], found["W8_bytes"], found["W8_objects"], found["W9_uploads"] = [], 0, 0, []
    found["W9"] = [u["UploadId"] for u in found["W9_uploads"]]
    return found


def cli(command):
    return "aws %s --region %s" % (command, REGION)


def build_patterns(found, costs, prices):
    s = SPEC
    bucket = found["bucket"]
    usd = lambda value: round(value, 4)
    return [
        {
            "id": "W1",
            "resource_type": "AWS::EC2::Volume",
            "resource_ids": found["W1"],
            "waste_pattern": "Unattached EBS volume, plus gp2 to gp3 saving",
            "expected_finding": "%d unattached %s volumes of %d GB each (state 'available', no "
            "attachments). Recommend deleting them; if they must be kept, converting gp2 to gp3 "
            "is cheaper." % (s["w1"]["count"], s["w1"]["type"], s["w1"]["size_gb"]),
            "fix_commands": [cli("ec2 delete-volume --volume-id %s" % v) for v in found["W1"]],
            "alternative_fix_commands": [
                cli("ec2 modify-volume --volume-id %s --volume-type gp3" % v) for v in found["W1"]
            ],
            "alternative_monthly_saving_usd": usd(w1_gp3_saving(prices)),
            "estimated_monthly_cost_usd": usd(costs["W1"]),
            "cost_basis": "%d x %d GB x gp2 price" % (s["w1"]["count"], s["w1"]["size_gb"]),
        },
        {
            "id": "W2",
            "resource_type": "AWS::EC2::Volume",
            "resource_ids": found["W2"],
            "waste_pattern": "Unattached EBS volume",
            "expected_finding": "Unattached gp3 volume of %d GB (state 'available', no "
            "attachments). Recommend deleting it." % s["w2"]["size_gb"],
            "fix_commands": [cli("ec2 delete-volume --volume-id %s" % v) for v in found["W2"]],
            "estimated_monthly_cost_usd": usd(costs["W2"]),
            "cost_basis": "%d GB x gp3 price" % s["w2"]["size_gb"],
        },
        {
            "id": "W3",
            "resource_type": "AWS::EC2::EIP",
            "resource_ids": found["W3"],
            "waste_pattern": "Idle Elastic IP",
            "expected_finding": "Elastic IP with no association, billed hourly as an idle "
            "public IPv4 address. Recommend releasing it.",
            "fix_commands": [cli("ec2 release-address --allocation-id %s" % a) for a in found["W3"]],
            "estimated_monthly_cost_usd": usd(costs["W3"]),
            "cost_basis": "idle public IPv4 hourly price x %d hours" % HOURS_PER_MONTH,
        },
        {
            "id": "W4",
            "resource_type": "AWS::EC2::Instance",
            "resource_ids": found["W4"],
            "waste_pattern": "Stopped instance still paying for storage",
            "expected_finding": "Stopped %s whose %d GB gp3 root volume is still billed. "
            "Recommend terminating it (the root volume is deleted on termination)."
            % (s["w4"]["instance_type"], s["w4"]["root_gb"]),
            "fix_commands": [cli("ec2 terminate-instances --instance-ids %s" % i) for i in found["W4"]],
            "estimated_monthly_cost_usd": usd(costs["W4"]),
            "cost_basis": "%d GB x gp3 price (no compute charge while stopped)" % s["w4"]["root_gb"],
        },
        {
            "id": "W5",
            "resource_type": "AWS::EC2::Instance",
            "resource_ids": found["W5"],
            "waste_pattern": "Idle running instance",
            "expected_finding": "Running %s with near-zero CloudWatch CPUUtilization since "
            "launch and no workload. Recommend terminating it." % s["w5"]["instance_type"],
            "fix_commands": [cli("ec2 terminate-instances --instance-ids %s" % i) for i in found["W5"]],
            "estimated_monthly_cost_usd": usd(costs["W5"]),
            "cost_basis": "t3.micro hourly price x %d hours + %d GB x gp3 price"
            % (HOURS_PER_MONTH, s["w5"]["root_gb"]),
        },
        {
            "id": "W6",
            "resource_type": "AWS::EC2::Snapshot",
            "resource_ids": found["W6"],
            "source_volume_ids": found["W6_source_volumes"],
            "waste_pattern": "Orphaned snapshot whose source volume no longer exists",
            "expected_finding": "Snapshot of a %d GB volume that has been deleted, and that no "
            "AMI references. Recommend deleting it." % found["W6_gb"],
            "fix_commands": [cli("ec2 delete-snapshot --snapshot-id %s" % x) for x in found["W6"]],
            "estimated_monthly_cost_usd": usd(costs["W6"]),
            "cost_basis": SNAPSHOT_BASIS,
        },
        {
            "id": "W7",
            "resource_type": "AWS::EC2::Image",
            "resource_ids": found["W7"],
            "snapshot_ids": found["W7_snapshots"],
            "waste_pattern": "AMI not used by any running instance",
            "expected_finding": "AMI that no running instance was launched from, backed by a "
            "%d GB snapshot. Recommend deregistering it and deleting its snapshot."
            % found["W7_gb"],
            "fix_commands": [cli("ec2 deregister-image --image-id %s" % i) for i in found["W7"]]
            + [cli("ec2 delete-snapshot --snapshot-id %s" % x) for x in found["W7_snapshots"]],
            "estimated_monthly_cost_usd": usd(costs["W7"]),
            "cost_basis": SNAPSHOT_BASIS,
        },
        {
            "id": "W8",
            "resource_type": "AWS::S3::Bucket",
            "resource_ids": found["W8"],
            "waste_pattern": "Bucket with no lifecycle rule",
            "expected_finding": "Bucket with no lifecycle configuration: objects never "
            "transition or expire, and incomplete multipart uploads are never cleaned up. "
            "Recommend adding a lifecycle rule.",
            "fix_commands": [
                cli(
                    "s3api put-bucket-lifecycle-configuration --bucket %s "
                    "--lifecycle-configuration '%s'" % (bucket, LIFECYCLE_FIX)
                )
            ],
            "estimated_monthly_cost_usd": usd(costs["W8"]),
            "cost_basis": "%d objects, %d bytes x S3 Standard price"
            % (found["W8_objects"], found["W8_bytes"]),
        },
        {
            "id": "W9",
            "resource_type": "AWS::S3::MultipartUpload",
            "resource_ids": found["W9"],
            "bucket": bucket,
            "key": s["w9"]["key"],
            "waste_pattern": "Abandoned incomplete multipart upload",
            "expected_finding": "Incomplete multipart upload holding a %d MB part that is "
            "billed but invisible in normal object listings. Recommend aborting it."
            % s["w9"]["part_mb"],
            "fix_commands": [
                cli(
                    "s3api abort-multipart-upload --bucket %s --key %s --upload-id %s"
                    % (bucket, s["w9"]["key"], u)
                )
                for u in found["W9"]
            ],
            "estimated_monthly_cost_usd": usd(costs["W9"]),
            "cost_basis": "%d MB x S3 Standard price" % s["w9"]["part_mb"],
        },
    ]


def main():
    prices, table = load_prices()
    found = discover()
    expected = dict((w, 1) for w in PATTERNS)
    expected["W1"] = SPEC["w1"]["count"]
    missing = [
        "%s: expected %d resource(s), found %d" % (w, expected[w], len(found[w]))
        for w in PATTERNS
        if len(found[w]) != expected[w]
    ]
    if missing:
        print("Manifest NOT written - the lab is incomplete:", file=sys.stderr)
        for line in missing:
            print("  " + line, file=sys.stderr)
        return 1

    costs = monthly_costs(
        prices, w8_bytes=found["W8_bytes"], w6_gb=found["W6_gb"], w7_gb=found["W7_gb"]
    )
    patterns = build_patterns(found, costs, prices)
    manifest = {
        "lab": SPEC["project_tag"],
        "mode": MODE,
        "account_id": found["account_id"],
        "region": REGION,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "price_table": {
            "file": str(PRICE_FILE.relative_to(ROOT)),
            "fetched_at": table["fetched_at"],
            "hours_per_month": HOURS_PER_MONTH,
        },
        "patterns": patterns,
        "total_estimated_monthly_waste_usd": round(
            sum(p["estimated_monthly_cost_usd"] for p in patterns), 2
        ),
    }
    MANIFEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2) + "\n")
    print("Wrote %s" % MANIFEST_FILE)
    print("Total estimated monthly waste: $%.2f" % manifest["total_estimated_monthly_waste_usd"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
