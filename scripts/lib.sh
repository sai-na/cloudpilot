# Shared settings for the waste-lab shell scripts. Source this, don't run it.
# Works with the bash 3.2 that ships with macOS.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/lab-spec.json"

spec() { jq -r "$1" "$SPEC"; }

REGION="$(spec .region)"
AZ="$(spec .az)"
PROFILE="$(spec .seed_profile)"
PROJECT="$(spec .project_tag)"
ROLE_NAME="$(spec .readonly_role)"

# AWS_ENDPOINT_URL set means emulator mode (Moto). The AWS CLI honours the
# variable itself; we only swap the profile for dummy credentials.
if [[ -n "${AWS_ENDPOINT_URL:-}" ]]; then
  MODE="emulator"
else
  MODE="real"
fi
STATE_DIR="$ROOT/lab-state/$MODE"

aws_() {
  if [[ "$MODE" == "emulator" ]]; then
    env -u AWS_PROFILE AWS_ACCESS_KEY_ID=testing AWS_SECRET_ACCESS_KEY=testing \
      aws --region "$REGION" "$@"
  else
    aws --profile "$PROFILE" --region "$REGION" "$@"
  fi
}

# Terraform, kept in a separate workspace per mode so the emulator can never
# touch the real state file.
tf() {
  if [[ "$MODE" == "emulator" ]]; then
    if ! env -u TF_WORKSPACE terraform -chdir="$ROOT/terraform" workspace list | grep -q ' emulator$'; then
      # "workspace new" also selects it; switch back so plain terraform stays on real.
      env -u TF_WORKSPACE terraform -chdir="$ROOT/terraform" workspace new emulator >/dev/null
      env -u TF_WORKSPACE terraform -chdir="$ROOT/terraform" workspace select default >/dev/null
    fi
    TF_WORKSPACE=emulator \
      TF_VAR_use_emulator=true \
      TF_VAR_emulator_endpoint="$AWS_ENDPOINT_URL" \
      AWS_ACCESS_KEY_ID=testing AWS_SECRET_ACCESS_KEY=testing \
      terraform -chdir="$ROOT/terraform" "$@"
  else
    TF_WORKSPACE=default terraform -chdir="$ROOT/terraform" "$@"
  fi
}

# Resolved once, up front: every script stops here if the credentials are wrong.
ACCOUNT_ID="$(aws_ sts get-caller-identity --query Account --output text)"

account_id() { echo "$ACCOUNT_ID"; }

bucket_name() { echo "$(spec .bucket_prefix)-$ACCOUNT_ID"; }

tag_filters() { echo "Name=tag:Project,Values=$PROJECT Name=tag:WastePattern,Values=$1"; }

banner() {
  echo "== $1"
  echo "   mode: $MODE   region: $REGION   account: $ACCOUNT_ID"
  if [[ "$MODE" == "emulator" ]]; then
    echo "   EMULATOR: $AWS_ENDPOINT_URL (Moto, not AWS)"
  fi
}

# Sets CONFIRM=1 when --confirm is among the arguments.
parse_confirm() {
  CONFIRM=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --confirm) CONFIRM=1 ;;
      -h|--help) echo "usage: $(basename "$0") [--confirm]   (dry run without --confirm)"; exit 0 ;;
      *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
  done
}
