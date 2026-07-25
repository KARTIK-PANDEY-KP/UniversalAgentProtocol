import { isIP } from "node:net";

export type IpDisposition =
  | "PUBLIC"
  | "LOOPBACK"
  | "PRIVATE"
  | "LINK_LOCAL"
  | "CLOUD_METADATA"
  | "RESERVED";

/** Well-known instance metadata endpoints across the major cloud providers. */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidr(address: number, prefix: string, bits: number): boolean {
  const base = ipv4ToInt(prefix);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

export function classifyIpv4(address: string): IpDisposition {
  if (METADATA_ADDRESSES.has(address)) return "CLOUD_METADATA";
  const value = ipv4ToInt(address);
  if (value === null) return "RESERVED";
  if (inCidr(value, "127.0.0.0", 8)) return "LOOPBACK";
  if (inCidr(value, "169.254.0.0", 16)) return "LINK_LOCAL";
  if (
    inCidr(value, "10.0.0.0", 8) ||
    inCidr(value, "172.16.0.0", 12) ||
    inCidr(value, "192.168.0.0", 16) ||
    inCidr(value, "100.64.0.0", 10)
  ) {
    return "PRIVATE";
  }
  if (
    inCidr(value, "0.0.0.0", 8) ||
    inCidr(value, "192.0.0.0", 24) ||
    inCidr(value, "192.0.2.0", 24) ||
    inCidr(value, "192.88.99.0", 24) ||
    inCidr(value, "198.18.0.0", 15) ||
    inCidr(value, "198.51.100.0", 24) ||
    inCidr(value, "203.0.113.0", 24) ||
    inCidr(value, "224.0.0.0", 4) ||
    inCidr(value, "240.0.0.0", 4)
  ) {
    return "RESERVED";
  }
  return "PUBLIC";
}

function expandIpv6(address: string): string[] | null {
  const zoneless = address.split("%")[0] ?? address;
  const [head, tail] = zoneless.split("::");
  const headGroups = head && head.length > 0 ? head.split(":") : [];
  const tailGroups = tail && tail.length > 0 ? tail.split(":") : [];
  const groups: string[] =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...new Array<string>(
            Math.max(0, 8 - headGroups.length - tailGroups.length),
          ).fill("0"),
          ...tailGroups,
        ];
  if (groups.length !== 8) return null;
  return groups.map((group) => group.toLowerCase());
}

export function classifyIpv6(address: string): IpDisposition {
  const normalized = (address.split("%")[0] ?? address).toLowerCase();
  if (METADATA_ADDRESSES.has(normalized)) return "CLOUD_METADATA";

  // IPv4-mapped and NAT64 addresses must be judged by their embedded IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  if (mapped?.[1]) return classifyIpv4(mapped[1]);
  const nat64 = /^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  if (nat64?.[1]) return classifyIpv4(nat64[1]);

  const groups = expandIpv6(normalized);
  if (!groups) return "RESERVED";
  const first = Number.parseInt(groups[0] ?? "0", 16);
  const allZeroExceptLast = groups.slice(0, 7).every((g) => Number.parseInt(g, 16) === 0);
  if (allZeroExceptLast) {
    const last = Number.parseInt(groups[7] ?? "0", 16);
    if (last === 1) return "LOOPBACK";
    if (last === 0) return "RESERVED";
  }
  if ((first & 0xfe00) === 0xfc00) return "PRIVATE";
  if ((first & 0xffc0) === 0xfe80) return "LINK_LOCAL";
  if ((first & 0xff00) === 0xff00) return "RESERVED";

  // IPv4-mapped forms that Node reports in hexadecimal notation.
  if (groups.slice(0, 5).every((g) => Number.parseInt(g, 16) === 0) && groups[5] === "ffff") {
    const high = Number.parseInt(groups[6] ?? "0", 16);
    const low = Number.parseInt(groups[7] ?? "0", 16);
    const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    return classifyIpv4(v4);
  }
  return "PUBLIC";
}

export function classifyAddress(address: string): IpDisposition {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return "RESERVED";
}

/**
 * Returns the bare address when a URL host is an IP literal rather than a
 * name. Node connects straight to a literal without consulting the `lookup`
 * hook, so a literal has to be judged before the request is made.
 */
export function literalAddressOf(hostname: string): string | null {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return isIP(bare) === 0 ? null : bare;
}
