/**
 * Site Audit service — tech fingerprint + exposure report for any public URL.
 *
 * Paid tool: site_audit ($PRICE_AUDIT). Read-only, GET-only, SSRF-guarded
 * (fetchPublicUrl validates every hop including redirects).
 */

import { fetchPublicUrl, SsrfBlockedError } from "./ssrf";

export type SiteAuditInput = { url: string };

const UA =
  "Mozilla/5.0 (compatible; CanyonSiteAudit/1.0; +https://canyonai.io) AppleWebKit/537.36 Chrome/124 Safari/537.36";

const SECURITY_HEADERS: { name: string; label: string; good: (v: string) => boolean }[] = [
  { name: "strict-transport-security", label: "HSTS", good: (v) => v.includes("max-age") },
  { name: "content-security-policy", label: "Content-Security-Policy", good: () => true },
  { name: "x-frame-options", label: "X-Frame-Options", good: (v) => /deny|sameorigin/i.test(v) },
  { name: "x-content-type-options", label: "X-Content-Type-Options", good: (v) => v.toLowerCase().includes("nosniff") },
  { name: "referrer-policy", label: "Referrer-Policy", good: (v) => !/unsafe-url/i.test(v) },
  { name: "permissions-policy", label: "Permissions-Policy", good: () => true },
];

