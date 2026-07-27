// SSRF guard — which literal addresses are refused.
//
// `assertUrlAllowed` runs on POST /api/files/from-url and on every redirect hop,
// and `assertPushEndpoint` on the Web Push subscribe endpoint. Both make the
// SERVER issue a request to a client-supplied host, so the block list is the
// only thing between an unauthenticated-ish request and the internal network.
//
// The list covered the well-known RFC 1918 ranges but missed three that are
// routinely internal in exactly the environments this app is deployed into:
//
//   100.64.0.0/10  — RFC 6598 carrier-grade NAT. This is not an exotic range:
//                    it is what Tailscale hands out (100.x is a Tailscale
//                    address), what many Kubernetes CNIs use for pod/service
//                    networks, and what several clouds use for internal
//                    endpoints. A host on it is reachable from the container
//                    and is not on the public internet.
//   0.0.0.0/8      — RFC 1122 "this network". Only 0.0.0.0 itself was blocked,
//                    but the whole /8 is special-use, and on Linux connecting
//                    to 0.x.y.z reaches the LOCAL host — so "0.1.2.3" was a
//                    plain loopback bypass.
//   198.18.0.0/15  — RFC 2544 benchmarking range, non-routable and used for
//                    internal test networks.
//
// 192.0.0.0/24 (IETF protocol assignments) is included for the same reason.
import { describe, it, expect } from 'vitest';
import { isBlockedIp, isBlockedHost } from '../src/utils/ssrf.js';

describe('isBlockedIp — ranges that must stay blocked', () => {
  const blocked = [
    ['loopback', '127.0.0.1'],
    ['loopback, high in the /8', '127.255.255.254'],
    ['unspecified', '0.0.0.0'],
    ['private 10/8', '10.0.0.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['private 172.16/12 low', '172.16.0.1'],
    ['private 172.16/12 high', '172.31.255.254'],
    ['link-local / cloud metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 unique-local fc00', 'fc00::1'],
    ['IPv6 unique-local fd00', 'fd00::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
    ['bracketed IPv6 loopback', '[::1]'],
  ];
  for (const [label, ip] of blocked) {
    it(`blocks ${label} (${ip})`, () => expect(isBlockedIp(ip)).toBe(true));
  }
});

describe('isBlockedIp — the ranges that were missed', () => {
  // RFC 6598 CGNAT: Tailscale's whole address space, and a common k8s/cloud
  // internal range. Reachable from the container, never public.
  it('blocks the bottom of 100.64.0.0/10', () => expect(isBlockedIp('100.64.0.1')).toBe(true));
  it('blocks the top of 100.64.0.0/10', () => expect(isBlockedIp('100.127.255.254')).toBe(true));
  it('blocks a Tailscale-style address', () => expect(isBlockedIp('100.101.102.103')).toBe(true));

  // RFC 1122 0.0.0.0/8 — on Linux, 0.x.y.z reaches the local host.
  it('blocks 0.0.0.0/8, not just 0.0.0.0', () => expect(isBlockedIp('0.1.2.3')).toBe(true));

  // RFC 2544 / IETF special use.
  it('blocks 198.18.0.0/15', () => expect(isBlockedIp('198.18.0.1')).toBe(true));
  it('blocks 192.0.0.0/24', () => expect(isBlockedIp('192.0.0.1')).toBe(true));
});

describe('isBlockedIp — public addresses must stay allowed', () => {
  // The guard must not become so broad that ordinary imports break. 100.63.x
  // and 100.128.x sit just OUTSIDE the CGNAT block and are public.
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '100.63.255.255', // one below 100.64/10
    '100.128.0.0', // one above 100.64/10
    '172.15.0.1', // one below 172.16/12
    '172.32.0.1', // one above 172.16/12
    '198.20.0.1', // outside 198.18/15
    '192.0.1.1', // outside 192.0.0.0/24
    '11.0.0.1',
    '2606:4700:4700::1111',
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe('isBlockedHost', () => {
  it('blocks localhost and its subdomains', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('api.localhost')).toBe(true);
    expect(isBlockedHost('LOCALHOST')).toBe(true);
  });
  it('blocks a literal private address given as a host', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('100.64.0.1')).toBe(true);
  });
  it('allows an ordinary public hostname', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('cdn.example.org')).toBe(false);
  });
});
