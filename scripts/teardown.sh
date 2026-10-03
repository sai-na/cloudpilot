#!/usr/bin/env bash
# Remove the waste lab.
# Dry run by default: lists every resource tagged Project=cloudpilot-waste-lab.
# With --confirm: deletes everything, runs terraform destroy, then sweeps again.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_confirm "$@"

PROJECT_FILTER="Name=tag:Project,Values=$PROJECT"
LIVE_STATES="Name=instance-state-name,Values=pending,running,stopping,stopped"

lab_buckets() {
  local bucket tag
  for bucket in $(aws_ s3api list-buckets --query 'Buckets[].Name' --output text); do
    tag="$(aws_ s3api get-bucket-tagging --bucket "$bucket" \
      --query "TagSet[?Key=='Project'] | [0].Value" --output text 2>/dev/null || true)"
    # The name match is a fallback for a bucket whose tags did not stick.
    if [[ "$tag" == "$PROJECT" || "$bucket" == "$(bucket_name)" ]]; then
      echo "$bucket"
    fi
  done
}

# Prints every tagged resource and sets LEFT to how many there are.
sweep() {
  local lines bucket uploads
  lines="$(
    aws_ ec2 describe-volumes --filters "$PROJECT_FILTER" \
      --query "Volumes[].['EBS volume',VolumeId,State,Tags[?Key=='WastePattern']|[0].Value]" --output text
    aws_ ec2 describe-snapshots --owner-ids self --filters "$PROJECT_FILTER" \
      --query "Snapshots[].['Snapshot',SnapshotId,State,Tags[?Key=='WastePattern']|[0].Value]" --output text
    aws_ ec2 describe-images --owners self --filters "$PROJECT_FILTER" \
      --query "Images[].['AMI',ImageId,State,Tags[?Key=='WastePattern']|[0].Value]" --output text
    aws_ ec2 describe-instances --filters "$PROJECT_FILTER" "$LIVE_STATES" \
      --query "Reservations[].Instances[].['Instance',InstanceId,State.Name,Tags[?Key=='WastePattern']|[0].Value]" --output text
    aws_ ec2 describe-addresses --filters "$PROJECT_FILTER" \
      --query "Addresses[].['Elastic IP',AllocationId,PublicIp,Tags[?Key=='WastePattern']|[0].Value]" --output text
    for bucket in $(lab_buckets); do
      printf 'S3 bucket\t%s\t-\tW8\n' "$bucket"
      uploads="$(aws_ s3api list-multipart-uploads --bucket "$bucket" \
        --query 'Uploads[].UploadId' --output text)"
      if [[ -n "$uploads" && "$uploads" != "None" ]]; then
        for upload in $uploads; do
          printf 'S3 multipart upload\t%s\t%s\tW9\n' "${upload:0:24}..." "$bucket"
        done
      fi
    done
  )"
  LEFT=0
  if [[ -n "$lines" ]]; then
    LEFT="$(printf '%s\n' "$lines" | wc -l | tr -d ' ')"
    printf '%s\n' "$lines" | awk -F'\t' '{printf "  %-20s %-34s %-18s %s\n", $1, $2, $3, $4}'
  else
    echo "  (nothing)"
  fi
}

banner "Teardown"
echo
echo "Resources tagged Project=$PROJECT:"
sweep
echo
echo "Also managed by Terraform (no Project tag sweep): IAM role $ROLE_NAME, budget $PROJECT-monthly"

if [[ "$CONFIRM" -ne 1 ]]; then
  echo
  echo "Dry run only: $LEFT tagged resource(s) would be deleted, then terraform destroy would run."
  echo "Re-run with --confirm to delete."
  exit 0
fi

echo
echo "-- S3: aborting multipart uploads, emptying and deleting buckets"
for bucket in $(lab_buckets); do
  aws_ s3api list-multipart-uploads --bucket "$bucket" \
    --query 'Uploads[].[Key,UploadId]' --output text | while IFS=$'\t' read -r key upload; do
    if [[ -n "$key" && "$key" != "None" ]]; then
      aws_ s3api abort-multipart-upload --bucket "$bucket" --key "$key" --upload-id "$upload"
      echo "   aborted upload for $key"
    fi
  done
  aws_ s3 rm "s3://$bucket" --recursive
  aws_ s3api delete-bucket --bucket "$bucket"
  echo "   deleted bucket $bucket"
done

echo "-- AMIs: deregistering and deleting their snapshots"
for image in $(aws_ ec2 describe-images --owners self --filters "$PROJECT_FILTER" \
  --query 'Images[].ImageId' --output text); do
  snapshots="$(aws_ ec2 describe-images --image-ids "$image" \
    --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text)"
  aws_ ec2 deregister-image --image-id "$image"
  echo "   deregistered $image"
  for snapshot in $snapshots; do
    if [[ "$snapshot" != "None" ]]; then
      aws_ ec2 delete-snapshot --snapshot-id "$snapshot"
      echo "   deleted snapshot $snapshot"
    fi
  done
done

echo "-- W6: deleting orphaned snapshots"
# shellcheck disable=SC2046
for snapshot in $(aws_ ec2 describe-snapshots --owner-ids self --filters $(tag_filters W6) \
  --query 'Snapshots[].SnapshotId' --output text); do
  aws_ ec2 delete-snapshot --snapshot-id "$snapshot"
  echo "   deleted snapshot $snapshot"
done

echo "-- terraform destroy"
tf destroy -auto-approve -input=false

echo
echo "Sweep after teardown:"
sweep
if [[ "$LEFT" -ne 0 ]]; then
  echo
  echo "WARNING: $LEFT tagged resource(s) are still left - see the list above."
  exit 1
fi
echo
echo "Teardown complete: nothing tagged Project=$PROJECT is left."
