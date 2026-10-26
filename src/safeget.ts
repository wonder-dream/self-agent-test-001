import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { Guard } from "./guard.ts";

export type Fetched = { finalUrl: string; contentType: string; body: Buffer };

export async function safeGet(rawUrl: string, guard: Guard, limit: number): Promise<
  { ok: true; fetched: Fetched } | { ok: false; error: string }
> {
  let current = rawUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const decision = await guard.checkRequest(current, "GET");
    if (!decision.allow) return { ok: false, error: decision.reason };
    let response: Awaited<ReturnType<typeof requestOnce>>;
    try {
      response = await requestOnce(new URL(current), decision.addresses[0] ?? "", limit);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "读取失败" };
    }
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current).toString();
      continue;
    }
    if (response.status !== 200) return { ok: false, error: `HTTP ${response.status}` };
    return {
      ok: true,
      fetched: { finalUrl: current, contentType: response.contentType, body: response.body },
    };
  }
  return { ok: false, error: "重定向次数过多" };
}

function requestOnce(url: URL, ip: string, limit: number): Promise<{
  status: number;
  location: string;
  contentType: string;
  body: Buffer;
}> {
  const lib = url.protocol === "https:" ? https : http;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      servername: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        host: url.host,
        "user-agent": "WanderAgent/0.1",
        accept: "text/html,application/pdf,image/*;q=0.8,*/*;q=0.1",
      },
      lookup: pinnedLookup(ip),
      timeout: 20_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          req.destroy();
          reject(new Error("文件超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          location: String(res.headers.location ?? ""),
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("读取超时")));
    req.on("error", reject);
    req.end();
  });
}

function pinnedLookup(ip: string): LookupFunction {
  const family = net.isIP(ip) === 6 ? 6 : 4;
  return ((_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: ip, family }]);
      return;
    }
    callback(null, ip, family);
  }) as LookupFunction;
}
