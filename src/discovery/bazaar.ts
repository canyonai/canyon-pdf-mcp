/**
 * Agent discovery metadata for Canyon PDF MCP.
 *
 * Cloudflare Workers cannot run x402's on-route Bazaar extension validation:
 * `@x402/hono` calls Ajv `compile()`, which uses `new Function()` and Workers
 * throw "Code generation from strings disallowed for this context".
 *
 * Discovery is therefore served from first-party endpoints instead:
 *   GET /discovery
 *   GET /llms.txt
 *   GET /.well-known/mcp.json
 */

import type { Env } from "../types/env";

/** Public MCP / REST origin used in absolute resource URLs */
export function publicOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
}

/**
 * Primary agent-facing tool description (tools/list + Bazaar MCP card).
 * Lead with WHEN to call — models match user intent against this text.
 */
export function generatePdfToolDescription(env: Env): string {
  return (
    "Generates a high-resolution, multi-page vector PDF document from structured JSON or raw Markdown. " +
    "Use this tool when asked to create financial reports, invoices, executive summaries, formatted documents, or downloadable PDF files. " +
    "Also accepts sourceType=url for a public page, or sourceType=markdown for raw Markdown. " +
    "Returns a styled PDF hosted on R2 with a 24-hour download URL. " +
    `Pricing in USDC on Base via x402 (no API key): mode=fast → $${env.PRICE_STANDARD} (pdf-lib); ` +
    `mode=heavy → $${env.PRICE_HEAVY} (@pdfme template engine, auto-fallback to pdf-lib). ` +
    "Prefer fast for short summaries; heavy for denser multi-section reports. " +
    "On first failure after payment you get a free retryToken; a second failure returns a signed refund challenge."
  );
}

/** Shorter seller blurb for Bazaar service cards / HTTP route description */
export function generatePdfServiceDescription(env: Env): string {
  return (
    "Multi-tool PDF suite for AI agents: generate reports from JSON/Markdown, scrape URLs to PDF, extract text from PDFs. " +
    `Prices USDC on Base (x402): generate $${env.PRICE_STANDARD}/$${env.PRICE_HEAVY}, scrape $${env.PRICE_SCRAPE || "0.50"}, extract $${env.PRICE_EXTRACT || "0.10"}. No API key.`
  );
}

const EXAMPLE_INPUT = {
  mode: "fast",
  sourceType: "json",
  jsonData: {
    title: "Q3 Pipeline Report",
    metadata: { author: "Canyon Agent", period: "2026-Q3" },
    contentSections: [
      {
        heading: "Summary",
        body: "Pipeline grew 18% WoW across enterprise accounts.",
        bullets: ["Win rate 34%", "Avg deal size $42k"],
      },
    ],
    metricsTable: [
      { label: "MRR", value: "128000", unit: "USD" },
      { label: "Churn", value: "2.1", unit: "%" },
    ],
  },
} as const;

/** Shared seller metadata for x402 resource cards (≤32 chars each for name/tags) */
export function bazaarServiceMeta(env: Env) {
  return {
    serviceName: "Canyon PDF Engine",
    tags: ["pdf", "reports", "invoice", "summary", "mcp"],
    // Optional icon — use a stable public asset when available
    // iconUrl: `${publicOrigin(env)}/icon.png`,
    description: generatePdfServiceDescription(env),
  };
}

export function mcpResourceUrl(env: Env): string {
  return `${publicOrigin(env)}/mcp`;
}

export function restResourceUrl(env: Env): string {
  return `${publicOrigin(env)}/api/generate`;
}

export function auditResourceUrl(env: Env): string {
  return `${publicOrigin(env)}/api/audit`;
}

/** Human + agent facing discovery help payload for GET /discovery */
export function discoveryHelpPayload(env: Env) {
  const origin = publicOrigin(env);
  const facilitator = env.FACILITATOR_URL || "https://facilitator.payai.network";
  return {
    service: "canyon-pdf-mcp",
    serviceName: "Canyon PDF Engine",
    network: "eip155:8453",
    asset: env.BASE_USDC_CONTRACT,
    payTo: env.SETTLEMENT_WALLET,
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/generate`,
      health: `${origin}/health`,
      llmsTxt: `${origin}/llms.txt`,
      wellKnown: `${origin}/.well-known/mcp.json`,
    },
    whenToUse:
      "executive summary, PDF export, financial report, invoice, scrape webpage to PDF, or extract text from an existing PDF",
    prices: {
      generate_pdf_report: {
        fast: `$${env.PRICE_STANDARD}`,
        heavy: `$${env.PRICE_HEAVY}`,
      },
      scrape_url_to_pdf: `$${env.PRICE_SCRAPE || "0.50"}`,
      extract_pdf_text: `$${env.PRICE_EXTRACT || "0.10"}`,
      site_audit: `$${env.PRICE_AUDIT || "0.50"}`,
      price_monitor: `$${env.PRICE_MONITOR || "1.00"} (30-day watch)`,
    },
    tools: [
      {
        name: "generate_pdf_report",
        paid: true,
        price: `$${env.PRICE_STANDARD} / $${env.PRICE_HEAVY}`,
        transport: "streamable-http",
        description: generatePdfToolDescription(env),
      },
      {
        name: "scrape_url_to_pdf",
        paid: true,
        price: `$${env.PRICE_SCRAPE || "0.50"}`,
        transport: "streamable-http",
        description:
          "Scrapes any public web page URL, strips clutter, and renders its contents directly into a clean vector PDF.",
      },
      {
        name: "extract_pdf_text",
        paid: true,
        price: `$${env.PRICE_EXTRACT || "0.10"}`,
        transport: "streamable-http",
        description:
          "Parses a PDF document from a public URL and extracts structured raw text, tables, and document metadata.",
      },
      {
        name: "site_audit",
        paid: true,
        price: `$${env.PRICE_AUDIT || "0.50"}`,
        transport: "streamable-http + REST /api/audit",
        description:
          "Technology-fingerprint and exposure audit for any public URL: tech stack, security headers, TLS posture, robots.txt, response time, script surface, exposure notes.",
      },
      {
        name: "price_monitor",
        paid: true,
        price: `$${env.PRICE_MONITOR || "1.00"}`,
        transport: "REST /api/monitor",
        description:
          "Watch a public product or API page for 30 days: polls every 6 hours and POSTs an HMAC-signed webhook when the price changes. Manage via returned token.",
      },
      {
        name: "pdf_pricing",
        paid: false,
        description: "Return current USDC prices and settlement wallet (free).",
      },
    ],
    discovery: {
      facilitator,
      note:
        "On-route x402 Bazaar extensions are disabled on Cloudflare Workers (Ajv new Function is blocked). Use this /discovery document, /llms.txt, and /.well-known/mcp.json for agent indexing.",
      llmsTxt: `${origin}/llms.txt`,
      wellKnown: `${origin}/.well-known/mcp.json`,
    },
    agentConnect: {
      mcpUrl: `${origin}/mcp`,
      example: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "generate_pdf_report",
          arguments: EXAMPLE_INPUT,
        },
      },
    },
  };
}
