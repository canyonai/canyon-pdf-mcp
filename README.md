# Canyon PDF Engine

Paid MCP (Model Context Protocol) suite for AI agents — professional vector PDFs, on-demand, settled in USDC on Base via the x402 protocol. No API keys, no accounts, no subscriptions.

**MCP endpoint:** `https://pdf.canyonai.io/mcp` (Streamable HTTP)

## Tools

| Tool | Price (USDC) | What it does |
|---|---|---|
| `generate_pdf_report` | $0.25 fast / $1.50 heavy | Multi-page vector PDFs from structured JSON or raw Markdown — reports, invoices, executive summaries |
| `scrape_url_to_pdf` | $0.50 | Scrapes any public URL, strips clutter, renders a clean vector PDF (SSRF-protected) |
| `extract_pdf_text` | $0.10 | Structured raw text, per-page content, and metadata from an existing PDF (SSRF-protected) |
| `pdf_pricing` | free | Current prices, settlement wallet, facilitator URL |

Fast tier renders with `pdf-lib`; heavy tier uses the `@pdfme` template engine with automatic fallback.

## Connect Claude Desktop / Cursor / any MCP client

```json
{
  "mcpServers": {
    "canyon-pdf": {
      "url": "https://pdf.canyonai.io/mcp"
    }
  }
}
```

## Payment (x402)

1. Call a paid tool without a payment header: HTTP 402 with an x402 PAYMENT-REQUIRED challenge.
2. Your x402 client settles the exact USDC amount on Base (chain eip155:8453, USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).
3. Retry with PAYMENT-SIGNATURE. No API key is ever issued or required.
4. Stage-1 render failure after payment returns a free retry token (1 hour). Stage-2 failure returns a signed refund challenge for facilitator reclaim.

Facilitator: https://facilitator.payai.network

## Machine-readable docs

- Agent manifest: /.well-known/mcp.json
- Discovery: /discovery
- LLMs index: /llms.txt
- Health: /health

## Example call

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "generate_pdf_report",
    "arguments": {
      "mode": "fast",
      "sourceType": "json",
      "jsonData": {
        "title": "Q3 Pipeline Report",
        "metadata": { "author": "Canyon Agent", "period": "2026-Q3" },
        "contentSections": [
          { "heading": "Summary", "body": "Pipeline grew 18% WoW.", "bullets": ["Win rate 34%"] }
        ]
      }
    }
  }
}
```

Returns a styled vector PDF on Cloudflare R2 with a 24-hour signed download URL.

## Security

- HMAC secret, webhook URL, and all wallet config live in Cloudflare Worker secrets — never in the bundle.
- SSRF protection on all URL-fetching tools: blocks localhost, RFC1918, link-local, and cloud metadata ranges.
- Download URLs are HMAC-signed and expire in 24 hours.

## License

All rights reserved - Canyon AI, canyonai.io
