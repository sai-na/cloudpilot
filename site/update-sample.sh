#!/usr/bin/env bash
# Regenerate the sample report shown on the landing page from a live scan of
# the test account, with the account ID replaced:
#   site/sample-report.html   the real report file
#   site/sample-report.png    a sharp (2x) screenshot of its top
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node packages/cli/dist/index.js scan --profile "${CLOUDPILOT_PROFILE:-cloudpilot-readonly}" \
  --region "${CLOUDPILOT_REGION:-ap-south-1}" --redact-account --html site/sample-report.html > /dev/null

# The sample is public: swap the lab's real resource IDs, upload ID and
# public IP for obvious stand-ins. Amounts and findings stay as scanned.
python3 - site/sample-report.html <<'PY'
import re, sys
path = sys.argv[1]
html = open(path).read()
head, body = html.split("<main>", 1)
ids = {}
def stand_in(match):
    prefix = match.group(1)
    return ids.setdefault(match.group(0), "%s-%017x" % (prefix, len(ids) + 1))
body = re.sub(r"\b(vol|snap|ami|i|eipalloc)-[0-9a-f]{17}\b", stand_in, body)
body = re.sub(r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "203.0.113.10", body)
body = re.sub(r"[A-Za-z0-9._]{60,}", "EXAMPLE-UPLOAD-ID", body)
open(path, "w").write(head + "<main>" + body)
print("Replaced %d resource IDs" % len(ids))
PY

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1100,1640 --screenshot="$PWD/site/sample-report.png" "file://$PWD/site/sample-report.html" > /dev/null 2>&1

echo "Wrote site/sample-report.html and site/sample-report.png"
