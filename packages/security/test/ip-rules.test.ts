import { describe, expect, it } from "vitest";

import { classifyAddress } from "@umg/security";

describe("classifying IPv4", () => {
  it.each([
    ["8.8.8.8", "PUBLIC"],
    ["127.0.0.1", "LOOPBACK"],
    ["127.255.255.254", "LOOPBACK"],
    ["10.0.0.1", "PRIVATE"],
    ["172.16.0.1", "PRIVATE"],
    ["172.32.0.1", "PUBLIC"],
    ["192.168.1.1", "PRIVATE"],
    ["100.64.0.1", "PRIVATE"],
    ["169.254.1.1", "LINK_LOCAL"],
    ["169.254.169.254", "CLOUD_METADATA"],
    ["0.0.0.0", "RESERVED"],
    ["224.0.0.1", "RESERVED"],
    ["255.255.255.255", "RESERVED"],
  ])("puts %s in %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("classifying IPv6", () => {
  it.each([
    ["2606:4700:4700::1111", "PUBLIC"],
    ["::1", "LOOPBACK"],
    ["::", "RESERVED"],
    ["fc00::1", "PRIVATE"],
    ["fd12:3456::1", "PRIVATE"],
    ["fe80::1", "LINK_LOCAL"],
    ["ff02::1", "RESERVED"],
    ["fd00:ec2::254", "CLOUD_METADATA"],
  ])("puts %s in %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  // Each of these is a way to spell a blocked destination in the other address
  // family. Treating them as ordinary public addresses is an SSRF bypass.
  it.each([
    ["::ffff:169.254.169.254", "CLOUD_METADATA"],
    ["::ffff:a9fe:a9fe", "CLOUD_METADATA"],
    ["::ffff:127.0.0.1", "LOOPBACK"],
    ["::ffff:10.0.0.1", "PRIVATE"],
    ["64:ff9b::169.254.169.254", "CLOUD_METADATA"],
    ["64:ff9b::a9fe:a9fe", "CLOUD_METADATA"],
    ["64:ff9b::10.0.0.1", "PRIVATE"],
    ["2002:a9fe:a9fe::", "CLOUD_METADATA"],
    ["2002:a00:1::", "PRIVATE"],
    ["2002:7f00:1::", "LOOPBACK"],
    ["::10.0.0.1", "PRIVATE"],
    ["::127.0.0.1", "LOOPBACK"],
  ])("reads the IPv4 inside %s and calls it %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    ["fec0::1", "PRIVATE"],
    ["100::1", "RESERVED"],
    ["2001::1", "RESERVED"],
    ["2001:db8::1", "RESERVED"],
    ["2001:10::1", "RESERVED"],
    ["2001:20::1", "RESERVED"],
    ["3fff::1", "RESERVED"],
    ["5f00::1", "RESERVED"],
  ])("refuses %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("ignores a zone identifier", () => {
    expect(classifyAddress("fe80::1%eth0")).toBe("LINK_LOCAL");
  });

  it("treats anything it cannot parse as reserved", () => {
    expect(classifyAddress("not-an-address")).toBe("RESERVED");
    expect(classifyAddress("")).toBe("RESERVED");
  });
});
