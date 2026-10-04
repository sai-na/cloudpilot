# Emulator fallback (Moto)

For use only if the venue network fails. It runs the lab against a local
[Moto](https://github.com/getmoto/moto) server instead of AWS.

## What is not real in emulator mode

- **IAM policies are not enforced.** Moto accepts every call, so the
  `cloudpilot-readonly` role can write. `scripts/prove-readonly.sh` will not
  show a denial here; that demo step only works against real AWS.
- **Idle CPU data is synthetic.** Emulated instances do not run, so there is
  no real `CPUUtilization`. `emulator/inject-idle-metrics.sh` writes made-up
  datapoints for the W5 instance and says so in its output.
- **NAT gateway and load balancer rules are not in the lab.** The lab plants
  none, and the offline price file has no NAT gateway or load balancer prices,
  so an emulator scan with `--offline` reports neither rule. They were run
  against Moto by calling `collect` and `detect` with a price book written by
  hand and synthetic CloudWatch points (the emulator's quirks included: it
  names a Network Load Balancer `app/...` and answers `DescribeTargetGroups`
  for a balancer with none with an error).
- **There is no budget.** Terraform skips it when `use_emulator = true`.
- **Nothing costs anything**, and prices still come from the real price table
  in `pricing/ap-south-1.json`, fetched earlier from AWS.

## Run it

```sh
docker compose -f emulator/docker-compose.yml up -d
export AWS_ENDPOINT_URL=http://localhost:5050

scripts/tf.sh init
scripts/tf.sh apply
scripts/seed.sh --confirm
emulator/inject-idle-metrics.sh --confirm
python3 scripts/build_manifest.py   # writes lab-state/emulator/lab-manifest.json
python3 scripts/verify.py

# CloudPilot itself, fully offline
node packages/cli/dist/index.js eval --region ap-south-1 --offline \
  --price-file pricing/ap-south-1.json --manifest lab-state/emulator/lab-manifest.json
```

Every script switches to the emulator when `AWS_ENDPOINT_URL` is set, and
`scripts/tf.sh` switches Terraform to a separate `emulator` workspace with
`use_emulator = true`, so the emulator never touches the real state file or
the real `lab-manifest.json`. Point CloudPilot at the same endpoint.

Moto keeps everything in memory: `docker compose -f emulator/docker-compose.yml down`
wipes the emulated account. Unset `AWS_ENDPOINT_URL` to go back to real AWS.

Host port 5050 is used because macOS AirPlay Receiver already holds 5000.
