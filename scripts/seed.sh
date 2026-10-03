#!/usr/bin/env bash
# Plant the two waste patterns Terraform cannot express:
#   W6  orphaned snapshot (create a volume, snapshot it, delete the volume)
#   W9  abandoned multipart upload in the W8 bucket
# Dry run by default. Pass --confirm to create them. Run after terraform apply.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_confirm "$@"

W6_GB="$(spec .w6.size_gb)"
W6_TYPE="$(spec .w6.type)"
W9_KEY="$(spec .w9.key)"
W9_MB="$(spec .w9.part_mb)"
BUCKET="$(bucket_name)"

banner "Seed W6 and W9"

# shellcheck disable=SC2046
existing_snapshot="$(aws_ ec2 describe-snapshots --owner-ids self \
  --filters $(tag_filters W6) --query 'Snapshots[0].SnapshotId' --output text)"
existing_upload="$(aws_ s3api list-multipart-uploads --bucket "$BUCKET" \
  --query "Uploads[?Key=='$W9_KEY'] | [0].UploadId" --output text 2>/dev/null || echo "NO_BUCKET")"

echo
echo "Plan:"
if [[ "$existing_snapshot" != "None" ]]; then
  echo "  W6  skip - snapshot $existing_snapshot already exists"
else
  echo "  W6  create a $W6_GB GB $W6_TYPE volume in $AZ, snapshot it, then DELETE the volume"
  echo "      leaves: 1 snapshot whose source volume no longer exists"
fi
if [[ "$existing_upload" == "NO_BUCKET" ]]; then
  echo "  W9  BLOCKED - bucket $BUCKET does not exist yet (run terraform apply first)"
elif [[ "$existing_upload" != "None" ]]; then
  echo "  W9  skip - multipart upload $existing_upload already exists"
else
  echo "  W9  start a multipart upload to s3://$BUCKET/$W9_KEY, upload one $W9_MB MB part,"
  echo "      never complete it"
fi

if [[ "$CONFIRM" -ne 1 ]]; then
  echo
  echo "Dry run only. Re-run with --confirm to create these."
  exit 0
fi
if [[ "$existing_upload" == "NO_BUCKET" ]]; then
  echo "Bucket $BUCKET is missing; nothing created." >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

if [[ "$existing_snapshot" == "None" ]]; then
  echo
  echo "W6: creating volume..."
  volume_id="$(aws_ ec2 create-volume --availability-zone "$AZ" --size "$W6_GB" --volume-type "$W6_TYPE" \
    --tag-specifications "ResourceType=volume,Tags=[{Key=Project,Value=$PROJECT},{Key=WastePattern,Value=W6},{Key=Name,Value=$PROJECT-w6-temp-source-volume}]" \
    --query VolumeId --output text)"
  aws_ ec2 wait volume-available --volume-ids "$volume_id"
  echo "W6: snapshotting $volume_id..."
  snapshot_id="$(aws_ ec2 create-snapshot --volume-id "$volume_id" \
    --description "$PROJECT W6 orphaned snapshot" \
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=Project,Value=$PROJECT},{Key=WastePattern,Value=W6},{Key=Name,Value=$PROJECT-w6-orphaned-snapshot}]" \
    --query SnapshotId --output text)"
  aws_ ec2 wait snapshot-completed --snapshot-ids "$snapshot_id"
  echo "W6: deleting source volume $volume_id..."
  aws_ ec2 delete-volume --volume-id "$volume_id"
  echo "W6: done - snapshot $snapshot_id (source volume $volume_id deleted)"
else
  snapshot_id="$existing_snapshot"
fi

if [[ "$existing_upload" == "None" ]]; then
  echo
  echo "W9: starting multipart upload..."
  part_file="$(mktemp)"
  trap 'rm -f "$part_file"' EXIT
  head -c $((W9_MB * 1024 * 1024)) /dev/urandom > "$part_file"
  upload_id="$(aws_ s3api create-multipart-upload --bucket "$BUCKET" --key "$W9_KEY" \
    --tagging "Project=$PROJECT&WastePattern=W9" --query UploadId --output text)"
  aws_ s3api upload-part --bucket "$BUCKET" --key "$W9_KEY" --part-number 1 \
    --upload-id "$upload_id" --body "$part_file" >/dev/null
  echo "W9: done - upload $upload_id left incomplete with one $W9_MB MB part"
else
  upload_id="$existing_upload"
fi

jq -n --arg snap "$snapshot_id" --arg bucket "$BUCKET" --arg key "$W9_KEY" --arg upload "$upload_id" \
  '{w6_snapshot_id: $snap, w9_bucket: $bucket, w9_key: $key, w9_upload_id: $upload}' \
  > "$STATE_DIR/seed.json"
echo
echo "Recorded in $STATE_DIR/seed.json"
