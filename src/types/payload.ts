import { z } from "zod/v4";

/** Structured content section rendered into the PDF body */
export const ContentSectionSchema = z.object({
  heading: z.string().describe("Section heading"),
  body: z.string().describe("Section body text (markdown-ish plain text OK)"),
  bullets: z.array(z.string()).optional().describe("Optional bullet list"),
});

/** Single row in the metrics table */
export const MetricsRowSchema = z.object({
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
});

/** JSON source payload accepted by generate_pdf_report */
export const JsonDataSchema = z.object({
  title: z.string().default("Untitled Report"),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Key/value metadata shown in the header"),
  contentSections: z.array(ContentSectionSchema).optional(),
  metricsTable: z.array(MetricsRowSchema).optional(),
});

export type JsonData = z.infer<typeof JsonDataSchema>;
export type ContentSection = z.infer<typeof ContentSectionSchema>;
export type MetricsRow = z.infer<typeof MetricsRowSchema>;

/** MCP tool input for generate_pdf_report */
export const GeneratePdfReportInputSchema = z.object({
  mode: z
    .enum(["fast", "heavy"])
    .default("fast")
    .describe(
      'Rendering tier. "fast" uses pdf-lib ($0.25). "heavy" uses @pdfme template engine ($1.50) with pdf-lib fallback.',
    ),
  sourceType: z
    .enum(["json", "url", "markdown"])
    .describe(
      'Input source. "json" uses jsonData; "url" fetches a public page; "markdown" uses the markdown field.',
    ),
  jsonData: JsonDataSchema.optional().describe("Structured report data when sourceType=json"),
  markdown: z
    .string()
    .optional()
    .describe("Raw Markdown body when sourceType=markdown (converted into titled sections)"),
  url: z
    .string()
    .url()
    .optional()
    .describe("Public HTTP(S) URL to scrape when sourceType=url"),
  title: z.string().optional().describe("Optional document title override"),
  retryToken: z
    .string()
    .optional()
    .describe(
      "HMAC freeToken from a previous Stage-1 failure. When valid, payment is skipped for one retry.",
    ),
});

export type GeneratePdfReportInput = z.infer<typeof GeneratePdfReportInputSchema>;

/** MCP tool input for scrape_url_to_pdf ($0.50) */
export const ScrapeUrlToPdfInputSchema = z.object({
  url: z.string().url().describe("Public HTTP(S) URL to scrape into a clean vector PDF"),
  title: z.string().optional().describe("Optional PDF title override"),
  retryToken: z.string().optional(),
});

export type ScrapeUrlToPdfInput = z.infer<typeof ScrapeUrlToPdfInputSchema>;

/** MCP tool input for extract_pdf_text ($0.10) */
export const ExtractPdfTextInputSchema = z.object({
  url: z.string().url().describe("Public HTTP(S) URL of a PDF to parse"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional page cap (default 40)"),
  retryToken: z.string().optional(),
});

export type ExtractPdfTextInput = z.infer<typeof ExtractPdfTextInputSchema>;

export type PdfEngine = "pdf-lib" | "@pdfme";

export type PdfGenerationResult = {
  bytes: Uint8Array;
  engine: PdfEngine;
  fallbackUsed: boolean;
  title: string;
};

export type Stage1FailureResponse = {
  success: false;
  error: "Rendering failed";
  retryToken: string;
  instruction: string;
};

export type Stage2RefundResponse = {
  success: false;
  error: "Critical rendering failure after paid retry";
  refundChallenge: RefundChallengePayload;
  instruction: string;
};

/** Signed payload an AI agent presents to the x402 facilitator to reclaim USDC */
export type RefundChallengePayload = {
  protocol: "x402-refund";
  version: "1";
  network: "eip155:8453";
  asset: string;
  originalTxHash: string;
  payTo: string;
  amountUsd: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  /** HMAC signature over the canonical challenge body */
  signature: string;
};

/** MCP tool input for site_audit */
export const SiteAuditInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe("Public http(s) URL of the site to audit. Private/loopback targets are blocked."),
  retryToken: z
    .string()
    .optional()
    .describe("HMAC free-retry token from a prior Stage-1 failure"),
});
export type SiteAuditInputPayload = z.infer<typeof SiteAuditInputSchema>;
