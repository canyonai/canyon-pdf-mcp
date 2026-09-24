/**
 * MCP server factory — Canyon PDF multi-tool suite (x402 paid).
 *
 * Tools:
 *  - generate_pdf_report ($0.25 fast / $1.50 heavy)
 *  - scrape_url_to_pdf   ($0.50)
 *  - extract_pdf_text    ($0.10)
 *  - pdf_pricing         (free)
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { Env } from "../types/env";
import type { PaidTier } from "../types/pricing";
import { priceUsdForTier } from "../types/pricing";
import {
  ExtractPdfTextInputSchema,
  GeneratePdfReportInputSchema,
  ScrapeUrlToPdfInputSchema,
  SiteAuditInputSchema,
} from "../types/payload";
import { runSiteAudit } from "../services/auditService";
import { generatePdfToolDescription } from "../discovery/bazaar";
import { extractPdfTextFromUrl } from "../services/extractPdfService";
import { generatePdfReport, scrapeUrlToPdf } from "../services/pdfService";
import { notifyDiscordX402Sale, uploadPdfToR2 } from "../services/r2Service";
import { buildRefundChallenge, issueFreeToken } from "../services/refundService";

export type PaymentContext = {
  paymentBypassed: boolean;
  paymentTxHash?: string;
  chargedPriceUsd?: string;
  /** True when this invocation already consumed a retryToken (Stage 2 on failure) */
  isRetryAttempt: boolean;
  /**
   * Schedule background work (Discord webhook) without delaying the MCP response.
   * Wired from `c.executionCtx.waitUntil` in index.ts.
   */
  waitUntil?: (task: Promise<unknown>) => void;
};

type ToolFailureOpts = {
  env: Env;
  payment: PaymentContext;
  isRetry: boolean;
  tier: PaidTier;
  txHash: string;
  priceUsd: string;
  toolName: string;
  err: unknown;
};

/**
 * Create a fresh McpServer for one HTTP request (stateless factory pattern).
 */
