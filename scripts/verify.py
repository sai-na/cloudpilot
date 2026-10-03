#!/usr/bin/env python3
"""Confirm every W1-W9 resource in the manifest exists and is in its wasteful state.

Read-only against AWS. Prints one line per pattern and the total estimated
monthly waste. Exits 1 if any pattern is missing or in the wrong state.
"""

import json
import sys

from lab_common import MANIFEST_FILE, AwsError, aws


def check_volumes(p, volume_type):
    vols = aws("ec2", "describe-volumes", "--volume-ids", *p["resource_ids"])["Volumes"]
    bad = [
        v["VolumeId"]
        for v in vols
        if v["State"] != "available" or v["Attachments"] or v["VolumeType"] != volume_type
    ]
    if bad or len(vols) != len(p["resource_ids"]):
        return False, "not an unattached %s volume: %s" % (volume_type, bad or "missing")
    return True, "%d x %d GB %s, unattached" % (len(vols), vols[0]["Size"], volume_type)


def instance_state(p):
    out = aws("ec2", "describe-instances", "--instance-ids", *p["resource_ids"])
    return [i["State"]["Name"] for r in out["Reservations"] for i in r["Instances"]]


def check(p):
    w = p["id"]
    ids = p["resource_ids"]
    if w == "W1":
        return check_volumes(p, "gp2")
    if w == "W2":
        return check_volumes(p, "gp3")
    if w == "W3":
        addrs = aws("ec2", "describe-addresses", "--allocation-ids", *ids)["Addresses"]
        if any(a.get("AssociationId") for a in addrs):
            return False, "Elastic IP is associated"
        return True, "Elastic IP %s, not associated" % addrs[0]["PublicIp"]
    if w == "W4":
        states = instance_state(p)
        return states == ["stopped"], "instance state: %s" % ", ".join(states)
    if w == "W5":
        states = instance_state(p)
        return states == ["running"], "instance state: %s" % ", ".join(states)
    if w == "W6":
        snap = aws("ec2", "describe-snapshots", "--snapshot-ids", *ids)["Snapshots"][0]
        try:
            aws("ec2", "describe-volumes", "--volume-ids", snap["VolumeId"])
        except AwsError as err:
            if "InvalidVolume.NotFound" in str(err):
                return snap["State"] == "completed", "snapshot %s, source volume %s is gone" % (
                    snap["State"], snap["VolumeId"])
            raise
        return False, "source volume %s still exists" % snap["VolumeId"]
    if w == "W7":
        image = aws("ec2", "describe-images", "--image-ids", *ids)["Images"][0]
        users = aws(
            "ec2", "describe-instances", "--filters",
            "Name=image-id,Values=%s" % ids[0], "Name=instance-state-name,Values=running",
        )["Reservations"]
        if users:
            return False, "AMI is used by a running instance"
        return image["State"] == "available", "AMI %s, no running instance uses it" % image["State"]
    if w == "W8":
        try:
            aws("s3api", "get-bucket-lifecycle-configuration", "--bucket", ids[0])
        except AwsError as err:
            if "NoSuchLifecycleConfiguration" in str(err):
                count = len(aws("s3api", "list-objects-v2", "--bucket", ids[0]).get("Contents", []))
                return count > 0, "%d objects, no lifecycle configuration" % count
            raise
        return False, "bucket has a lifecycle configuration"
    if w == "W9":
        uploads = aws("s3api", "list-multipart-uploads", "--bucket", p["bucket"]).get("Uploads", [])
        if ids[0] not in [u["UploadId"] for u in uploads]:
            return False, "multipart upload not found"
        parts = aws(
            "s3api", "list-parts", "--bucket", p["bucket"], "--key", p["key"], "--upload-id", ids[0]
        ).get("Parts", [])
        size = sum(part["Size"] for part in parts)
        return len(parts) == 1, "incomplete upload, %d part, %.1f MB" % (len(parts), size / 1048576.0)
    return False, "unknown pattern"


def main():
    if not MANIFEST_FILE.exists():
        print("Missing %s - run scripts/build_manifest.py first." % MANIFEST_FILE, file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST_FILE.read_text())
    failed = 0
    for p in manifest["patterns"]:
        try:
            ok, detail = check(p)
        except (AwsError, IndexError, KeyError) as err:
            ok, detail = False, "lookup failed: %s" % str(err).strip().splitlines()[-1]
        failed += 0 if ok else 1
        print("%-4s %-4s $%8.2f/mo  %s - %s [%s]" % (
            p["id"], "OK" if ok else "FAIL", p["estimated_monthly_cost_usd"],
            p["waste_pattern"], detail, ", ".join(p["resource_ids"])))
    print()
    print("Total estimated monthly waste: $%.2f" % manifest["total_estimated_monthly_waste_usd"])
    if failed:
        print("%d of %d patterns FAILED verification." % (failed, len(manifest["patterns"])))
        return 1
    print("All %d patterns verified." % len(manifest["patterns"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
