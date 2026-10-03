/**
 * Every fix a rule prints, held against what apply will run.
 *
 * The rules and apply's allow-list are written apart, so nothing but this
 * file stops a new rule from printing a fix that apply refuses to run, or
 * that apply runs under the wrong risk. The findings come from running the
 * real rules: the account rules over an account built to trigger each of
 * them, the cluster rules over the recorded lab.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { apply, ApplyError, commandRisk, plan, RUNNABLE, runnable, tokenize, type AuditEntry, type Runner } from "../src/apply.js";
import { collectCluster, type KubeReader } from "../src/kube.js";
import { detectCluster, OPENCOST_DEFAULTS } from "../src/kube-detect.js";
import { PATTERNS, type Finding, type Fix, type ScanResult } from "../src/types.js";
import { everyAwsFinding, scan } from "./scans.js";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-03T12:00:00Z");
const options = { maxAgeHours: 24, now: NOW };

const kubeFixture = JSON.parse(readFileSync(resolve(here, "fixtures/kube-lab.json"), "utf8"));
const reader: KubeReader = { identity: async () => kubeFixture.identity, get: async (path) => kubeFixture.responses[path] };
const clusterScan: ScanResult = {
  ...detectCluster(await collectCluster(reader, { lookbackHours: kubeFixture.lookbackHours, now: new Date(kubeFixture.recordedAt) }), OPENCOST_DEFAULTS),
  scannedAt: "2026-10-03T11:00:00Z",
};
const accountScan: ScanResult = scan(everyAwsFinding(), { scannedAt: "2026-10-03T11:00:00Z" });

/** Each finding with the scan it came from, so a plan can be made for it alone. */
const all = [...accountScan.findings.map((finding) => ({ finding, from: accountScan })), ...clusterScan.findings.map((finding) => ({ finding, from: clusterScan }))];
const alone = ({ finding, from }: (typeof all)[number]): ScanResult => ({ ...from, findings: [finding] });

/** Both fixes of a finding: the main one, then the alternative if it has one. */
const fixesOf = (f: Finding): Array<[string, Fix]> => [["fix", f.fix], ...(f.alternative ? [["alternative", f.alternative] as [string, Fix]] : [])];
const printed = all.flatMap(({ finding }) => fixesOf(finding).flatMap(([, fix]) => fix.commands));
const riskOf = (fix: Fix) => (fix.commands.some((c) => commandRisk(c) === "dangerous") ? "dangerous" : "caution");

test("the rules are all exercised: every pattern a rule can report is among the findings gone through here", () => {
  assert.deepEqual([...new Set(all.map(({ finding }) => finding.pattern))].sort(), [...PATTERNS].sort());
  assert.ok(printed.length >= 25, `${printed.length} commands`);
});

test("every command every rule prints, in a main fix or an alternative, is one apply accepts", () => {
  for (const { finding } of all) {
    for (const [which, fix] of fixesOf(finding)) {
      assert.ok(fix.commands.length > 0, `${finding.pattern} ${which} prints no command`);
      for (const command of fix.commands) {
        const args = runnable(command);
        assert.ok(args[0] === "aws" || args[0] === "kubectl", command);
      }
    }
  }
});

test("every fix is classified as risky as the commands in it are: a delete is permanent, a resize or a stop is not", () => {
  for (const { finding } of all) {
    for (const [which, fix] of fixesOf(finding)) {
      assert.equal(fix.risk, riskOf(fix), `${finding.pattern} ${which} states ${fix.risk}: ${fix.commands.join(" ; ")}`);
    }
  }
});

test("apply takes the risk from the finding, in the choice of fix, the prompt and the record", async () => {
  for (const item of all) {
    const { finding } = item;
    const named = finding.resourceIds[0]!;
    const label = `${finding.pattern} ${named}`;

    // Without --allow-permanent only a fix that can be undone is chosen; with it, the finding's own fix.
    const undoable = fixesOf(finding).find(([, fix]) => fix.risk === "caution");
    if (undoable) {
      const chosen = plan([alone(item)], [named], options)[0]!;
      assert.equal(chosen.fix, undoable[1], label);
      assert.equal(chosen.fix.risk, "caution", label);
    } else {
      assert.throws(() => plan([alone(item)], [named], options), /The only fix for .* is permanent/, label);
    }
    const asked = plan([alone(item)], [named], { ...options, allowPermanent: true })[0]!;
    assert.equal(asked.fix, finding.fix, label);
    assert.deepEqual(asked.commands.map((c) => c.args), finding.fix.commands.map((c) => tokenize(c)), label);

    // The record states the same risk, and a permanent fix runs only once its ID is typed back.
    for (const chosen of [asked, ...(undoable && undoable[1] !== finding.fix ? [plan([alone(item)], [named], options)[0]!] : [])]) {
      const ran: string[][] = [];
      const runner: Runner = { run: async (program, args) => (ran.push([program, ...args]), { exitCode: 0, output: "" }) };
      const log: AuditEntry[] = [];
      const ctx = { runner, say: () => {}, record: async (e: AuditEntry) => void log.push(e), user: "test", now: () => NOW };

      const unattended = await apply([chosen], { ...ctx, yes: true });
      if (chosen.fix.risk === "dangerous") {
        assert.deepEqual(unattended, ["refused"], `${label}: a permanent fix is never run with nobody to type the ID`);
        assert.deepEqual(ran, [], label);
        const wrong = await apply([chosen], { ...ctx, ask: async () => "yes" });
        assert.deepEqual(wrong, ["declined"], `${label}: anything but the ID declines`);
        assert.deepEqual(ran, [], label);
        assert.deepEqual(await apply([chosen], { ...ctx, ask: async () => named }), ["applied"], label);
      } else {
        assert.deepEqual(unattended, ["applied"], label);
      }
      assert.deepEqual(ran, chosen.commands.map((c) => c.args), `${label}: exactly the printed commands, in order, as arguments`);
      assert.ok(log.length >= 1 && log.every((e) => e.risk === chosen.fix.risk), `${label}: the record states the finding's risk`);
    }
  }
});

