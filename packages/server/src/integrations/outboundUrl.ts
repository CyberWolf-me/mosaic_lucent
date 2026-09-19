import { isIP } from "node:net";

/**
 * SSRF-safe outbound URL validation (Stage D8, ADR 0034, the review's #7).
 *
 * A provider's connection config can define where the SERVER sends
 * requests (Jira's `site` is the per-org base URL; a `baseUrl` override
 * exists on every adapter for testing/Enterprise) — that is a
 * user-configured outbound HTTP destination, and an open one is the
 * classic SSRF boundary. The boundary is authoritative at FACTORY time
 * (the connect-time 400, the teamId precedent): https only, no userinfo,
 * no localhost, no private/loopback/link-local IP literals. The policy
 * deliberately supports self-hosted Jira on real public hosts while
 * refusing the server's own internal network as a target.
 *
 * DNS-level evasion (a public hostname resolving to a private IP) is
 * named in the ADR as out of scope for the single-deployment env-ref
 * era: the configuration is owner-entered, not anonymous input, and the
 * audit trail records who configured what.
 */

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback, 10/8, 0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  return false;
}

/** The private/link-local/loopback ranges refused as hostname literals. */
function isPrivateAddress(hostname: string): boolean {
  // Normalize brackets off IPv6 literals.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const kind = isIP(bare);
  if (kind === 6) {
    const lower = bare.toLowerCase();
    if (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") || // fc00::/7 unique local
      lower.startsWith("fe") // fe80::/10 link local (heuristic prefix)
    ) {
      return true;
    }
    // Unwrap IPv4-mapped IPv6 literals (e.g. ::ffff:127.0.0.1 or WHATWG-normalized ::ffff:7f00:1)
    if (lower.startsWith("::ffff:")) {
      const rest = lower.slice("::ffff:".length);
      if (rest.includes(".")) {
        const parts = rest.split(".").map((p) => Number(p));
        if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
          return isPrivateIpv4(parts[0]!, parts[1]!);
        }
      } else if (rest.includes(":")) {
        const hexParts = rest.split(":");
        if (hexParts.length === 2) {
          const h1 = parseInt(hexParts[0]!, 16);
          const h2 = parseInt(hexParts[1]!, 16);
          if (!Number.isNaN(h1) && !Number.isNaN(h2)) {
            const a = (h1 >> 8) & 0xff;
            const b = h1 & 0xff;
            return isPrivateIpv4(a, b);
          }
        }
      }
    }
    return false;
  }
  if (kind === 4) {
    const parts = bare.split(".").map((p) => Number(p));
    const [a, b] = parts as [number, number, number, number];
    return isPrivateIpv4(a, b);
  }
  return false;
}

export function isSafeOutboundUrl(
  candidate: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "only https:// outbound targets are allowed" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials in the URL are not allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "") {
    return { ok: false, reason: "localhost is not an allowed outbound target" };
  }
  if (isPrivateAddress(host)) {
    return {
      ok: false,
      reason: "private/loopback/link-local addresses are not allowed outbound targets",
    };
  }
  return { ok: true, url };
}

/** The throwing form the factories use (the honest connect-time error). */
export function assertSafeOutboundUrl(candidate: string, what: string): URL {
  const checked = isSafeOutboundUrl(candidate);
  if (!checked.ok) {
    throw new Error(`${what}: ${checked.reason} (got "${candidate}")`);
  }
  return checked.url;
}