const TECH_SIGNATURES: { name: string; where: "html" | "header"; test: RegExp; header?: string }[] = [
  { name: "Next.js", where: "html", test: /__NEXT_DATA__|\/_next\//i },
  { name: "Nuxt", where: "html", test: /__NUXT__|\/_nuxt\//i },
  { name: "React", where: "html", test: /data-reactroot|react(-dom)?[.@-]|_reactListening/i },
  { name: "Vue", where: "html", test: /data-v-[0-9a-f]{8}|vue(\.runtime)?[.@-]/i },
  { name: "Angular", where: "html", test: /ng-version|ng-app/i },
  { name: "Svelte", where: "html", test: /svelte-[0-9a-z]{6}/i },
  { name: "WordPress", where: "html", test: /wp-content|wp-includes|wp-json/i },
  { name: "Shopify", where: "html", test: /cdn\.shopify\.com|shopify\.theme/i },
  { name: "Wix", where: "html", test: /static\.wixstatic\.com|wix-code/i },
  { name: "Squarespace", where: "html", test: /squarespace|static1\.squarespace\.com/i },
  { name: "Webflow", where: "html", test: /w-(modal|nav|form)|webflow/i },
  { name: "Gatsby", where: "html", test: /gatsby-image|___gatsby/i },
  { name: "Tailwind CSS", where: "html", test: /tailwind/i },
  { name: "Bootstrap", where: "html", test: /bootstrap(\.min)?\.(css|js)/i },
  { name: "Google Analytics", where: "html", test: /googletagmanager\.com|google-analytics\.com|gtag\(/i },
  { name: "Meta Pixel", where: "html", test: /connect\.facebook\.net|fbevents\.js/i },
  { name: "Cloudflare", where: "header", test: /cf-ray|__cfduid|cloudflare/i, header: "*" },
  { name: "Vercel", where: "header", test: /vercel/i, header: "x-vercel-id" },
  { name: "Netlify", where: "header", test: /netlify/i, header: "x-nf-request-id" },
  { name: "AWS/CloudFront", where: "header", test: /cloudfront|amazon/i, header: "*" },
  { name: "Stripe", where: "html", test: /js\.stripe\.com/i },
  { name: "Intercom", where: "html", test: /intercom|widget\.intercom\.io/i },
  { name: "HubSpot", where: "html", test: /hs-scripts\.com|hubspot/i },
  { name: "Segment", where: "html", test: /cdn\.segment\.com/i },
];

export type SiteAuditReport = {
  success: true;
  tool: "site_audit";
  url: string;
  finalUrl: string;
  statusCode: number;
  responseTimeMs: number;
  server?: string;
  poweredBy?: string;
  technologies: string[];
  securityHeaders: { header: string; present: boolean; value?: string; ok?: boolean }[];
  https: boolean;
  robotsTxt: { present: boolean; sitemapDeclared: boolean; disallowCount: number };
  htmlStats: {
    title?: string;
    description?: string;
    bytes: number;
    scriptCount: number;
    externalScriptHosts: string[];
    formCount: number;
    iframeCount: number;
  };
  notes: string[];
  chargedUsd?: string;
  paymentTxHash?: string;
};

function pickHeader(headers: Headers, name: string): string | undefined {
  const v = headers.get(name);
  return v ? v.slice(0, 300) : undefined;
}

function headerMentions(headers: Headers, re: RegExp): boolean {
  for (const [k, v] of headers.entries()) {
    if (re.test(k) || re.test(v)) return true;
  }
  return false;
}

export async function runSiteAudit(input: SiteAuditInput): Promise<SiteAuditReport> {
  const started = Date.now();
  const { url: finalUrl, response } = await fetchPublicUrl(input.url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
  });

  const headers = response.headers;
  const html = (await response.text()).slice(0, 400_000); // cap analysis window
  const responseTimeMs = Date.now() - started;

  // --- technologies ---
  const technologies: string[] = [];
  for (const sig of TECH_SIGNATURES) {
    if (sig.where === "header") {
      if (sig.header && sig.header !== "*" && headers.get(sig.header)) {
        technologies.push(sig.name);
      } else if (headerMentions(headers, sig.test)) {
        technologies.push(sig.name);
      }
    } else if (sig.test.test(html)) {
      technologies.push(sig.name);
    }
  }

  // --- security headers ---
  const securityHeaders = SECURITY_HEADERS.map((h) => {
    const value = pickHeader(headers, h.name);
    return {
      header: h.label,
      present: value !== undefined,
      value,
      ok: value !== undefined ? h.good(value) : false,
    };
  });
  if (!finalUrl.protocol.startsWith("https")) {
    securityHeaders.push({ header: "HTTPS", present: false, value: undefined, ok: false });
  }

  // --- robots.txt ---
  let robots: SiteAuditReport["robotsTxt"] = { present: false, sitemapDeclared: false, disallowCount: 0 };
  try {
    const robotsUrl = new URL("/robots.txt", finalUrl).toString();
    const { response: robotsRes } = await fetchPublicUrl(robotsUrl, {
      headers: { "User-Agent": UA },
      redirect: "manual",
    });
    if (robotsRes.ok) {
      const body = (await robotsRes.text()).slice(0, 50_000);
      robots = {
        present: true,
        sitemapDeclared: /sitemap:/i.test(body),
        disallowCount: (body.match(/^\s*disallow:/gim) || []).length,
      };
    }
  } catch {
    // robots fetch failures are non-fatal
  }

  // --- html stats ---
  const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1]?.trim();
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i.exec(
    html,
  )?.[1];
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  const externalScriptHosts = Array.from(
    new Set(
      Array.from(html.matchAll(/<script[^>]+src=["'](https?:\/\/[^/"']+)/gi))
        .map((m) => safeHost(m[1]))
        .filter((h): h is string => !!h),
    ),
  ).slice(0, 20);
  const formCount = (html.match(/<form\b/gi) || []).length;
  const iframeCount = (html.match(/<iframe\b/gi) || []).length;

  // --- notes ---
  const notes: string[] = [];
  if (!finalUrl.protocol.startsWith("https")) notes.push("Served over plain HTTP.");
  for (const h of securityHeaders) {
    if (!h.present) notes.push(`Missing security header: ${h.header}`);
  }
  const setCookie = pickHeader(headers, "set-cookie");
  if (setCookie && !/secure/i.test(setCookie)) notes.push("Set-Cookie without Secure flag detected.");
  const server = pickHeader(headers, "server");
  if (server && /\d+\.\d+/.test(server)) notes.push(`Server banner exposes version: ${server}`);
  if (scriptCount > 40) notes.push(`High script count (${scriptCount}) — large attack surface / slow load.`);

  return {
    success: true,
    tool: "site_audit",
    url: input.url,
    finalUrl: finalUrl.toString(),
    statusCode: response.status,
    responseTimeMs,
    server,
    poweredBy: pickHeader(headers, "x-powered-by"),
    technologies,
    securityHeaders,
    https: finalUrl.protocol === "https:",
    robotsTxt: robots,
    htmlStats: {
      title,
      description,
      bytes: html.length,
      scriptCount,
      externalScriptHosts,
      formCount,
      iframeCount,
    },
    notes,
  };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export { SsrfBlockedError };
