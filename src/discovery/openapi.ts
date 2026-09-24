/**
 * OpenAPI 3.1 description of the paid REST surface.
 * OpenAPI-aware agents read this to learn request/response contracts before paying.
 */

import type { Env } from "../types/env";
import { publicOrigin } from "./wellKnownX402";

export function buildOpenApi(env: Env) {
  const origin = publicOrigin(env);
  const usdcRef = {
    scheme: "exact",
    network: "eip155:8453",
    payTo: env.SETTLEMENT_WALLET,
    asset: env.BASE_USDC_CONTRACT,
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Canyon PDF Engine (x402)",
      version: "1.1.0",
      description:
        "Paid PDF suite for AI agents. Settles in USDC on Base via x402 (HTTP 402 + EIP-3009). MCP twin at /mcp. No API key - the wallet is the identity.",
      "x-network": "eip155:8453",
      "x-settlement": { ...usdcRef, facilitator: env.FACILITATOR_URL || "https://facilitator.payai.network" },
      // INSERT contact email for x402scan merchant-page ownership verification:
      contact: { name: "Canyon AI", email: "", url: "https://canyonai.io" },
      "x-guidance":
        "Canyon PDF Engine: pay-per-call PDF suite for AI agents. POST /api/generate builds a styled vector PDF from JSON, Markdown, or a public URL and returns a 24h download URL. Payment: x402 - call without payment, receive 402 with PAYMENT-REQUIRED challenge, sign EIP-3009 USDC on Base, retry with X-PAYMENT header. Free endpoints: /health, /discovery, /llms.txt, POST /sample. MCP twin at /mcp with the same tools. On paid failure you get a free retryToken; a second failure yields a signed refund challenge.",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/generate": {
        post: {
          summary: "Generate a styled vector PDF (paid)",
          description:
            "Builds a multi-page vector PDF from structured JSON, raw Markdown, or a public URL. Returns a 24h signed download URL. mode=fast $0.25 (pdf-lib), mode=heavy $1.50 (@pdfme). First failure after payment returns a free retryToken; second failure returns a signed refund challenge.",
          "x-guidance":
            "Send sourceType=markdown with your markdown text for a styled report; sourceType=json for structured reports with sections and a metrics table. mode=fast for short docs, heavy for dense multi-section reports.",
          security: [{ x402Auth: [] }],
          "x-auth-mode": "payment",
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: env.PRICE_STANDARD || "0.25" },
            protocols: [{ x402: {} }],
          },
          extensions: {
            bazaar: {
              schema: {
                properties: {
                  input: {
                    properties: {
                      body: {
                        type: "object",
                        required: ["sourceType"],
                        properties: {
                          sourceType: { type: "string", enum: ["json", "url", "markdown"], description: "Input source kind" },
                          mode: { type: "string", enum: ["fast", "heavy"], description: "fast=$0.25 pdf-lib; heavy=$1.50 @pdfme" },
                          jsonData: { type: "object", description: "Structured report data (sourceType=json)" },
                          markdown: { type: "string", description: "Raw Markdown (sourceType=markdown)" },
                          url: { type: "string", format: "uri", description: "Public page URL (sourceType=url)" },
                          title: { type: "string", description: "Optional document title override" },
                          retryToken: { type: "string", description: "Free-retry HMAC token from a prior Stage-1 failure" },
                        },
                      },
                    },
                  },
                  output: {
                    properties: {
                      example: {
                        success: true,
                        url: "https://pdf.canyonai.io/download/<signed-token>",
                        expiresAt: "2026-09-15T00:00:00Z",
                        engine: "pdf-lib",
                        chargedUsd: "0.25",
                        paymentTxHash: "0x<tx-hash>",
                      },
                    },
                  },
                },
              },
            },
          },
          "x-price-usd": { fast: env.PRICE_STANDARD || "0.25", heavy: env.PRICE_HEAVY || "1.50" },
          "x-payment": usdcRef,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GenerateInput" },
              },
            },
          },
          responses: {
            "402": { description: "Payment required - x402 challenge in PAYMENT-REQUIRED header and body" },
            "200": {
              description: "PDF generated and uploaded",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/GenerateResult" },
                },
              },
            },
            "500": { description: "Stage-2 failure; includes refundChallenge when retry also failed" },
          },
        },
      },
      "/health": {
        get: {
          summary: "Health check (free)",
          security: [{ publicNone: [] }],
          "x-auth-mode": "none",
          responses: { "200": { description: "Service alive" } },
        },
      },
      "/discovery": {
        get: {
          summary: "Agent discovery payload (free)",
          security: [{ publicNone: [] }],
          "x-auth-mode": "none",
          responses: { "200": { description: "Tools, prices, connect example" } },
        },
      },
      "/llms.txt": {
        get: {
          summary: "LLM-readable service summary (free)",
          security: [{ publicNone: [] }],
          "x-auth-mode": "none",
          responses: { "200": { description: "text/plain" } },
        },
      },
    },
    components: {
      securitySchemes: {
        x402Auth: {
          type: "http",
          scheme: "x402",
          description: "x402 EIP-3009 USDC payment on Base (HTTP 402 challenge flow)",
        },
        publicNone: { type: "apiKey", in: "header", name: "X-None", description: "No auth - free public endpoint" },
      },
      schemas: {
        GenerateInput: {
          type: "object",
          required: ["sourceType"],
          properties: {
            sourceType: { type: "string", enum: ["json", "url", "markdown"] },
            mode: { type: "string", enum: ["fast", "heavy"], default: "fast" },
            jsonData: { type: "object", description: "Structured report data when sourceType=json" },
            markdown: { type: "string", description: "Raw Markdown when sourceType=markdown" },
            url: { type: "string", format: "uri", description: "Public page to scrape when sourceType=url" },
            title: { type: "string" },
            retryToken: { type: "string", description: "Free-retry HMAC token from a prior Stage-1 failure" },
          },
        },
        GenerateResult: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            url: { type: "string", format: "uri" },
            key: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
            engine: { type: "string" },
            fallbackUsed: { type: "boolean" },
            title: { type: "string" },
            sizeBytes: { type: "integer" },
            chargedUsd: { type: "string" },
            paymentTxHash: { type: "string" },
          },
        },
      },
    },
  };
}