export function createPdfMcpServer(env: Env, payment: PaymentContext): McpServer {
  const server = new McpServer({
    name: "canyon-pdf-mcp",
    version: "1.2.0",
  });

  // -------------------------------------------------------------------------
  // generate_pdf_report — $0.25 / $1.50
  // -------------------------------------------------------------------------
  server.registerTool(
    "generate_pdf_report",
    {
      title: "Generate PDF Report",
      description: generatePdfToolDescription(env),
      inputSchema: GeneratePdfReportInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = GeneratePdfReportInputSchema.parse(args);
      const isRetry = Boolean(input.retryToken) || payment.isRetryAttempt;
      const tier: PaidTier = input.mode === "heavy" ? "heavy" : "fast";
      const priceUsd = payment.chargedPriceUsd ?? priceUsdForTier(env, tier);
      const txHash = paymentTx(payment);

      try {
        const pdf = await generatePdfReport(input);
        const uploaded = await uploadPdfToR2(env, pdf.bytes, {
          title: pdf.title,
          filename: pdf.title,
        });
        scheduleSale(env, payment, {
          mode: tier,
          earnedUsd: priceUsd,
          pdfUrl: uploaded.url,
          title: pdf.title,
          paymentTxHash: txHash,
          toolName: "generate_pdf_report",
        });

        const result = {
          success: true as const,
          tool: "generate_pdf_report",
          url: uploaded.url,
          key: uploaded.key,
          expiresAt: new Date(uploaded.expiresAt).toISOString(),
          engine: pdf.engine,
          fallbackUsed: pdf.fallbackUsed,
          title: pdf.title,
          sizeBytes: uploaded.size,
          chargedUsd: payment.paymentBypassed ? "0.00 (retryToken)" : priceUsd,
          paymentTxHash: txHash,
          network: "eip155:8453",
          asset: env.BASE_USDC_CONTRACT,
        };
        return ok(result);
      } catch (err) {
        return toolFailure({
          env,
          payment,
          isRetry,
          tier,
          txHash,
          priceUsd,
          toolName: "generate_pdf_report",
          err,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // scrape_url_to_pdf — $0.50
  // -------------------------------------------------------------------------
  server.registerTool(
    "scrape_url_to_pdf",
    {
      title: "Scrape URL to PDF",
      description:
        "Scrapes any public web page URL, strips clutter (scripts/styles), and renders its contents directly into a clean vector PDF. " +
        `Use when the user wants a printable snapshot of a webpage. Costs $${env.PRICE_SCRAPE || "0.50"} USDC on Base via x402. ` +
        "Blocks private/loopback SSRF targets.",
      inputSchema: ScrapeUrlToPdfInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = ScrapeUrlToPdfInputSchema.parse(args);
      const isRetry = Boolean(input.retryToken) || payment.isRetryAttempt;
      const tier: PaidTier = "scrape";
      const priceUsd = payment.chargedPriceUsd ?? priceUsdForTier(env, tier);
      const txHash = paymentTx(payment);

      try {
        const pdf = await scrapeUrlToPdf(input);
        const uploaded = await uploadPdfToR2(env, pdf.bytes, {
          title: pdf.title,
          filename: pdf.title,
        });
        scheduleSale(env, payment, {
          mode: tier,
          earnedUsd: priceUsd,
          pdfUrl: uploaded.url,
          title: pdf.title,
          paymentTxHash: txHash,
          toolName: "scrape_url_to_pdf",
        });

        const result = {
          success: true as const,
          tool: "scrape_url_to_pdf",
          sourceUrl: input.url,
          url: uploaded.url,
          key: uploaded.key,
          expiresAt: new Date(uploaded.expiresAt).toISOString(),
          title: pdf.title,
          sizeBytes: uploaded.size,
          chargedUsd: payment.paymentBypassed ? "0.00 (retryToken)" : priceUsd,
          paymentTxHash: txHash,
          network: "eip155:8453",
          asset: env.BASE_USDC_CONTRACT,
        };
        return ok(result);
      } catch (err) {
        return toolFailure({
          env,
          payment,
          isRetry,
          tier,
          txHash,
          priceUsd,
          toolName: "scrape_url_to_pdf",
          err,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // extract_pdf_text — $0.10
  // -------------------------------------------------------------------------
  server.registerTool(
    "extract_pdf_text",
    {
      title: "Extract PDF Text",
      description:
        "Parses a PDF document from a public URL and extracts structured raw text, per-page content, and document metadata (title/author/page count). " +
        `Use when asked to read, summarize, or OCR-parse an existing PDF. Costs $${env.PRICE_EXTRACT || "0.10"} USDC on Base via x402. ` +
        "Blocks private/loopback SSRF targets.",
      inputSchema: ExtractPdfTextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = ExtractPdfTextInputSchema.parse(args);
      const isRetry = Boolean(input.retryToken) || payment.isRetryAttempt;
      const tier: PaidTier = "extract";
      const priceUsd = payment.chargedPriceUsd ?? priceUsdForTier(env, tier);
      const txHash = paymentTx(payment);

      try {
        const extracted = await extractPdfTextFromUrl(input);
        scheduleSale(env, payment, {
          mode: tier,
          earnedUsd: priceUsd,
          pdfUrl: input.url,
          title: extracted.title ?? "PDF extract",
          paymentTxHash: txHash,
          toolName: "extract_pdf_text",
        });

        const result = {
          ...extracted,
          tool: "extract_pdf_text",
          chargedUsd: payment.paymentBypassed ? "0.00 (retryToken)" : priceUsd,
          paymentTxHash: txHash,
          network: "eip155:8453",
          asset: env.BASE_USDC_CONTRACT,
        };
        return ok(result);
      } catch (err) {
        return toolFailure({
          env,
          payment,
          isRetry,
          tier,
          txHash,
          priceUsd,
          toolName: "extract_pdf_text",
          err,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // site_audit — $0.50
  // -------------------------------------------------------------------------
  server.registerTool(
    "site_audit",
    {
      title: "Site Audit",
      description:
        "Runs a technology-fingerprint and exposure audit on any public URL: tech stack detection, security headers (HSTS, CSP, X-Frame-Options), TLS/HTTPS posture, robots.txt analysis, response time, script/iframes surface, and exposure notes. " +
        `Use when asked to profile, fingerprint, or security-check a website before contacting or integrating with it. Costs $${env.PRICE_AUDIT || "0.50"} USDC on Base via x402. ` +
        "Blocks private/loopback SSRF targets; read-only GET requests only.",
      inputSchema: SiteAuditInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = SiteAuditInputSchema.parse(args);
      const isRetry = Boolean(input.retryToken) || payment.isRetryAttempt;
      const tier: PaidTier = "audit";
      const priceUsd = payment.chargedPriceUsd ?? priceUsdForTier(env, tier);
      const txHash = paymentTx(payment);

      try {
        const report = await runSiteAudit({ url: input.url });
        scheduleSale(env, payment, {
          mode: tier,
          earnedUsd: priceUsd,
          pdfUrl: input.url,
          title: `Site audit: ${input.url}`,
          paymentTxHash: txHash,
          toolName: "site_audit",
        });

        const result = {
          ...report,
          chargedUsd: payment.paymentBypassed ? "0.00 (retryToken)" : priceUsd,
          paymentTxHash: txHash,
          network: "eip155:8453",
          asset: env.BASE_USDC_CONTRACT,
        };
        return ok(result);
      } catch (err) {
        return toolFailure({
          env,
          payment,
          isRetry,
          tier,
          txHash,
          priceUsd,
          toolName: "site_audit",
          err,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // pdf_pricing — free
  // -------------------------------------------------------------------------
  server.registerTool(
    "pdf_pricing",
    {
      title: "PDF Pricing",
      description:
        "Return current USDC prices for all Canyon PDF Engine tools on Base (free).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const info = {
        network: "eip155:8453",
        asset: env.BASE_USDC_CONTRACT,
        payTo: env.SETTLEMENT_WALLET,
        prices: {
          generate_pdf_report: {
            fast: { usd: env.PRICE_STANDARD, engine: "pdf-lib" },
            heavy: {
              usd: env.PRICE_HEAVY,
              engine: "@pdfme (fallback: pdf-lib)",
            },
          },
          scrape_url_to_pdf: { usd: env.PRICE_SCRAPE || "0.50" },
          extract_pdf_text: { usd: env.PRICE_EXTRACT || "0.10" },
          site_audit: { usd: env.PRICE_AUDIT || "0.50" },
        },
        facilitator: env.FACILITATOR_URL,
      };
      return ok(info);
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paymentTx(payment: PaymentContext): string {
  return (
    payment.paymentTxHash ??
    `unknown_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  );
}

function scheduleSale(
  env: Env,
  payment: PaymentContext,
  sale: Parameters<typeof notifyDiscordX402Sale>[1],
): void {
  if (!payment.paymentBypassed && payment.waitUntil) {
    payment.waitUntil(notifyDiscordX402Sale(env, sale));
  }
}

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  };
}

async function toolFailure(opts: ToolFailureOpts) {
  const message = opts.err instanceof Error ? opts.err.message : String(opts.err);
  console.error(`[${opts.toolName}] failed after payment verification`, {
    error: message,
    stack: opts.err instanceof Error ? opts.err.stack : undefined,
    tier: opts.tier,
    isRetry: opts.isRetry,
    txHash: opts.txHash,
    paymentBypassed: opts.payment.paymentBypassed,
  });

  if (opts.isRetry) {
    console.error(`[${opts.toolName}] CRITICAL Stage-2 failure — issuing refund challenge`, {
      txHash: opts.txHash,
      tier: opts.tier,
    });
    const refundChallenge = await buildRefundChallenge(opts.env, {
      originalTxHash: opts.txHash,
      amountUsd: opts.priceUsd,
      reason: `Stage-2 ${opts.toolName} failure: ${message}`,
    });
    const stage2 = {
      success: false as const,
      error: "Critical rendering failure after paid retry",
      refundChallenge,
      instruction:
        "Present refundChallenge to the x402 facilitator to reclaim your USDC. Include originalTxHash and signature.",
      httpStatusHint: 500,
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(stage2, null, 2) }],
      structuredContent: stage2,
    };
  }

  const retryToken = await issueFreeToken(opts.env, {
    txHash: opts.txHash,
    mode: opts.tier,
  });
  const stage1 = {
    success: false as const,
    error: "Rendering failed" as const,
    retryToken,
    instruction:
      "Re-submit your prompt including this retryToken. You will not be charged again.",
    details: message,
    httpStatusHint: 200,
    paymentTxHash: opts.txHash,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(stage1, null, 2) }],
    structuredContent: stage1,
  };
}
