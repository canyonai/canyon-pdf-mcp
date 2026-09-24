/**
 * SSRF guards for outbound URL fetches (scrape / extract).
 * Blocks loopback, link-local, private RFC1918, and cloud metadata IPs.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
]);

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** True if IPv4 dotted-quad is private / loopback / link-local / CGNAT / metadata-ish */
function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map((x) => Number(x));
  if (octets.some((n) => n > 255)) return true;
  const [a, b] = octets as [number, number, number, number];

  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / AWS metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1") return true;
  if (h === "::") return true;
  // Unique local fc00::/7, link-local fe80::/10
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true;
  }
  return false;
}

/**
 * Validate that a URL is safe to fetch from the Worker.
 * Throws SsrfBlockedError on private / loopback / non-http(s) targets.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError("Only http(s) URLs are allowed");
  }

  const host = url.hostname.toLowerCase();
  if (!host) throw new SsrfBlockedError("URL missing hostname");

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`Blocked hostname: ${host}`);
  }

  // IPv6 in brackets already stripped by URL.hostname
  if (host.includes(":")) {
    if (isBlockedIpv6(host)) {
      throw new SsrfBlockedError(`Blocked IPv6 address: ${host}`);
    }
  } else if (isBlockedIpv4(host)) {
    throw new SsrfBlockedError(`Blocked private/loopback IP: ${host}`);
  }

  // Obvious metadata / internal TLDs
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new SsrfBlockedError(`Blocked internal hostname: ${host}`);
  }

  return url;
}

/**
 * Fetch with SSRF check applied before the request AND on every redirect hop.
 * Redirects are followed manually so a public URL cannot 302 into a private target.
 */
export async function fetchPublicUrl(
  raw: string,
  init?: RequestInit,
): Promise<{ url: URL; response: Response }> {
  let url = assertPublicHttpUrl(raw);
  let response: Response;
  for (let hop = 0; hop < 4; hop++) {
    response = await fetch(url.toString(), { ...init, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) return { url, response };
      const next = new URL(loc, url);
      next.hash = ""; // strip fragments
      if (response.body) await response.body.cancel().catch(() => {});
      url = assertPublicHttpUrl(next.toString());
      continue;
    }
    return { url, response };
  }
  throw new SsrfBlockedError("Too many redirects (limit 4)");
}
