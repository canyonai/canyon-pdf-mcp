/**
 * A2A Agent Card (agent-card.json) - the agent-discovery protocol surface.
 * Lets A2A-aware agents find and characterize this service without a signup flow.
 */

import type { Env } from "../types/env";
import { publicOrigin } from "./wellKnownX402";

export function buildAgentCard(env: Env) {
  const origin = publicOrigin(env);
  return {
    name: "Canyon PDF Engine",
    description:
      "Paid PDF suite for AI agents: generate reports from JSON/Markdown/URL, scrape pages to PDF, extract PDF text. Settles USDC on Base via x402. No API key.",
    url: `${origin}/mcp`,
    protocolVersion: "0.2.9",
    version: "1.1.0",
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "application/pdf"],
    provider: {
      organization: "Canyon AI",
      url: "https://canyonai.io",
    },
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/generate`,
      health: `${origin}/health`,
      discovery: `${origin}/discovery`,
    },
    skills: [
      {
        id: "generate_pdf_report",
        name: "Generate PDF Report",
        description:
          "Create a styled multi-page vector PDF from structured JSON, raw Markdown, or a public URL. $0.25 fast / $1.50 heavy, USDC on Base via x402.",
        tags: ["pdf", "report", "invoice", "summary"],
        examples: [
          "Generate a Q3 revenue report PDF from this JSON",
          "Turn this markdown brief into a downloadable PDF",
        ],
      },
      {
        id: "scrape_url_to_pdf",
        name: "Scrape URL to PDF",
        description: "Scrape any public web page and render it as a clean vector PDF. $0.50, USDC on Base via x402.",
        tags: ["pdf", "scrape", "snapshot"],
      },
      {
        id: "extract_pdf_text",
        name: "Extract PDF Text",
        description: "Extract structured raw text, tables, and metadata from a PDF at a public URL. $0.10, USDC on Base via x402.",
        tags: ["pdf", "extract", "text"],
      },
    ],
    payment: {
      protocol: "x402",
      network: "eip155:8453",
      asset: env.BASE_USDC_CONTRACT,
      payTo: env.SETTLEMENT_WALLET,
    },
  };
}
