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

# The page itself must load nothing from another site: scripts, styles, fonts
# and images all come from this folder.
if grep -Eq '<script[^>]+src=|<link[^>]+href=|@import|url\([[:space:]]*["'"'"']?(https?:)?//|<img[^>]+src=["'"'"']?(https?:)?//' "$page"; then fail "the page loads something from another site"; fi

# ...and every local file it points at has to be here, so a renamed font or
# screenshot cannot ship as a silent 404. The list comes from the page itself.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  [[ -f "site/$file" ]] || fail "site/$file is missing, but the page asks for it"
done < <(grep -oE 'url\([[:space:]]*["'"'"']?[^"'"'"')]+|(src|href)="[^"]+"' "$page" \
  | sed -E 's/^url\([[:space:]]*["'"'"']?//; s/^(src|href)="//; s/"$//' \
  | grep -vE '^(#|(https?:)?//|data:|mailto:)' | sort -u)

# The fonts the page serves ship with their licences.
for file in fonts/OFL-Archivo.txt fonts/OFL-CourierPrime.txt; do
  [[ -f "site/$file" ]] || fail "site/$file is missing"
done

if [[ "$problems" -eq 0 ]]; then echo "Ready to deploy: no placeholders, every link and claim checks out."; else echo; echo "$problems thing(s) to settle before deploying."; exit 1; fi
