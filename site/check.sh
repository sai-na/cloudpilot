#!/usr/bin/env bash
# Run before deploying the landing page. Fails while anything on it is still
# a placeholder or a claim the repository does not back up.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
page=site/index.html
problems=0
fail() { echo "NOT READY: $1"; problems=$((problems + 1)); }

grep -q "YOUR_FORM_ID" "$page" && fail "the waitlist form has no real address (replace YOUR_FORM_ID in the form's action)"

repo="$(grep -o 'href="https://github.com/[^"]*"' "$page" | head -1 | cut -d'"' -f2)"
if ! curl -fsS -o /dev/null --max-time 15 "$repo"; then fail "the GitHub link $repo does not open (repository missing or private)"; fi

package="$(grep -o 'npx [^<]*' "$page" | head -1 | cut -d' ' -f2)"
if ! npm view "$package" version >/dev/null 2>&1; then fail "the one-liner's package $package is not on npm yet"; fi

licence="$(node -p "require('./packages/cli/package.json').license")"
if grep -q "AGPL" "$page" && [[ "$licence" != AGPL* ]]; then fail "the page says AGPL but the package is licensed $licence"; fi

# Everything the page points at, read once so both checks below agree on what
# a reference is: the CSS url() function and the attributes that name a file.
loaders='script|link|img|iframe|video|audio|source|embed|object|track|input|use'
references() {
  grep -oE "url\([[:space:]]*[\"']?[^\"')]+" "$page" | sed -E "s/^url\([[:space:]]*[\"']?//"
  for attr in src srcset href xlink:href data poster; do
    grep -oE "<($1)([[:space:]][^>]*)?[[:space:]]$attr=[\"']?[^\"'[:space:]>]+" "$page" \
      | sed -E "s/.*[[:space:]]$attr=[\"']?//"
  done
}

# The page itself must load nothing from another site: scripts, styles, fonts
# and images all come from this folder. Only the tags that fetch something
# count here, so the page's GitHub links stay allowed.
offsite="$(references "$loaders" | grep -E '^(https?:)?//')"
if grep -Eq '<script[^>]+src=|<link[^>]+href=|@import' "$page" || [[ -n "$offsite" ]]; then
  fail "the page loads something from another site"
fi

# ...and every local file it points at has to be here, so a renamed font or
# screenshot cannot ship as a silent 404. A link may lead off-site, but one
# that leads back here has to land on something.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  [[ -f "site/$file" ]] || fail "site/$file is missing, but the page asks for it"
done < <(references "$loaders|a" | grep -vE '^(#|(https?:)?//|data:|mailto:)' | sort -u)

# The fonts the page serves ship with their licences.
for file in fonts/OFL-Archivo.txt fonts/OFL-CourierPrime.txt; do
  [[ -f "site/$file" ]] || fail "site/$file is missing"
done

if [[ "$problems" -eq 0 ]]; then echo "Ready to deploy: no placeholders, every link and claim checks out."; else echo; echo "$problems thing(s) to settle before deploying."; exit 1; fi
