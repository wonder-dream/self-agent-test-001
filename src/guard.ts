import dns from "node:dns";
import net from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

export type Decision =
  | { allow: true; addresses: string[] }
  | { allow: false; reason: string };

const blocks = new net.BlockList();
blocks.addSubnet("0.0.0.0", 8, "ipv4");
blocks.addSubnet("10.0.0.0", 8, "ipv4");
blocks.addSubnet("100.64.0.0", 10, "ipv4");
blocks.addSubnet("127.0.0.0", 8, "ipv4");
blocks.addSubnet("169.254.0.0", 16, "ipv4");
blocks.addSubnet("172.16.0.0", 12, "ipv4");
blocks.addSubnet("192.0.0.0", 24, "ipv4");
blocks.addSubnet("192.168.0.0", 16, "ipv4");
blocks.addSubnet("198.18.0.0", 15, "ipv4");
blocks.addSubnet("224.0.0.0", 4, "ipv4");
blocks.addSubnet("240.0.0.0", 4, "ipv4");
blocks.addAddress("::", "ipv6");
blocks.addAddress("::1", "ipv6");
blocks.addSubnet("fc00::", 7, "ipv6");
blocks.addSubnet("fe80::", 10, "ipv6");
blocks.addSubnet("ff00::", 8, "ipv6");

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa", ".lan", ".localdomain"];

export function isBlockedAddress(ip: string): boolean {
  const mapped = mappedV4(ip);
  if (mapped) return isBlockedAddress(mapped);
  const kind = net.isIP(ip);
  if (kind === 0) return true;
  return blocks.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

export async function defaultResolve(host: string): Promise<string[]> {
  const name = host.endsWith(".") ? host : `${host}.`;
  const records = await dns.promises.lookup(name, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export class Guard {
  private resolve: Resolver;

  constructor(resolve: Resolver = defaultResolve) {
    this.resolve = resolve;
  }

  async checkRequest(rawUrl: string, method: string): Promise<Decision> {
    const verb = method.toUpperCase();
    if (verb !== "GET" && verb !== "HEAD") {
      return { allow: false, reason: "只允许读取，不能提交" };
    }
    return this.checkDestination(rawUrl);
  }

  async checkDestination(rawUrl: string): Promise<Decision> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { allow: false, reason: "网址无法解析" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { allow: false, reason: "只访问 http 和 https" };
    }
    if (url.username || url.password) {
      return { allow: false, reason: "网址里不能带账号" };
    }
    const host = bareHost(url.hostname);
    if (!host) return { allow: false, reason: "缺少主机名" };
    if (net.isIP(host) !== 0) {
      if (isBlockedAddress(host)) return { allow: false, reason: "这个地址不在公开互联网上" };
      return { allow: true, addresses: [host] };
    }
    const name = host.toLowerCase().replace(/\.$/, "");
    if (!name.includes(".") || name === "localhost") {
      return { allow: false, reason: "不访问内部主机名" };
    }
    if (BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      return { allow: false, reason: "不访问内部域名" };
    }
    let addresses: string[];
    try {
      addresses = await this.resolve(name);
    } catch {
      return { allow: false, reason: "域名没有解析到公开地址" };
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      return { allow: false, reason: "域名指向了非公开地址" };
    }
    return { allow: true, addresses };
  }
}

function bareHost(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

function mappedV4(ip: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted?.[1] && net.isIP(dotted[1]) === 4) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  const value = (high << 16) + low;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}