test("a fix that calls itself undoable but holds a command that cannot be undone is not run", async () => {
  const dangerous = all.filter(({ finding }) => finding.fix.risk === "dangerous");
  assert.ok(dangerous.length >= 8);
  for (const item of dangerous) {
    const relabelled: ScanResult = { ...alone(item), findings: [{ ...item.finding, fix: { ...item.finding.fix, risk: "caution" }, alternative: undefined }] };
    const label = item.finding.pattern;
    for (const allowPermanent of [false, true]) {
      assert.throws(() => plan([relabelled], [item.finding.resourceIds[0]!], { ...options, allowPermanent }), /says it can be undone but holds a command that cannot be/, label);
    }
  }
  // The other way round is only more careful, and is allowed.
  const careful = all.find(({ finding }) => finding.fix.risk === "caution" && finding.pattern === "gp2-volume")!;
  const chosen = plan([{ ...alone(careful), findings: [{ ...careful.finding, fix: { ...careful.finding.fix, risk: "dangerous" } }] }], [careful.finding.resourceIds[0]!], { ...options, allowPermanent: true });
  assert.equal(chosen[0]!.fix.risk, "dangerous");
});

/** The kinds the rules print, each found by the words of the allow-list entry a printed command starts with. */
const kindsPrinted = new Set(printed.map((command) => RUNNABLE.find(({ kind }) => kind.split(" ").every((word, n) => tokenize(command)[n] === word))?.kind));

test("every kind apply may run is printed by some rule, so the list is no wider than the rules", () => {
  assert.ok(!kindsPrinted.has(undefined));
  assert.deepEqual(
    RUNNABLE.map(({ kind }) => kind).filter((kind) => !kindsPrinted.has(kind)),
    [],
    "an entry no rule prints should not be on the list",
  );
  assert.deepEqual(
    RUNNABLE.map(({ kind }) => kind).sort(),
    [
      "aws ec2 delete-nat-gateway",
      "aws ec2 delete-snapshot",
      "aws ec2 delete-volume",
      "aws ec2 deregister-image",
      "aws ec2 modify-instance-attribute",
      "aws ec2 modify-volume",
      "aws ec2 release-address",
      "aws ec2 start-instances",
      "aws ec2 stop-instances",
      "aws ec2 terminate-instances",
      "aws ec2 wait instance-stopped",
      "aws elbv2 delete-load-balancer",
      "aws rds delete-db-instance",
      "aws rds stop-db-instance",
      "aws s3api abort-multipart-upload",
      "aws s3api put-bucket-lifecycle-configuration",
      "kubectl delete persistentvolume",
      "kubectl delete persistentvolumeclaim",
      "kubectl set resources",
    ],
  );
});

test("a kind of command no rule prints is refused, near misses and neighbours of the allowed ones included", () => {
  const near = RUNNABLE.map(({ kind }) => {
    const words = kind.split(" ");
    // The last word made longer, and the last word swapped for a sibling.
    return [[...words.slice(0, -1), `${words.at(-1)}s`].join(" "), [...words.slice(0, -1), "describe-everything"].join(" ")];
  }).flat();
  for (const command of [
    ...near,
    "aws ec2 delete-security-group --group-id sg-1",
    "aws ec2 delete-vpc --vpc-id vpc-1",
    "aws ec2 create-nat-gateway --subnet-id subnet-1",
    "aws ec2 reboot-instances --instance-ids i-1",
    "aws ec2 modify-instance-metadata-options --instance-id i-1",
    "aws ec2 create-snapshot --volume-id vol-1",
    "aws elbv2 delete-target-group --target-group-arn arn:x",
    "aws elbv2 delete-listener --listener-arn arn:x",
    "aws elbv2 modify-load-balancer-attributes --load-balancer-arn arn:x",
    "aws rds modify-db-instance --db-instance-identifier db --no-deletion-protection",
    "aws rds delete-db-cluster --db-cluster-identifier c",
    "aws rds start-db-instance --db-instance-identifier db",
    "aws s3api delete-bucket --bucket b",
    "aws s3api delete-bucket-lifecycle --bucket b",
    "aws s3 rb s3://b --force",
    "aws iam put-user-policy --user-name x",
    "kubectl delete deployment api",
    "kubectl delete namespace shop",
    "kubectl delete persistentvolumes x",
    "kubectl scale deployment/api --replicas=0",
    "kubectl get persistentvolume x",
    "kubectl apply -f x.yaml",
  ]) {
    assert.throws(() => runnable(command), (err) => err instanceof ApplyError && /only runs the kinds of command its own rules print/.test(err.message), command);
  }
});
