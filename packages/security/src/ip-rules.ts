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

/** The dotted IPv4 held in the last 32 bits of an expanded address. */
function embeddedIpv4(groups: readonly number[], at = 6): string {
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function zeroThrough(groups: readonly number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

export function classifyIpv6(address: string): IpDisposition {
  const normalized = (address.split("%")[0] ?? address).toLowerCase();
  if (METADATA_ADDRESSES.has(normalized)) return "CLOUD_METADATA";

  // A trailing dotted quad is legal in any embedding form, so fold it into the
  // hexadecimal groups first and reason about one representation afterwards.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(normalized);
  const foldable = dotted?.[2] ? ipv4ToInt(dotted[2]) : null;
  const canonical =
    dotted?.[1] && foldable !== null
      ? `${dotted[1]}${(foldable >>> 16).toString(16)}:${(foldable & 0xffff).toString(16)}`
      : normalized;

  const expanded = expandIpv6(canonical);
  if (!expanded) return "RESERVED";
  const groups = expanded.map((group) => Number.parseInt(group, 16));
  if (groups.some((group) => !Number.isFinite(group) || group < 0 || group > 0xffff)) {
    return "RESERVED";
  }
  const first = groups[0] ?? 0;

  // Every form that carries an IPv4 inside it is judged by that IPv4, or the
  // address family becomes a way to spell a blocked destination.
  if (zeroThrough(groups, 5) && groups[5] === 0xffff) {
    return classifyIpv4(embeddedIpv4(groups)); // ::ffff:0:0/96, IPv4-mapped
  }
  if (first === 0x0064 && groups[1] === 0xff9b && zeroThrough(groups.slice(2), 4)) {
    return classifyIpv4(embeddedIpv4(groups)); // 64:ff9b::/96, NAT64
  }
  if (first === 0x2002) {
    return classifyIpv4(embeddedIpv4(groups, 1)); // 2002::/16, 6to4
  }
  if (zeroThrough(groups, 6)) {
    const last = groups[7] ?? 0;
    if (groups[6] === 0 && last === 1) return "LOOPBACK";
    if (groups[6] === 0 && last === 0) return "RESERVED"; // unspecified
    return classifyIpv4(embeddedIpv4(groups)); // ::a.b.c.d, deprecated
  }

  if ((first & 0xfe00) === 0xfc00) return "PRIVATE"; // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return "LINK_LOCAL"; // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return "PRIVATE"; // fec0::/10, site-local
  if ((first & 0xff00) === 0xff00) return "RESERVED"; // ff00::/8, multicast

  // Ranges that are not routable destinations, and Teredo, which is a tunnel
  // to an arbitrary IPv4 the classifier cannot see.
  if (first === 0x0100 && zeroThrough(groups.slice(1), 3)) return "RESERVED"; // 100::/64
  if (first === 0x2001 && groups[1] === 0x0000) return "RESERVED"; // 2001::/32, Teredo
  if (first === 0x2001 && ((groups[1] ?? 0) & 0xfff0) === 0x0010) return "RESERVED"; // ORCHID
  if (first === 0x2001 && ((groups[1] ?? 0) & 0xfff0) === 0x0020) return "RESERVED"; // ORCHIDv2
  if (first === 0x2001 && groups[1] === 0x0db8) return "RESERVED"; // 2001:db8::/32, docs
  if ((first & 0xfff0) === 0x3ff0) return "RESERVED"; // 3fff::/20, docs
  if (first === 0x5f00) return "RESERVED"; // 5f00::/16, segment routing

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
