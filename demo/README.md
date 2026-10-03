# Demo runbook

Run everything from the repository root.

## Live, with network

```sh
# 1. The scan: every region, findings, fix commands, summary
node packages/cli/dist/index.js --profile cloudpilot-readonly

# 2. The same, one region, with a model-written summary and an HTML report
node packages/cli/dist/index.js scan --profile cloudpilot-readonly --region ap-south-1 \
  --explain --html report.html && open report.html

# 3. Questions
node packages/cli/dist/index.js ask --profile cloudpilot-readonly --region ap-south-1 \
  "What should I fix first, and what is the risk?"
node packages/cli/dist/index.js ask --profile cloudpilot-readonly --region ap-south-1 \
  "Is the running instance really idle? Check its CPU over the last 12 hours."

# 4. Proof it cannot change anything: a read succeeds, a write is refused
scripts/prove-readonly.sh

# 5. Proof it is accurate: scored against the planted answer key
node packages/cli/dist/index.js eval --profile cloudpilot-readonly --manifest lab-manifest.json
```

`--explain` and `ask` need a model key in `.env` (`OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`). Without one, the scan still ends with a summary built
from the findings.

## From an AI editor (MCP)

```sh
claude mcp add cloudpilot -- node "$PWD/packages/cli/dist/index.js" mcp --profile cloudpilot-readonly
```

Then ask Claude Code something like "scan my AWS account for waste and tell
me what to fix first". It calls CloudPilot's read-only tools and answers
from the results. Remove it again with `claude mcp remove cloudpilot`. Add
`--replay "$PWD/recordings/demo"` after `mcp` to run it without network.

## Without network

```sh
demo/record.sh     # once, while online: records the scan and both questions
demo/replay.sh     # any time after: plays them back with no network calls
```

Every replayed output starts with a `REPLAY MODE` banner. Say so when you
show it. A recording belongs to the build that made it, so record again
after changing dependencies. `--redact-account` on either script shows the
account ID as 123456789012.

To ask a new question against the recorded account with a live model:

```sh
node packages/cli/dist/index.js ask --replay recordings/demo --live-llm "Which finding is riskiest to fix?"
```

## The capture in the README

`docs/demo.gif` is made from recordings, with no network:

```sh
(cd packages/cli && npm run build)
python3 demo/capture.py     # writes docs/demo.cast and docs/demo.gif
```

It runs three commands against recordings in this repository (the AWS lab
fixture in `packages/cli/test/fixtures/lab`, and the Kubernetes lab in
`demo/cluster-lab`) and shows what they print. Only the timing is scripted:
the typing and the pauses. It is a rendering of replayed output, not a live
screen recording, and every scene shows the `REPLAY MODE` line. Making the GIF
needs [`agg`](https://github.com/asciinema/agg); without it only the cast is
written.

`(cd packages/cli && npm test)` fails when the capture no longer matches what
the commands print, when a scene no longer fits the screen the GIF is rendered
at, or when the Kubernetes recording stops replaying. Then run the script
again; after a change to how the cluster is read, record the lab again first:

```sh
node packages/cli/dist/index.js kube --context kind-cloudpilot-lab --lookback-hours 1 --no-compare --record demo/cluster-lab
```

