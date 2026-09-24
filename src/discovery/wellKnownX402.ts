/**
 * Well-known x402 discovery documents.
 *
 * Serves BOTH variants - x402 explorers and registerFromOrigin implementations
 * check /.well-known/x402 first, then /.well-known/x402.json. Serving only one
 * variant breaks origin-based registration (archonics indexing recipe, gotcha #2).
 *
 * Spec: x402 v2 - CAIP-2 network ids, real prices, EIP-3009 USDC on Base.
 * Constraints (CDP silent-reject): description <= 450 chars, <= 8 tags.
 */

import type { Env } from "../types/env";

export function publicOrigin(env: Env): string {
  return (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
}

/** The full origin-level x402 manifest (shared shape for both well-known paths). */
export function buildX402WellKnown(env: Env) {
  const origin = (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  return {
    x402Version: 2,
    version: 2,
    resource: origin,
    // x402scan simple-form compatibility (DISCOVERY.md spec B): version 1 + full-URL resources
    resources: [`${origin}/mcp`, `${origin}/api/generate`, `${origin}/api/audit`],
    instructions:
      "POST /mcp = MCP streamable-HTTP suite (tools: generate_pdf_report, scrape_url_to_pdf, extract_pdf_text, site_audit; pdf_pricing free). POST /api/generate = REST PDF generation. POST /api/audit = site tech/exposure audit. All return 402 with PAYMENT-REQUIRED header (x402 v2) and JSON body challenge.",
    description:
      "Paid PDF suite for AI agents: generate reports from JSON/Markdown/URL, scrape pages to PDF, extract PDF text. USDC on Base via x402. No API key.",
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/generate`,
      health: `${origin}/health`,
      discovery: `${origin}/discovery`,
      llmsTxt: `${origin}/llms.txt`,
      openapi: `${origin}/openapi.json`,
      agentCard: `${origin}/.well-known/agent-card.json`,
    },
    resourcesDetailed: [
      {
        url: `${origin}/mcp`,
        method: "POST",
        description:
          "MCP streamable-HTTP suite: generate_pdf_report ($0.25 fast / $1.50 heavy), scrape_url_to_pdf ($0.50), extract_pdf_text ($0.10). Free: initialize, tools/list, pdf_pricing.",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            discoverable: true,
            bodyType: "json",
            schema: {
              type: "object",
              properties: {
                name: { type: "string", description: "MCP tool name" },
                arguments: { type: "object", description: "Tool arguments (see /discovery for schemas)" },
              },
              required: ["name"],
            },
          },
          output: {
            type: "json",
            schema: {
              type: "object",
              properties: {
                content: { type: "array", description: "MCP content blocks" },
                isError: { type: "boolean" },
              },
            },
          },
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            payTo: env.SETTLEMENT_WALLET,
            asset: env.BASE_USDC_CONTRACT,
            prices: {
              generate_pdf_report_fast: env.PRICE_STANDARD || "0.25",
              generate_pdf_report_heavy: env.PRICE_HEAVY || "1.50",
              scrape_url_to_pdf: env.PRICE_SCRAPE || "0.50",
              extract_pdf_text: env.PRICE_EXTRACT || "0.10",
              site_audit: env.PRICE_AUDIT || "0.50",
            },
            maxTimeoutSeconds: 300,
          },
        ],
        free: {
          methods: ["initialize", "tools/list", "ping", "notifications/initialized"],
          tools: ["pdf_pricing"],
        },
      },
      {
        url: `${origin}/api/generate`,
        method: "POST",
        description:
          "REST twin of generate_pdf_report: build a styled vector PDF from JSON/Markdown and get a 24h download URL. $0.25 fast / $1.50 heavy. USDC on Base via x402.",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            discoverable: true,
            bodyType: "json",
            schema: {
              type: "object",
              required: ["sourceType"],
              properties: {
                sourceType: { type: "string", enum: ["json", "url", "markdown"] },
                mode: { type: "string", enum: ["fast", "heavy"] },
                jsonData: { type: "object" },
                markdown: { type: "string" },
                url: { type: "string", format: "uri" },
                title: { type: "string" },
                retryToken: { type: "string", description: "HMAC free-retry token from a prior Stage-1 failure" },
              },
            },
          },
          output: {
            type: "json",
            example: {
              success: true,
              url: `${origin}/download/<signed-token>`,
              chargedUsd: "0.25",
              paymentTxHash: "0x<tx-hash>",
            },
          },
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            payTo: env.SETTLEMENT_WALLET,
            asset: env.BASE_USDC_CONTRACT,
            prices: { fast: env.PRICE_STANDARD || "0.25", heavy: env.PRICE_HEAVY || "1.50" },
          },
        ],
      },
      {
        url: `${origin}/api/audit`,
        method: "POST",
        description:
          "REST site audit: tech fingerprint, security headers, TLS posture, robots.txt, response time, script/iframe surface, exposure notes. $0.50. USDC on Base via x402.",
        mimeType: "application/json",
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            discoverable: true,
            bodyType: "json",
            schema: {
              type: "object",
              required: ["url"],
              properties: {
                url: { type: "string", format: "uri" },
                retryToken: { type: "string", description: "HMAC free-retry token from a prior Stage-1 failure" },
              },
            },
          },
          output: {
            type: "json",
            example: {
              success: true,
              tool: "site_audit",
              technologies: ["Next.js", "Cloudflare"],
              securityHeaders: [{ header: "HSTS", present: true, ok: true }],
              chargedUsd: "0.50",
            },
          },
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            payTo: env.SETTLEMENT_WALLET,
            asset: env.BASE_USDC_CONTRACT,
            prices: { site_audit: env.PRICE_AUDIT || "0.50" },
          },
        ],
      },
    ],
    settlement: {
      network: "eip155:8453",
      asset: env.BASE_USDC_CONTRACT,
      assetName: "USDC",
      payTo: env.SETTLEMENT_WALLET,
      protocol: "x402",
      facilitator: env.FACILITATOR_URL || "https://facilitator.payai.network",
    },
    tags: ["pdf", "reports", "invoice", "summary", "mcp", "x402", "base", "audit"],
  };
}
