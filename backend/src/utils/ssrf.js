// SSRF guard shared by upload-from-URL and Web Push subscribe. Blocks obvious
// loopback / link-local / private-literal hosts, non-http(s) schemes, and
// hostnames that *resolve* to an internal address (a public domain pointing at
// cloud metadata / localhost). Originally local to files.routes.js (group B).
import dns from 'node:dns/promises';
import { badRequest } from './errors.js';

export function isBlockedIp(ip) {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (h === '::1' || h === '::') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local / cloud metadata
  // RFC 1122 "this network" — the WHOLE /8, not just 0.0.0.0. On Linux a
  // connection to 0.x.y.z reaches the local host, so matching only the exact
  // 0.0.0.0 left "0.1.2.3" as a plain loopback bypass.
  if (/^0\./.test(h)) return true;
  // RFC 6598 carrier-grade NAT (100.64.0.0/10 → 100.64.x–100.127.x). Not an
  // exotic range in this app's deployment shape: it is Tailscale's entire
  // address space, a common Kubernetes pod/service network, and used by several
  // clouds for internal endpoints. Reachable from the container, never public.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  // RFC 6890 IETF protocol assignments (192.0.0.0/24) and RFC 2544 benchmarking
  // (198.18.0.0/15) — both non-routable and used for internal test networks.
  if (/^192\.0\.0\./.test(h)) return true;
  if (/^198\.1[89]\./.test(h)) return true;
  if (/^fe80:/i.test(h) || /^fc00:/i.test(h) || /^fd/i.test(h)) return true;
  return false;
}

export function isBlockedHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  return isBlockedIp(h);
}

// Resolve the hostname and block if ANY address is private/link-local.
export async function resolvesToBlockedIp(hostname) {
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.some((a) => isBlockedIp(a.address));
  } catch {
    return true; // unresolvable → treat as blocked
  }
}

// Validate a single URL hop: http(s) only, host not literally blocked, and not
// resolving to a private/link-local/metadata address. Throws a 400 on failure.
export async function assertUrlAllowed(u) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw badRequest('Only http(s) URLs are allowed');
  if (isBlockedHost(parsed.hostname)) throw badRequest('That host is not allowed');
  if (await resolvesToBlockedIp(parsed.hostname))
    throw badRequest('That host resolves to a blocked address');
  return parsed;
}

// Web Push endpoints are always https push-service URLs; the server POSTs to
// them via web-push, so a client-supplied endpoint is an SSRF vector unless we
// restrict it to a public https host (no localhost / private / metadata IPs).
export async function assertPushEndpoint(u) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw badRequest('Invalid push endpoint');
  }
  if (parsed.protocol !== 'https:') throw badRequest('Push endpoint must be https');
  if (isBlockedHost(parsed.hostname)) throw badRequest('Push endpoint host is not allowed');
  if (await resolvesToBlockedIp(parsed.hostname))
    throw badRequest('Push endpoint resolves to a blocked address');
  return parsed;
}
