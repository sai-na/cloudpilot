/**
 * Uploading scans, offline: where an upload may go, what each answer of the
 * hosted service is turned into, what is retried, and that the token (a
 * secret) never comes back out in anything printed. The sender itself is run
 * against a server on 127.0.0.1.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { httpUploader, judge, makeSender, parseDestination, scanJson, scrub, TOKEN_VARIABLE, upload, type Destination, type Reply, type UploadSender } from "../src/upload.js";
import { hosted, stored, TOKEN } from "./hosted.js";
import { finding, scan } from "./scans.js";

const HOST = "hosted.example.com";
const URL_ = `https://${HOST}/api/ingest`;
const destination = parseDestination(URL_, TOKEN);

const result = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)]);

/** A sender that answers with `steps` in turn (the last repeats), and keeps what it was asked. */
function sender(...steps: Array<Reply | Error>) {
  const calls: Array<{ destination: Destination; body: string }> = [];
  const send: UploadSender = async (d, body) => {
    calls.push({ destination: d, body });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  };
  const pauses: number[] = [];
  const pause = async (ms: number) => void pauses.push(ms);
  return { calls, pauses, run: (body = "{}") => upload(destination, body, { send, pause }, new AbortController().signal) };
}

const reply = (status: number, body: object | string = {}): Reply => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });

// Where an upload may go

test("an https address is taken, and only its host is ever shown", () => {
  const d = parseDestination("https://hosted.example.com:8443/api/ingest?x=1", TOKEN);
  assert.equal(d.host, "hosted.example.com:8443");
  assert.equal(d.url, "https://hosted.example.com:8443/api/ingest?x=1");
  assert.equal(d.token, TOKEN);
});

test("plain http is for this machine only", () => {
  assert.equal(parseDestination("http://127.0.0.1:3000/api/ingest", TOKEN).host, "127.0.0.1:3000");
  assert.equal(parseDestination("http://localhost:3000/api/ingest", TOKEN).host, "localhost:3000");
  assert.throws(() => parseDestination("http://hosted.example.com/api/ingest", TOKEN), (err: Error) => {
    assert.equal(err.message, "The --upload URL (hosted.example.com) is not an https URL. The upload token goes with every request and must not travel unencrypted.");
    return true;
  });
  // A name that merely starts like a loopback host is not one.
  assert.throws(() => parseDestination("http://127.0.0.1.example.com/x", TOKEN), /is not an https URL/);
  assert.throws(() => parseDestination("ftp://hosted.example.com/x", TOKEN), /is not an https URL/);
});

