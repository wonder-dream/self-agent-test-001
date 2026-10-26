import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction, Socket } from "node:net";
import { Guard } from "./guard.ts";

export async function startGuardProxy(guard: Guard): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void forward(req, res, guard).catch((error: unknown) => {
      if (res.headersSent) return;
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "代理失败");
    });
  });
  server.on("connect", (req, socket, head) => {
    void tunnel(req.url ?? "", socket as Socket, head, guard);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("代理没有监听端口");
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function forward(req: http.IncomingMessage, res: http.ServerResponse, guard: Guard): Promise<void> {
  const decision = await guard.checkRequest(req.url ?? "", req.method ?? "GET");
  if (!decision.allow) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(decision.reason);
    return;
  }
  const url = new URL(req.url ?? "");
  const lib = url.protocol === "https:" ? https : http;
  const ip = decision.addresses[0] ?? "";
  const upstream = lib.request({
    hostname: url.hostname,
    servername: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: req.method,
    headers: forwardHeaders(req.headers, url.host),
    lookup: pinnedLookup(ip),
  }, (incoming) => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(res);
  });
  upstream.on("error", (error) => {
    if (res.headersSent) return;
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.message);
  });
  req.pipe(upstream);
}

async function tunnel(target: string, client: Socket, head: Buffer, guard: Guard): Promise<void> {
  const [host, portText] = target.split(":");
  const decision = await guard.checkDestination(`https://${host ?? ""}:${portText || "443"}/`);
  if (!decision.allow) {
    client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${decision.reason}`);
    return;
  }
  const ip = decision.addresses[0] ?? "";
  const socket = net.connect({ host: ip, port: Number(portText || 443), family: net.isIP(ip) === 6 ? 6 : 4 });
  const fail = (error: Error) => {
    if (!client.destroyed) client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${error.message}`);
    socket.destroy();
  };
  socket.once("error", fail);
  socket.once("connect", () => {
    socket.off("error", fail);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.write(head);
    socket.pipe(client);
    client.pipe(socket);
    socket.on("error", () => client.destroy());
    client.on("error", () => socket.destroy());
  });
}

function pinnedLookup(ip: string): LookupFunction {
  const family = net.isIP(ip) === 6 ? 6 : 4;
  return ((_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  }) as LookupFunction;
}

function forwardHeaders(headers: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { host };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (["host", "proxy-connection", "proxy-authorization", "connection"].includes(key)) continue;
    next[key] = value;
  }
  return next;
}
