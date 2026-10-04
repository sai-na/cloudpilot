/** A webhook on 127.0.0.1 for tests to send to. Nothing here reaches beyond this machine. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The secret part of every test webhook's path: the one thing that must never be printed or saved. */
export const SECRET = "T0123ABC/B0456DEF/xYzSecretToken123";

export interface Hook {
  url: string;
  requests: Array<{ url: string; type: string | undefined; body: string }>;
  close(): Promise<void>;
}

/** A webhook that answers with `respond`, and keeps what it was sent. */
export async function hook(respond: (req: IncomingMessage, n: number) => { status: number; headers?: Record<string, string>; body?: string }): Promise<Hook> {
  const requests: Hook["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", type: req.headers["content-type"], body });
      const answer = respond(req, requests.length);
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/${SECRET}`,
    requests,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

