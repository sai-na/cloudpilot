/**
 * A stand-in for AWS for the spend anomalies command: the caller is account
 * 123456789012, and Cost Explorer answers each request with the next answer it
 * was given. Nothing here reaches beyond this machine, and no Cost Explorer
 * request is ever made, so none is charged. Point a process at it with
 * AWS_ENDPOINT_URL.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const IDENTITY =
  '<?xml version="1.0"?><GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/alice</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>';

export interface Day {
  day: string;
  costs: Record<string, number>;
  estimated?: boolean;
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The UTC date `back` days before `from` (default: now), as Cost Explorer writes it. */
export const utcDay = (back = 0, from = new Date()) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - back)).toISOString().slice(0, 10);

/**
 * Days as Cost Explorer's GetCostAndUsage answers them for DAILY cost grouped
 * by service. A service whose cost is a string that is not a number, or in
 * another currency, is how a bad answer is made.
 */
export function answer(days: Day[], extra: { nextPageToken?: string; unit?: string; amount?: (usd: number) => string } = {}) {
  return {
    ResultsByTime: days.map((d) => ({
      TimePeriod: { Start: d.day, End: nextDay(d.day) },
      Total: {},
      Groups: Object.entries(d.costs).map(([service, usd]) => ({
        Keys: [service],
        Metrics: { UnblendedCost: { Amount: extra.amount ? extra.amount(usd) : String(usd), Unit: extra.unit ?? "USD" } },
      })),
      Estimated: Boolean(d.estimated),
    })),
    DimensionValueAttributes: [],
    ...(extra.nextPageToken ? { NextPageToken: extra.nextPageToken } : {}),
  };
}

/** `values` as one service's daily cost, the last of them on `last`, one value per day before it. */
export function series(service: string, values: number[], last: string): Day[] {
  return values.map((usd, i) => ({ day: utcDay(values.length - 1 - i, new Date(`${last}T00:00:00Z`)), costs: { [service]: usd } }));
}

/** Several services' series over the same days, as one list of days. */
export function together(...parts: Day[][]): Day[] {
  const byDay = new Map<string, Day>();
  for (const part of parts) {
    for (const d of part) {
      const have = byDay.get(d.day) ?? { day: d.day, costs: {}, ...(d.estimated ? { estimated: true } : {}) };
      Object.assign(have.costs, d.costs);
      byDay.set(d.day, have);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export type Reply = object | { status: number; errorType: string; body: object };

/**
 * `replies` are what Cost Explorer answers to its first, second and later
 * requests. Every request body is kept in `requests`, and every operation
 * called in `actions`: a test can say how many requests were made, and that
 * nothing else was asked for.
 */
export async function fakeCostExplorer(replies: Reply[], accountId = "123456789012") {
  const requests: any[] = [];
  const actions: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const target = String(req.headers["x-amz-target"] ?? "");
      if (target.endsWith(".GetCostAndUsage")) {
        actions.push("GetCostAndUsage");
        requests.push(JSON.parse(body));
        const reply = replies[Math.min(requests.length - 1, replies.length - 1)] as any;
        const failure = reply && "errorType" in reply;
        res.writeHead(failure ? reply.status : 200, { "content-type": "application/x-amz-json-1.1", ...(failure ? { "x-amzn-errortype": reply.errorType } : {}) });
        return void res.end(JSON.stringify(failure ? reply.body : reply));
      }
      const action = new URLSearchParams(body).get("Action") ?? target;
      actions.push(action);
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(action === "GetCallerIdentity" ? IDENTITY.replaceAll("123456789012", accountId) : '<?xml version="1.0"?><Unexpected/>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    actions,
    env: { AWS_ENDPOINT_URL: `http://127.0.0.1:${port}`, AWS_REGION: "us-east-1", NO_PROXY: "127.0.0.1" },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
