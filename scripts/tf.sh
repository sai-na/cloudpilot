#!/usr/bin/env bash
# Run Terraform for the lab in the right workspace:
#   scripts/tf.sh plan
#   AWS_ENDPOINT_URL=http://localhost:5050 scripts/tf.sh plan   # emulator
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tf "$@"
