"""Shared helpers for the waste-lab Python scripts. Standard library only."""

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = json.loads((ROOT / "lab-spec.json").read_text())

REGION = SPEC["region"]
PROFILE = SPEC["seed_profile"]
PROJECT = SPEC["project_tag"]
HOURS_PER_MONTH = 730

EMULATOR = bool(os.environ.get("AWS_ENDPOINT_URL"))
MODE = "emulator" if EMULATOR else "real"
STATE_DIR = ROOT / "lab-state" / MODE
PRICE_FILE = ROOT / "pricing" / "ap-south-1.json"
# The emulator never overwrites the real answer key.
MANIFEST_FILE = (STATE_DIR / "lab-manifest.json") if EMULATOR else (ROOT / "lab-manifest.json")

PATTERNS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]


class AwsError(Exception):
    pass


def aws(*args, region=REGION, force_real=False):
    """Run an AWS CLI command and return its parsed JSON output.

    The CLI itself honours AWS_ENDPOINT_URL, so emulator mode only swaps the
    profile for dummy credentials.
    """
    cmd = ["aws", *args, "--region", region, "--output", "json"]
    env = dict(os.environ)
    if EMULATOR and not force_real:
        env["AWS_ACCESS_KEY_ID"] = "testing"
        env["AWS_SECRET_ACCESS_KEY"] = "testing"
        env.pop("AWS_PROFILE", None)
    else:
        env.pop("AWS_ENDPOINT_URL", None)
        cmd += ["--profile", PROFILE]
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise AwsError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def tag_filters(pattern):
    return [
        "Name=tag:Project,Values=%s" % PROJECT,
        "Name=tag:WastePattern,Values=%s" % pattern,
    ]


def account_id():
    return aws("sts", "get-caller-identity")["Account"]


def bucket_name(acct):
    return "%s-%s" % (SPEC["bucket_prefix"], acct)


def load_prices():
    """Return {price_key: usd} from the fetched price table."""
    if not PRICE_FILE.exists():
        raise SystemExit("Missing %s - run scripts/fetch_prices.py first." % PRICE_FILE)
    table = json.loads(PRICE_FILE.read_text())
    return {key: entry["usd"] for key, entry in table["prices"].items()}, table


def monthly_costs(prices, w8_bytes=None, w6_gb=None, w7_gb=None):
    """Estimated monthly cost in USD per waste pattern, from the lab spec.

    Snapshot-backed patterns (W6, W7) are priced at the full provisioned size
    of the source volume. AWS bills snapshots only for stored blocks, so the
    real charge is lower; the provisioned size is what a read-only scanner can
    see through ec2:DescribeSnapshots.

    The optional arguments replace the spec's sizes with the sizes actually
    observed in the account, once the lab exists.
    """
    s = SPEC
    if w6_gb is None:
        w6_gb = s["w6"]["size_gb"]
    if w7_gb is None:
        w7_gb = s["w4"]["root_gb"]
    if w8_bytes is None:
        w8_bytes = sum(len(body.encode()) for body in s["w8"]["objects"].values())
    gib = 1024.0 ** 3
    ebs = {"gp2": prices["ebs_gp2_gb_month"], "gp3": prices["ebs_gp3_gb_month"]}
    return {
        "W1": s["w1"]["count"] * s["w1"]["size_gb"] * ebs[s["w1"]["type"]],
        "W2": s["w2"]["size_gb"] * ebs[s["w2"]["type"]],
        "W3": prices["eip_idle_hour"] * HOURS_PER_MONTH,
        "W4": s["w4"]["root_gb"] * ebs[s["w4"]["root_type"]],
        "W5": prices["ec2_t3_micro_hour"] * HOURS_PER_MONTH
        + s["w5"]["root_gb"] * ebs[s["w5"]["root_type"]],
        "W6": w6_gb * prices["ebs_snapshot_gb_month"],
        "W7": w7_gb * prices["ebs_snapshot_gb_month"],
        "W8": w8_bytes / gib * prices["s3_standard_gb_month"],
        "W9": s["w9"]["part_mb"] / 1024.0 * prices["s3_standard_gb_month"],
    }


def w1_gp3_saving(prices):
    """Monthly saving from converting the W1 volumes to gp3 instead of deleting them."""
    s = SPEC["w1"]
    return s["count"] * s["size_gb"] * (prices["ebs_gp2_gb_month"] - prices["ebs_gp3_gb_month"])
