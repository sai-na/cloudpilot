#!/usr/bin/env python3
"""Print the lab's estimated hourly and 36-hour cost from the price table.

Local only, no AWS calls. Exits 2 if the 36-hour estimate is above the limit.
"""

import sys

from lab_common import HOURS_PER_MONTH, PATTERNS, load_prices, monthly_costs

RUN_HOURS = 36
LIMIT_USD = 10.0

LABELS = {
    "W1": "2 x 500 GB gp2 volumes, unattached",
    "W2": "200 GB gp3 volume, unattached",
    "W3": "Elastic IP, not associated",
    "W4": "stopped t3.micro, 30 GB gp3 root",
    "W5": "running t3.micro + 8 GB gp3 root",
    "W6": "orphaned snapshot (50 GB, upper bound)",
    "W7": "unused AMI snapshot (30 GB, upper bound)",
    "W8": "S3 bucket, a few small objects",
    "W9": "abandoned 5 MB multipart part",
}


def main():
    prices, table = load_prices()
    costs = monthly_costs(prices)
    print("Price table: %s (fetched %s)" % (table["region"], table["fetched_at"]))
    print("%-4s %-42s %10s %10s %10s" % ("ID", "Resource", "$/month", "$/hour", "$/%dh" % RUN_HOURS))
    for w in PATTERNS:
        hourly = costs[w] / HOURS_PER_MONTH
        print("%-4s %-42s %10.2f %10.4f %10.2f" % (w, LABELS[w], costs[w], hourly, hourly * RUN_HOURS))
    total = sum(costs.values())
    hourly = total / HOURS_PER_MONTH
    run = hourly * RUN_HOURS
    print("%-4s %-42s %10.2f %10.4f %10.2f" % ("", "TOTAL", total, hourly, run))
    print()
    print("Estimated hourly cost:   $%.4f" % hourly)
    print("Estimated %d-hour cost:  $%.2f (limit $%.2f)" % (RUN_HOURS, run, LIMIT_USD))
    if run > LIMIT_USD:
        print("STOP: the %d-hour estimate is above $%.2f." % (RUN_HOURS, LIMIT_USD))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
