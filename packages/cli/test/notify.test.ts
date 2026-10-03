/**
 * Notifications, offline: what each service is sent, how a long list is cut,
 * and that a webhook URL (a secret) never comes back out in anything printed.
 * The sender itself is run against a server on 127.0.0.1.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScans } from "../src/compare.js";
import { compose, deliver, httpSender, LIMIT, notifyUrls, parseTargets, plainText, scrub, subjectOf, type Notice, type Sender } from "../src/notify.js";
import { enableRedaction, startLive } from "../src/recording.js";
import { comparisonLine, money } from "../src/report.js";
import { finding, scan } from "./scans.js";
import { hook } from "./webhook.js";

import { SECRET } from "./webhook.js";
const SLACK = `https://hooks.slack.com/services/${SECRET}`;
const DISCORD = `https://discord.com/api/webhooks/1234567890/${SECRET}`;
const GENERIC = `https://example.com/hooks/${SECRET}`;

const yesterday = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57), finding("vol-0bbbbbbbbbbbbbbbb", 18.24, { title: "Unattached 200 GB gp3 volume" })], { scannedAt: "2026-10-02T00:00:00Z" });
// Most expensive first, as a scan lists them.
const today = scan([
  finding("vol-0aaaaaaaaaaaaaaaa", 57),
  finding("vol-0dddddddddddddddd", 9.12),
  finding("i-0cccccccccccccccc", 8.9056, { pattern: "idle-instance", title: "Idle t3.micro: CPU never above 3.4%", resourceType: "AWS::EC2::Instance", fix: { commands: ["aws ec2 stop-instances --instance-ids i-0cccccccccccccccc"], risk: "caution", rollback: "" } }),
]);
const compared = compareScans(yesterday, today)!;

const newFindings: Notice = { kind: "findings", result: compared, first: false };

// Which service gets what

test("the service is chosen from the URL", () => {
  assert.deepEqual(parseTargets([SLACK, DISCORD, GENERIC, `https://discordapp.com/api/webhooks/1/${SECRET}`, "https://hooks.slack.com.evil.example/x"]).map((t) => t.kind), [
    "slack",
    "discord",
    "generic",
    "discord",
    "generic",
  ]);
  // A Discord address that is not a webhook is not treated as one.
  assert.equal(parseTargets(["https://discord.com/channels/1/2"])[0]!.kind, "generic");
  assert.deepEqual(parseTargets([SLACK, GENERIC]).map((t) => t.host), ["hooks.slack.com", "example.com"]);
});

test("--notify wins over CLOUDPILOT_NOTIFY, which is comma-separated, and repeats and blanks are dropped", () => {
  assert.deepEqual(notifyUrls(undefined, `${SLACK}, ${DISCORD},,${SLACK}`), [SLACK, DISCORD]);
  assert.deepEqual(notifyUrls([GENERIC], SLACK), [GENERIC]);
  assert.deepEqual(notifyUrls([], SLACK), [SLACK]);
  assert.deepEqual(notifyUrls(undefined, undefined), []);
});

test("a URL that is not https, or not a URL, is refused without being repeated back", () => {
  assert.throws(() => parseTargets(["http://example.com/hooks/" + SECRET]), (err: Error) => {
    assert.match(err.message, /example\.com\) is not an https URL/);
    assert.ok(!err.message.includes(SECRET));
    return true;
  });
  assert.throws(() => parseTargets([`not a url ${SECRET}`]), (err: Error) => {
    assert.match(err.message, /notify URL 1 of 1 is not a URL/);
    assert.ok(!err.message.includes(SECRET));
    return true;
  });
  assert.doesNotThrow(() => parseTargets(["http://127.0.0.1:8080/hook", "http://localhost:8080/hook"]), "a test server on this machine may use http");
});

// The messages, exactly

test("new findings: the exact text for Slack, Discord and a generic webhook", () => {
  const [slack, discord, generic] = parseTargets([SLACK, DISCORD, GENERIC]).map((t) => JSON.parse(compose(newFindings, t)));
  const lines = (bold: string, code: string) => [
    `${bold}CloudPilot: 2 new findings, $18.03 a month, AWS account 123456789012${bold}`,
    "Since the last scan (2026-10-02T00:00:00Z): 2 new ($18.03 a month), 1 resolved ($18.24 a month), 1 unchanged.",
    "",
    `1. $9.12/mo  Unattached 500 GB gp2 volume (${code}vol-0dddddddddddddddd${code}), region ap-south-1, permanent fix`,
    `2. $8.91/mo  Idle t3.micro: CPU never above 3.4% (${code}i-0cccccccccccccccc${code}), region ap-south-1, reversible fix`,
    "",
    "Nothing has been changed: every fix is a proposal for a person to review and run.",
    "Run cloudpilot to see each finding's evidence and fix commands.",
  ];
  assert.deepEqual(slack, { text: lines("*", "`").join("\n") });
  assert.deepEqual(discord, { content: lines("**", "`").join("\n"), allowed_mentions: { parse: [] } });
  // The generic webhook is told in plain lines, and gets the new findings themselves.
  assert.equal(generic.text, lines("", "").join("\n"));
  assert.equal(generic.event, "new-findings");
  assert.equal(generic.subject, "AWS account 123456789012");
  assert.deepEqual(generic.comparison, compared.comparison);
  assert.deepEqual(generic.findings, compared.findings.filter((f) => f.isNew));
});

test("the first report lists everything once, and says why", () => {
  const first: Notice = { kind: "findings", result: today, first: true };
  const text = plainText(first);
  assert.equal(text.split("\n")[0], `CloudPilot: first report, 3 findings, ${money(today.totalMonthlyWasteUsd)} a month, AWS account 123456789012`);
  assert.match(text, /^No earlier scan to compare with, so every finding is listed\.$/m);
  assert.equal(text.match(/^\d+\. /gm)?.length, 3);
  assert.equal(JSON.parse(compose(first, { kind: "generic" })).event, "first-report");
  assert.equal(JSON.parse(compose(first, { kind: "generic" })).comparison, null);
});

test("a cluster is named as a cluster and its findings by namespace", () => {
  const cluster = scan([finding("deployment/api", 12.5, { region: "shop", pattern: "over-requested-workload", title: "Deployment api requests more than it uses", resourceType: "apps/v1 Deployment" })], {
    accountId: "prod-cluster",
    regions: ["shop"],
    cluster: { context: "prod-cluster", lookbackHours: 168, prices: { source: "opencost-defaults", cpuHourUsd: 0.031611, memoryGibHourUsd: 0.004237, storageGibMonthUsd: 0.04 } },
  });
  assert.equal(subjectOf(cluster), "cluster prod-cluster");
  const text = plainText({ kind: "findings", result: cluster, first: true });
  assert.match(text, /^CloudPilot: first report, 1 finding, \$12\.50 a month, cluster prod-cluster$/m);
  assert.match(text, /^1\. \$12\.50\/mo {2}Deployment api requests more than it uses \(deployment\/api\), namespace shop, permanent fix$/m);
});

test("a check that could not run is said in the message", () => {
  const result = { ...compared, warnings: ["[ap-south-1] ec2:DescribeVolumes was denied"] };
  assert.match(plainText({ kind: "findings", result, first: false }), /^1 check\(s\) could not run, so some findings may be missing\.$/m);
  assert.doesNotMatch(plainText(newFindings), /could not run/);
});

test("the check itself failing, and recovering, are messages of their own", () => {
  const failed: Notice = { kind: "failed", subject: "AWS account 123456789012", reason: "The security token included in the request is expired", at: "2026-10-03T06:00:00.000Z", watching: true };
  assert.equal(
    plainText(failed),
    [
      "CloudPilot: the check itself failed (AWS account 123456789012)",
      "CloudPilot could not finish checking at 2026-10-03T06:00:00.000Z, so this is not a report that nothing is new.",
      "Reason: The security token included in the request is expired",
      "This is said once. CloudPilot keeps trying and will say so when checking works again.",
      "",
      "Nothing has been changed: this check only reads.",
    ].join("\n"),
  );
  assert.doesNotMatch(plainText({ ...failed, watching: false } as Notice), /keeps trying/);
  assert.equal(JSON.parse(compose(failed, { kind: "generic" })).error, "The security token included in the request is expired");
  assert.equal(JSON.parse(compose(failed, { kind: "generic" })).event, "check-failed");

  const recovered: Notice = { kind: "recovered", subject: "cluster prod", since: "2026-10-03T06:00:00.000Z", at: "2026-10-03T12:00:00.000Z" };
  assert.equal(
    plainText(recovered),
    "CloudPilot: checking works again (cluster prod)\nThe check had been failing since 2026-10-03T06:00:00.000Z and completed at 2026-10-03T12:00:00.000Z. Nothing new was found.",
  );
  const withNew = plainText({ ...newFindings, recoveredSince: "2026-10-03T06:00:00.000Z" } as Notice);
  assert.match(withNew, /^Checking works again: it had been failing since 2026-10-03T06:00:00\.000Z\.$/m);
});

test("a replay's banner leads the message, so it cannot pass for a live one", () => {
  const banner = "REPLAY MODE: recorded 2026-10-03T07:08:26.099Z from account 123456789012, region ap-south-1. No live calls. Notifications are still sent.";
  assert.equal(plainText({ ...newFindings, banner } as Notice).split("\n")[1], banner);
});

// Limits

const many = (n: number) => scan(Array.from({ length: n }, (_, i) => finding(`vol-${String(i).padStart(17, "0")}`, 100 - i / 10, { title: "Unattached 500 GB gp2 volume with a long enough title to fill a message" })));

test("a long list is cut to what Discord and Slack take, and says how many were left out", () => {
  const result = many(60);
  const notice: Notice = { kind: "findings", result, first: true };
  for (const [kind, limit, text] of [
    ["discord", LIMIT.discord, (b: string) => JSON.parse(b).content as string],
    ["slack", LIMIT.slack, (b: string) => JSON.parse(b).text as string],
  ] as const) {
    const message = text(compose(notice, { kind }));
    assert.ok(message.length <= limit, `${kind}: ${message.length} characters`);
    const listed = message.match(/^\d+\. /gm)!.length;
    assert.ok(listed > 0 && listed < 60, `${kind} lists some but not all (${listed})`);
    assert.match(message, new RegExp(`\\.\\.\\. and ${60 - listed} more not listed here: they are in the CloudPilot report\\.`));
    // What gives way is the list: the headline and the closing lines are still there.
    assert.match(message, /CloudPilot: first report, 60 findings/);
    assert.match(message, /Nothing has been changed: every fix is a proposal/);
    // And the findings that are listed are the first ones, in the scan's order.
    assert.ok(message.includes("vol-00000000000000000"));
  }
  // The generic webhook has no such limit and gets all of them.
  assert.equal(JSON.parse(compose(notice, { kind: "generic" })).findings.length, 60);
});

test("one finding left out is said in the singular, and nothing is said when all fit", () => {
  const notice = (n: number): Notice => ({ kind: "findings", result: many(n), first: true });
  const fits = JSON.parse(compose(notice(5), { kind: "discord" })).content as string;
  assert.doesNotMatch(fits, /not listed here/);
  // Find the list length at which exactly one has to go.
  let n = 5;
  while (!/and 1 more/.test(JSON.parse(compose(notice(n), { kind: "discord" })).content)) n++;
  assert.match(JSON.parse(compose(notice(n), { kind: "discord" })).content, /\.\.\. and 1 more not listed here: it is in the CloudPilot report\./);
});

test("a failure reason too long for the message is cut to the limit", () => {
  const failed: Notice = { kind: "failed", subject: "cluster prod", reason: "x".repeat(5000), at: "2026-10-03T06:00:00.000Z", watching: true };
  assert.ok(JSON.parse(compose(failed, { kind: "discord" })).content.length <= LIMIT.discord);
  assert.ok(JSON.parse(compose(failed, { kind: "slack" })).text.length <= LIMIT.slack);
});

test("costs and IDs are the scan's own, and a name cannot ping a channel", () => {
  const hostile = scan([finding("vol-0aaaaaaaaaaaaaaaa", 1234.5, { title: "Volume <!channel> & @everyone `x`" })]);
  const slack = JSON.parse(compose({ kind: "findings", result: hostile, first: true }, { kind: "slack" })).text as string;
  assert.match(slack, /Volume &lt;!channel&gt; &amp; @everyone `x`/);
  assert.match(slack, /\$1234\.50\/mo/);
  const discord = JSON.parse(compose({ kind: "findings", result: hostile, first: true }, { kind: "discord" }));
  assert.deepEqual(discord.allowed_mentions, { parse: [] });
  // The monthly cost and the ID in every message come from the finding, not from a sum.
  for (const f of compared.findings.filter((x) => x.isNew)) {
    for (const text of [plainText(newFindings), JSON.parse(compose(newFindings, { kind: "slack" })).text]) {
      assert.ok(text.includes(money(f.monthlyCostUsd)));
      assert.ok(text.includes(f.resourceIds[0]!));
    }
  }
  assert.ok(plainText(newFindings).includes(comparisonLine(compared)!));
  // A long opaque ID is shortened as the terminal report shortens it.
  const long = "u".repeat(100);
  assert.match(plainText({ kind: "findings", result: scan([finding(long, 1)]), first: true }), /\(uuuuuuuuuuuuuuuu\.\.\.uuuuuu\)/);
});

// A URL is a secret

test("scrub takes the URL, and the path that carries the secret, out of any text", () => {
  const targets = parseTargets([SLACK, GENERIC]);
  const text = `could not reach ${SLACK}; also /services/${SECRET} and ${GENERIC}?x=1 and /hooks/${SECRET}`;
  const clean = scrub(text, targets);
  assert.ok(!clean.includes(SECRET), clean);
  assert.match(clean, /could not reach \[webhook\]/);
});

test("delivery never lets a URL out, even when the sender's error carries it", async () => {
  const targets = parseTargets([SLACK, DISCORD]);
  const leaky: Sender = async (target) => {
    throw new Error(`POST ${target.url} failed (path /${new URL(target.url).pathname.slice(1)})`);
  };
  const delivery = await deliver(targets, newFindings, leaky, new AbortController().signal);
  assert.equal(delivery.done.size, 0);
  assert.equal(delivery.failures.length, 2);
  assert.ok(!delivery.failures.join("\n").includes(SECRET), delivery.failures.join("\n"));
});

test("a retry skips the targets that already have the message and tries every other one even when one fails", async () => {
  const targets = parseTargets([SLACK, DISCORD, GENERIC]);
  const sent: string[] = [];
  const send: Sender = async (target) => {
    if (target.kind === "discord") throw new Error("discord.com answered 429");
    sent.push(target.kind);
  };
  const first = await deliver(targets, newFindings, send, new AbortController().signal);
  assert.deepEqual([...first.done].sort(), [0, 2]);
  assert.deepEqual(first.failures, ["discord.com answered 429"]);
  assert.deepEqual(sent.sort(), ["generic", "slack"], "one broken webhook did not stop the others");
  sent.length = 0;
  const again = await deliver(targets, newFindings, send, new AbortController().signal, first.done);
  assert.deepEqual(sent, [], "the two that have it are not sent it again");
  assert.deepEqual([...again.done].sort(), [0, 2]);
});

// The real sender, against a server on this machine

test("the sender posts the JSON body once, and an answer in the 2xx range is delivery", async () => {
  const server = await hook(() => ({ status: 200, body: "ok" }));
  try {
    const [target] = parseTargets([server.url]);
    await httpSender(target!, '{"a":1}', new AbortController().signal);
    assert.deepEqual(server.requests.map((r) => [r.url, r.type, r.body]), [[`/hooks/${SECRET}`, "application/json", '{"a":1}']]);
  } finally {
    await server.close();
  }
});

test("an error answer is a failed send that names the host and what it said, never the URL", async () => {
  const server = await hook(() => ({ status: 404, body: "no_service" }));
  try {
    const [target] = parseTargets([server.url]);
    await assert.rejects(httpSender(target!, "{}", new AbortController().signal), (err: Error) => {
      assert.equal(err.message, `${target!.host} answered 404 (no_service)`);
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
  } finally {
    await server.close();
  }
});

test("a redirect is a failed send and is not followed, so the message goes only where it was configured", async () => {
  const elsewhere = await hook(() => ({ status: 200 }));
  const server = await hook(() => ({ status: 307, headers: { location: elsewhere.url } }));
  try {
    const [target] = parseTargets([server.url]);
    await assert.rejects(httpSender(target!, "{}", new AbortController().signal), /answered 307, a redirect, which CloudPilot does not follow/);
    assert.equal(elsewhere.requests.length, 0);
  } finally {
    await server.close();
    await elsewhere.close();
  }
});

test("a webhook that cannot be reached is a failed send that does not carry the URL", async () => {
  const server = await hook(() => ({ status: 200 }));
  const [target] = parseTargets([server.url]);
  await server.close();
  const delivery = await deliver([target!], newFindings, httpSender, new AbortController().signal);
  assert.equal(delivery.done.size, 0);
  assert.match(delivery.failures[0]!, /^could not reach 127\.0\.0\.1:\d+ \(/);
  assert.ok(!delivery.failures[0]!.includes(SECRET));
});

test("a send stops when told to stop, instead of holding up Ctrl+C", async () => {
  const server = await hook(() => ({ status: 200 }));
  try {
    const [target] = parseTargets([server.url]);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(httpSender(target!, "{}", stop.signal), /stopped before it was sent/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

// Last, because it changes how this process's output is written.
test("--redact-account hides the real account ID in every message", async () => {
  startLive({ redact: true });
  enableRedaction("999999999999");
  const real = scan([finding("vol-0aaaaaaaaaaaaaaaa", 57)], { accountId: "999999999999" });
  const bodies: string[] = [];
  const send: Sender = async (_target, body) => void bodies.push(body);
  await deliver(parseTargets([SLACK, DISCORD, GENERIC]), { kind: "findings", result: real, first: true }, send, new AbortController().signal);
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.ok(!body.includes("999999999999"), body);
    assert.ok(body.includes("123456789012"));
  }
});
