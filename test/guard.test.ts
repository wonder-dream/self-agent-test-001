import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { Guard, isBlockedAddress } from "../src/guard.ts";
import { startGuardProxy } from "../src/proxy.ts";

const guard = new Guard(async (host) => {
  if (host === "example.com") return ["93.184.216.34"];
  if (host === "evil.example") return ["10.1.2.3"];
  if (host === "mixed.example") return ["93.184.216.34", "192.168.0.2"];
  if (host === "metadata.example") return ["169.254.169.254"];
  throw new Error("nxdomain");
});

test("blocks private, metadata, and non-read requests", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "http://metadata.google.internal/",
    "http://router.local/",
  ]) {
    const decision = await guard.checkRequest(url, "GET");
    assert.equal(decision.allow, false, url);
  }
  assert.equal((await guard.checkRequest("http://example.com/a", "POST")).allow, false);
  assert.equal((await guard.checkRequest("https://example.com/a", "GET")).allow, true);
  assert.equal((await guard.checkRequest("http://evil.example/", "GET")).allow, false);
  assert.equal((await guard.checkRequest("http://mixed.example/", "GET")).allow, false);
  assert.equal((await guard.checkRequest("http://metadata.example/", "GET")).allow, false);
  assert.equal((await guard.checkRequest("http://missing.example/", "GET")).allow, false);
  assert.equal(isBlockedAddress("::ffff:7f00:1"), true);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
});

test("the local proxy refuses a tunnel to loopback", async () => {
  const proxy = await startGuardProxy(guard);
  const socket = net.connect(proxy.port, "127.0.0.1");
  const response = await new Promise<string>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.write("CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n");
  });
  socket.destroy();
  await proxy.close();
  assert.match(response, /^HTTP\/1\.1 403/);
});