test("an address that is not a URL is refused without being repeated back", () => {
  assert.throws(() => parseDestination(`not a url ${TOKEN}`, TOKEN), (err: Error) => {
    assert.equal(err.message, "The --upload URL is not a URL. (It is not shown, in case it carries a secret.)");
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test("an address with a user name or password in it is refused, naming only the host", () => {
  assert.throws(() => parseDestination("https://alice:hunter2@hosted.example.com/api/ingest", TOKEN), (err: Error) => {
    assert.equal(err.message, `The --upload URL (hosted.example.com) has a user name or password in it. The token goes in ${TOKEN_VARIABLE}, not in the URL.`);
    assert.ok(!err.message.includes("hunter2") && !err.message.includes("alice"));
    return true;
  });
});

test("no token is an error that says where it goes and why it is not a flag", () => {
  for (const missing of [undefined, "", "   "]) {
    assert.throws(() => parseDestination(URL_, missing), {
      message: `--upload needs the upload token in the environment variable ${TOKEN_VARIABLE}. It is never taken from a command-line flag, because a flag ends up in shell history and in the process list.`,
    });
  }
});

test("a token that cannot be a header value is refused without being shown", () => {
  for (const bad of ["cpt_with space", "cpt_line\nbreak", "cpt_café"]) {
    assert.throws(() => parseDestination(URL_, bad), (err: Error) => {
      assert.match(err.message, new RegExp(`^${TOKEN_VARIABLE} holds characters that cannot be in a token`));
      assert.ok(!err.message.includes(bad));
      return true;
    });
  }
  // Whitespace around it, as a copied line leaves, is not part of it.
  assert.equal(parseDestination(URL_, `  ${TOKEN}\n`).token, TOKEN);
});

// What is sent

test("what is uploaded is what --json prints: the result, the summary, and the replay banner when there is one", () => {
  assert.deepEqual(scanJson(result, "A summary."), { ...result, summary: "A summary." });
  assert.deepEqual(scanJson(result, "A summary.", "REPLAY MODE: x"), { ...result, summary: "A summary.", replay: "REPLAY MODE: x" });
});

// What each answer is turned into

const lines: Array<[string, Reply, boolean, string]> = [
  ["201 stored", reply(201, { counts: { findings: 12, new: 3, cameBack: 1, resolved: 2, unchanged: 8 } }), true, `Uploaded the scan to ${HOST}: stored (3 new, 1 came back, 2 resolved, 8 unchanged).`],
  ["201 without counts it can read", reply(201, "stored"), true, `Uploaded the scan to ${HOST}: stored.`],
  ["201 with counts that are not numbers", reply(201, { counts: { new: "3", cameBack: 0, resolved: 0, unchanged: 0 } }), true, `Uploaded the scan to ${HOST}: stored.`],
  ["200 already stored", reply(200, { duplicate: true }), true, `Uploaded the scan to ${HOST}: this exact scan was already stored, so nothing changed.`],
  [
    "401 token not accepted",
    reply(401, { error: "This upload token is not valid." }),
    false,
    `Could not upload the scan to ${HOST}: the token in ${TOKEN_VARIABLE} was not accepted. It is wrong or has been revoked: make a new one in the hosted service's settings and set the variable again.`,
  ],
  [
    "409 older than the latest stored",
    reply(409, { error: "This scan was taken at 2026-10-01, before the latest scan stored for this source (2026-10-02)." }),
    false,
    `Could not upload the scan to ${HOST}: a later scan of this account or cluster is already stored, so this older one was refused. Check the clock of this machine: a scan taken after the stored one is accepted.`,
  ],
  [
    "413 too large",
    reply(413, { error: "The body is larger than 5 MB." }),
    false,
    `Could not upload the scan to ${HOST}: the scan is larger than the service accepts. Scan a smaller part at a time, with --region or --namespace.`,
  ],
  [
    "422 not a scan result, naming the field",
    reply(422, { error: "This is not a CloudPilot scan result.", problems: [{ path: "findings.3.pattern", message: "must be a rule name such as unattached-ebs-volume" }, { path: "warnings.0", message: "must be at most 4000 characters" }] }),
    false,
    `Could not upload the scan to ${HOST}: the service does not take this as a scan result (findings.3.pattern: must be a rule name such as unattached-ebs-volume). CloudPilot and the service disagree about that field: update CloudPilot, and report it if it still happens.`,
  ],
  [
    "422 with a reason and no field",
    reply(422, { error: "scannedAt (2030-01-01T00:00:00Z) is more than a day in the future. Check the clock of the machine that ran the scan." }),
    false,
    `Could not upload the scan to ${HOST}: the service does not take this as a scan result (scannedAt (2030-01-01T00:00:00Z) is more than a day in the future. Check the clock of the machine that ran the scan.). Update CloudPilot, and report it if it still happens.`,
  ],
  ["422 with nothing it can read", reply(422, "<html>nope</html>"), false, `Could not upload the scan to ${HOST}: the service does not take this as a scan result. Update CloudPilot, and report it if it still happens.`],
  [
    "a redirect",
    reply(308),
    false,
    `Could not upload the scan to ${HOST}: it answered 308, a redirect, which CloudPilot does not follow because the token would go with it. Give the address it redirects to as --upload.`,
  ],
  ["404, a wrong address", reply(404, "<html>Not found</html>"), false, `Could not upload the scan to ${HOST}: it answered 404, which CloudPilot does not know. Check that --upload is the address of the service's upload endpoint.`],
  ["400", reply(400, { error: "The body is not JSON." }), false, `Could not upload the scan to ${HOST}: it answered 400, which CloudPilot does not know. Check that --upload is the address of the service's upload endpoint.`],
];

for (const [name, answer, ok, line] of lines) {
  test(`${name}: one plain line`, async () => {
    assert.deepEqual(judge(answer, destination), { ok, line, key: ok ? judge(answer, destination).key : `answered ${answer.status}` });
    assert.ok(!line.includes("\n"));
    const s = sender(answer);
    assert.deepEqual(await s.run(), judge(answer, destination));
    assert.equal(s.calls.length, 1, "an answer that says what is wrong is not retried, and one that stored it needs no second try");
  });
}

test("a server error is tried once more, and a second one is the answer", async () => {
  const s = sender(reply(503, "unavailable"));
  assert.deepEqual(await s.run(), { ok: false, line: `Could not upload the scan to ${HOST}: it answered 503. The service is failing: try again later.`, key: "answered 503" });
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.pauses, [2000]);
  assert.equal(s.calls[0]!.body, s.calls[1]!.body, "the same scan, so the service cannot store it twice");
});

test("a server error that clears on the retry is a stored scan", async () => {
  const s = sender(reply(502), reply(201, { counts: { findings: 1, new: 1, cameBack: 0, resolved: 0, unchanged: 0 } }));
  assert.deepEqual(await s.run(), { ok: true, line: `Uploaded the scan to ${HOST}: stored (1 new, 0 came back, 0 resolved, 0 unchanged).`, key: "stored" });
  assert.equal(s.calls.length, 2);
});

test("no answer at all is tried once more, then said with the reason and what to check", async () => {
  const s = sender(new Error(`could not reach ${HOST} (fetch failed: getaddrinfo ENOTFOUND ${HOST})`));
  assert.deepEqual(await s.run(), {
    ok: false,
    line: `Could not upload the scan to ${HOST}: could not reach ${HOST} (fetch failed: getaddrinfo ENOTFOUND ${HOST}). Check the address and the network.`,
    key: `no answer: could not reach ${HOST} (fetch failed: getaddrinfo ENOTFOUND ${HOST})`,
  });
  assert.equal(s.calls.length, 2, "never more than one retry");
  const late = sender(new Error(`${HOST} did not answer within 20 seconds`), reply(200));
  assert.equal((await late.run()).ok, true);
  assert.equal(late.calls.length, 2);
});

test("a loop can tell the same failure from another: by status, or by reason with its numbers left out", async () => {
  const key = async (step: Reply | Error) => (await sender(step).run()).key;
  assert.equal(await key(new Error("could not reach 127.0.0.1:4000 (fetch failed)")), await key(new Error("could not reach 127.0.0.1:5000 (fetch failed)")));
  assert.notEqual(await key(new Error("could not reach 127.0.0.1:4000 (fetch failed)")), await key(new Error("127.0.0.1:4000 did not answer within 20 seconds")));
  assert.notEqual(await key(reply(401)), await key(reply(404)));
  assert.notEqual(await key(reply(500)), await key(reply(503)));
  assert.equal(await key(reply(401)), await key(reply(401, { error: "another body" })));
});

test("a stop during the wait is not retried", async () => {
  const stop = new AbortController();
  const calls: number[] = [];
  const send: UploadSender = async () => (calls.push(1), { status: 503, body: "" });
  const outcome = await upload(destination, "{}", { send, pause: async () => stop.abort() }, stop.signal);
  assert.equal(calls.length, 1);
  assert.equal(outcome.ok, false);
});

// The token stays out of what is printed

test("whatever the service says, the token and the address are taken out, and a long answer is cut", async () => {
  const echo = `Bearer ${TOKEN} sent to ${URL_} ${"x".repeat(5000)}\nsecond line`;
  const outcomes = [
    judge(reply(422, { error: echo }), destination),
    judge(reply(422, { problems: [{ path: `findings.${TOKEN}`, message: echo }] }), destination),
  ];
  for (const { line } of outcomes) {
    assert.ok(!line.includes(TOKEN), line);
    assert.ok(!line.includes(URL_), line);
    assert.ok(line.length < 500, "an answer is never dumped");
    assert.ok(!line.includes("\n"));
    assert.match(line, /\[token\]/);
  }
  const failing = await sender(new Error(`could not reach ${HOST} (${TOKEN})`)).run();
  assert.ok(failing.line.includes(HOST) && !failing.line.includes(TOKEN) && failing.line.includes("[token]"));
});

test("scrub takes out the token, the address and the part of it after the host", () => {
  const d = parseDestination("https://hosted.example.com/api/ingest?key=abc", TOKEN);
  const text = scrub(`${d.url} ${d.token} /api/ingest?key=abc`, d);
  assert.equal(text, "[url] [token] [url]");
});

test("an address that carries the token in it still leaves only the host", () => {
  const d = parseDestination(`https://hosted.example.com/api/ingest?key=${TOKEN}`, TOKEN);
  const text = scrub(`rejected ${d.url} and ${d.token} and /api/ingest?key=${TOKEN}`, d);
  assert.equal(text, "rejected [url] and [token] and [url]");
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes("/api/ingest"));
});

// The real sender, against a server on this machine

test("one POST: the token as a bearer token, the body as JSON, nothing else of the machine", async () => {
  const server = await hosted(() => stored());
  try {
    const d = parseDestination(server.url, TOKEN);
    const answer = await httpUploader(d, JSON.stringify({ a: 1 }), new AbortController().signal);
    assert.equal(answer.status, 201);
    assert.equal(server.requests.length, 1);
    const [request] = server.requests;
    assert.equal(request!.method, "POST");
    assert.equal(request!.path, "/api/ingest");
    assert.equal(request!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request!.headers["content-type"], "application/json");
    assert.equal(request!.body, '{"a":1}');
  } finally {
    await server.close();
  }
});

test("a redirect is not followed: the token does not go where nobody configured", async () => {
  const elsewhere = await hosted(() => ({ status: 200 }));
  const server = await hosted(() => ({ status: 307, headers: { location: elsewhere.url } }));
  try {
    const d = parseDestination(server.url, TOKEN);
    const answer = await httpUploader(d, "{}", new AbortController().signal);
    assert.equal(answer.status, 307);
    assert.equal(elsewhere.requests.length, 0);
    assert.match((await upload(d, "{}", { send: httpUploader, pause: async () => {} }, new AbortController().signal)).line, /it answered 307, a redirect, which CloudPilot does not follow/);
  } finally {
    await server.close();
    await elsewhere.close();
  }
});

test("a service that never answers is given up on, so the scan is never held by it", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const d = parseDestination(`http://127.0.0.1:${port}/api/ingest`, TOKEN);
    await assert.rejects(makeSender(100)(d, "{}", new AbortController().signal), { message: `127.0.0.1:${port} did not answer within 0.1 seconds` });
    const outcome = await upload(d, "{}", { send: makeSender(100), pause: async () => {} }, new AbortController().signal);
    assert.equal(outcome.ok, false);
    assert.match(outcome.line, /^Could not upload the scan to 127\.0\.0\.1:\d+: 127\.0\.0\.1:\d+ did not answer within 0\.1 seconds\. Check the address and the network\.$/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a stop ends a send that is waiting for an answer", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const stop = new AbortController();
    const d = parseDestination(`http://127.0.0.1:${port}/api/ingest`, TOKEN);
    const sending = makeSender(60_000)(d, "{}", stop.signal);
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(sending, { message: "stopped before it was sent" });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a service that cannot be reached is said with its host, never its address", async () => {
  const server = await hosted(() => ({ status: 200 }));
  const d = parseDestination(server.url.replace("/api/ingest", `/api/ingest?key=${TOKEN}`), TOKEN);
  await server.close();
  const outcome = await upload(d, "{}", { send: httpUploader, pause: async () => {} }, new AbortController().signal);
  assert.equal(outcome.ok, false);
  assert.match(outcome.line, /^Could not upload the scan to 127\.0\.0\.1:\d+: could not reach 127\.0\.0\.1:\d+ \(fetch failed: connect ECONNREFUSED/);
  assert.ok(!outcome.line.includes(TOKEN));
});

test("an answer of any length is read only at its start", async () => {
  const server = createServer((_, res) => {
    res.writeHead(422, { "content-type": "application/json" });
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const more = () => {
      while (sent < 200 && res.write(chunk)) sent++;
      if (sent < 200) res.once("drain", more);
      else res.end();
    };
    more();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const d = parseDestination(`http://127.0.0.1:${port}/api/ingest`, TOKEN);
    const answer = await httpUploader(d, "{}", new AbortController().signal);
    assert.equal(answer.status, 422);
    assert.ok(answer.body.length <= 16 * 1024, `${answer.body.length} characters kept of 12 MB`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
