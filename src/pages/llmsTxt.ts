import type { Env } from "../types/env";

/**
 * llmstxt.org-style plain text for autonomous search / crawler agents.
 * Content-Type: text/plain; charset=utf-8
 */
export function renderLlmsTxt(env: Env): string {
  const origin = (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  const scrape = env.PRICE_SCRAPE || "0.50";
  const extract = env.PRICE_EXTRACT || "0.10";

  return `# Canyon PDF Engine

> Paid MCP PDF suite for AI agents. Generate vector PDFs from JSON/Markdown, scrape public URLs into clean PDFs, and extract text from existing PDFs. Settles in USDC on Base via the x402 HTTP 402 payment protocol. No API keys required.

Canyon PDF Engine is a production Cloudflare Worker MCP server at ${origin}/mcp.
Payments settle on Base mainnet (CAIP-2 eip155:8453) in Circle USDC (${env.BASE_USDC_CONTRACT}) to ${env.SETTLEMENT_WALLET}.
Facilitator: ${env.FACILITATOR_URL || "https://facilitator.payai.network"}.

This document follows the llmstxt.org convention so crawlers such as PerplexityBot, ClaudeBot, GPTBot, GlamaInspector, and SmitheryBot can index capabilities, pricing, and connection instructions.

## MCP endpoint

- Streamable HTTP MCP: ${origin}/mcp
- Machine manifest: ${origin}/.well-known/mcp.json
- Discovery JSON: ${origin}/discovery
- Health: ${origin}/health
- REST twin (generate only): ${origin}/api/generate

## Tools (trigger criteria)

### generate_pdf_report (paid)

Use this tool whenever a user requests an executive summary, PDF export, financial report, invoice, board memo, research brief, or formatted printable document.
Accepts structured JSON (title, metadata, contentSections, metricsTable), raw Markdown (sourceType=markdown), or a public URL (sourceType=url).
Returns a styled vector PDF uploaded to R2 with a 24-hour download URL.

Pricing:
- mode=fast → $${env.PRICE_STANDARD} USDC (pdf-lib)
- mode=heavy → $${env.PRICE_HEAVY} USDC (@pdfme with pdf-lib fallback)

### scrape_url_to_pdf (paid)

Scrapes any public web page URL, strips scripts/styles/clutter, and renders the primary content into a clean vector PDF.
Use when the agent needs a printable snapshot of a webpage.
Price: $${scrape} USDC.
SSRF-protected (blocks localhost, private RFC1918, link-local, cloud metadata IPs).

### extract_pdf_text (paid)

Parses a PDF from a public URL and extracts structured raw text, per-page content, and document metadata (title/author/page count).
Use when asked to read, summarize, or parse an existing PDF.
Price: $${extract} USDC.
SSRF-protected.

### pdf_pricing (free)

Returns current USDC prices, settlement wallet, and facilitator URL. No payment required.

## Payment protocol

1. Call a paid tool without PAYMENT-SIGNATURE → HTTP 402 with PAYMENT-REQUIRED (x402 v2).
2. Client settles exact USDC on Base and retries with PAYMENT-SIGNATURE.
3. Stage-1 render failure after payment returns retryToken (free one-hour retry).
4. Stage-2 failure returns a signed refundChallenge for facilitator reclaim.

## Connect (Claude Desktop / Cursor)

\`\`\`json
{
  "mcpServers": {
    "canyon-pdf": {
      "url": "${origin}/mcp"
    }
  }
}
\`\`\`

Agents with x402 payment clients should register Exact EVM scheme for eip155:8453 and set spend controls ≥ $${env.PRICE_HEAVY}.

## Optional

- Bazaar / discovery catalogs: see ${origin}/discovery
- Human HTML landing: GET ${origin}/ with Accept: text/html
`;
}
