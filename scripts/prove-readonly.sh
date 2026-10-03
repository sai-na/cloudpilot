#!/usr/bin/env bash
# Live demo: prove the cloudpilot-readonly role can read but cannot write.
#   1. assume the role (temporary credentials, never printed)
#   2. run a harmless read that succeeds
#   3. try to tag the W3 Elastic IP and show the denial
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROLE_ARN="arn:aws:iam::$(account_id):role/$ROLE_NAME"
# shellcheck disable=SC2046
EIP="$(aws_ ec2 describe-addresses --filters $(tag_filters W3) \
  --query 'Addresses[0].AllocationId' --output text)"
if [[ "$EIP" == "None" ]]; then
  echo "W3 Elastic IP not found - is the lab applied?" >&2
  exit 1
fi

echo "== 1. Assume $ROLE_ARN"
read -r RO_KEY RO_SECRET RO_TOKEN <<<"$(aws_ sts assume-role --role-arn "$ROLE_ARN" \
  --role-session-name prove-readonly --duration-seconds 900 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"

ro() {
  env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$RO_KEY" AWS_SECRET_ACCESS_KEY="$RO_SECRET" \
    AWS_SESSION_TOKEN="$RO_TOKEN" aws --region "$REGION" "$@"
}
echo "   now acting as: $(ro sts get-caller-identity --query Arn --output text)"
if [[ "$MODE" == "emulator" ]]; then
  echo "   EMULATOR: Moto does not enforce IAM policies, so the write below will NOT be denied."
fi

echo
echo "== 2. Read: ec2 describe-addresses (allowed by ec2:Describe*)"
ro ec2 describe-addresses --allocation-ids "$EIP" \
  --query 'Addresses[].{AllocationId:AllocationId,PublicIp:PublicIp,Associated:AssociationId}' --output table

echo
echo "== 3. Write: ec2 create-tags on $EIP (not in the policy)"
if denial="$(ro ec2 create-tags --resources "$EIP" --tags Key=ProveReadonly,Value=should-fail 2>&1)"; then
  # The write went through: undo it with the seed profile and fail loudly.
  aws_ ec2 delete-tags --resources "$EIP" --tags Key=ProveReadonly
  echo "   UNEXPECTED: the write succeeded (the tag has been removed again)."
  if [[ "$MODE" == "emulator" ]]; then
    echo "   Expected in emulator mode - IAM is not enforced there."
    exit 0
  fi
  exit 1
fi
# EC2 reports an IAM denial as UnauthorizedOperation; trim the long encoded blob.
echo "$denial" | sed 's/Encoded authorization failure message:.*/[encoded failure detail trimmed]/' | sed 's/^/   /'
if echo "$denial" | grep -Eq 'UnauthorizedOperation|AccessDenied'; then
  echo
  echo "Access denied, as expected: the role can read but cannot change anything."
  exit 0
fi
echo "The write failed, but not with an access-denied error - check the message above." >&2
exit 1
