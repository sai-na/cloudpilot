#!/usr/bin/env python3
"""Make the terminal capture in docs/demo.gif from recorded scans. No network.

Each scene really runs the built CLI against a recording in this repository
and shows what it printed. Only the timing is made up: the typing of the
command and the pauses are scripted, so the capture is the same every time.
It is a rendering of replayed output, not a live screen recording, and each
scene shows the REPLAY MODE line that says so.

Usage, from the repository root, after `npm run build` in packages/cli:
    python3 demo/capture.py            # writes docs/demo.cast and docs/demo.gif
Needs `agg` (https://github.com/asciinema/agg) to turn the cast into a GIF;
without it, only the cast is written.
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "packages", "cli", "dist", "index.js")
COLS, ROWS = 112, 30

# The arguments really run, and how many lines of the report to show (the shown
# command pipes into `head` for the same number). What the viewer sees typed is
# these same arguments, so the command above the output is the one that made it.
SCENES = [
    (["scan", "--replay", "aws-lab", "--no-compare"], 19),
    (["kube", "--replay", "cluster-lab", "--no-compare"], 19),
    (["kube", "--replay", "cluster-lab", "--answer-key", "answer-key.json"], None),
]

# The whole environment each scene runs in, built from nothing like the one the
# guard test uses (packages/cli/test/helpers.ts): no AWS profile, no model key,
# no webhook, no colour. The maintainer's own shell must not reach the capture,
# or it renders something the test can never reproduce.
ENV = {
    "PATH": os.environ.get("PATH", ""),
    "HOME": os.environ.get("HOME", ""),
    "NO_COLOR": "1",
    "AWS_CONFIG_FILE": "/dev/null",
    "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
    "AWS_EC2_METADATA_DISABLED": "true",
    # An unreachable proxy, in case anything honours it: these scenes are replays and call nothing.
    "HTTPS_PROXY": "http://127.0.0.1:9",
    "HTTP_PROXY": "http://127.0.0.1:9",
}

ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def rows_filled(lines: list[str]) -> int:
    """
    How many rows of the COLS-wide screen these lines fill, counting the row the
    cursor ends on. A line longer than the screen wraps onto further rows, and
    every line here is followed by a newline, so the last one costs a row too.
    agg scrolls rather than shrinks: a scene over the budget loses its top rows,
    the prompt and the REPLAY MODE line first, from the GIF alone.
    """
    width = (len(ESCAPE.sub("", line)) for line in lines)
    return sum(max(1, math.ceil(chars / COLS)) for chars in width) + 1


def main() -> int:
    if not os.path.exists(CLI):
        print("Build the CLI first: (cd packages/cli && npm run build)", file=sys.stderr)
        return 1
    clock = 0.0
    events = []

    def out(text: str, wait: float = 0.0) -> None:
        nonlocal clock
        clock += wait
        events.append([round(clock, 3), "o", text])

    stage = tempfile.mkdtemp(prefix="cloudpilot-capture-")
    try:
        os.symlink(os.path.join(ROOT, "packages", "cli", "test", "fixtures", "lab"), os.path.join(stage, "aws-lab"))
        os.symlink(os.path.join(ROOT, "demo", "cluster-lab"), os.path.join(stage, "cluster-lab"))
        shutil.copy(os.path.join(ROOT, "k8s-lab", "answer-key.json"), os.path.join(stage, "answer-key.json"))

        for number, (args, head) in enumerate(SCENES):
            done = subprocess.run(["node", CLI, *args], cwd=stage, env=ENV, capture_output=True, text=True)
            if done.returncode != 0:
                print(done.stderr, file=sys.stderr)
                return 1
            shown = " ".join(["cloudpilot", *args])
            report = done.stdout.rstrip("\n").split("\n")
            if head is not None:
                shown, report = f"{shown} | head -{head}", report[:head]
            # Progress goes to stderr, so on a terminal it comes before the report and is not cut by head.
            lines = done.stderr.rstrip("\n").split("\n") + report
            filled = rows_filled([f"$ {shown}", *lines])
            if filled > ROWS:
                print(
                    f"Scene {number + 1} (cloudpilot {args[0]}) fills {filled} rows of the {ROWS}-row screen, so the GIF "
                    f"would scroll its first {filled - ROWS} row(s) away, starting with the prompt and the REPLAY MODE line. "
                    f"Show fewer lines of the report, or raise ROWS.",
                    file=sys.stderr,
                )
                return 1
            out("\x1b[1;32m$\x1b[0m ", 0.6)
            for char in shown:
                out(char, 0.035)
            out("\r\n", 0.5)
            for line in lines:
                out(line + "\r\n", 0.05)
            last = number == len(SCENES) - 1
            out(" " if last else "\x1b[2J\x1b[H", 5.0 if last else 4.5)
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    cast = os.path.join(ROOT, "docs", "demo.cast")
    with open(cast, "w") as file:
        file.write(json.dumps({"version": 2, "width": COLS, "height": ROWS, "env": {"TERM": "xterm-256color"}}) + "\n")
        for event in events:
            file.write(json.dumps(event) + "\n")
    print(f"Wrote {os.path.relpath(cast, ROOT)} ({round(clock)} seconds)")

    if not shutil.which("agg"):
        print("agg is not installed, so no GIF was made. Install it and run this again.", file=sys.stderr)
        return 0
    gif = os.path.join(ROOT, "docs", "demo.gif")
    render = subprocess.run(
        ["agg", "--cols", str(COLS), "--rows", str(ROWS), "--font-size", "14", "--fps-cap", "10", "--idle-time-limit", "5", "--theme", "asciinema", cast, gif],
        capture_output=True,
        text=True,
    )
    if render.returncode != 0:
        print(render.stderr.rstrip("\n") or f"agg exited {render.returncode}", file=sys.stderr)
        return 1
    print(f"Wrote {os.path.relpath(gif, ROOT)} ({os.path.getsize(gif) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
