/**
 * R2 upload + 24-hour download URL minting + Discord x402 sale alerts.
 *
 * Objects are stored under: reports/YYYY/MM/<uuid>.pdf
 *
 * Download URL strategy (in order):
 * 1. If PUBLIC_R2_BASE_URL is set → `${PUBLIC_R2_BASE_URL}/${key}` (public bucket / CDN)
 * 2. Else → Worker-signed `/download/:token` URL (HMAC, 24h expiry) — no R2 API keys needed
 *
 * Optional: set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CF_ACCOUNT_ID secrets
 * if you later want native S3-compatible pre-signed URLs.
 *
 * Discord: set DISCORD_WEBHOOK_URL (`wrangler secret put DISCORD_WEBHOOK_URL`).
 * Callers should schedule `notifyDiscordX402Sale` via `executionCtx.waitUntil(...)`.
 */

import type { Env } from "../types/env";
import { issueDownloadToken } from "./refundService";

const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DISCORD_EMBED_GREEN = 0x00ff00;

export type UploadResult = {
  key: string;
  url: string;
  expiresAt: number;
  contentType: "application/pdf";
  size: number;
};

export type DiscordSaleAlert = {
  /** Product tier label for the embed Mode field */
  mode: "fast" | "heavy" | "scrape" | "extract" | "audit" | "monitor";
  /** USD amount charged (e.g. "0.25" or "1.50") — displayed as "$X.XX USDC" on Base */
  earnedUsd: string;
  /** Public / signed R2 download URL (or N/A for extract-only) */
  pdfUrl: string;
  title?: string;
  paymentTxHash?: string;
  toolName?: string;
};

/** Build a path like reports/2026/08/<uuid>.pdf */
export function buildReportObjectKey(now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const id = crypto.randomUUID();
  return `reports/${yyyy}/${mm}/${id}.pdf`;
}

/**
 * Upload PDF bytes to the PDF_BUCKET R2 binding and return a 24h URL.
 */
export async function uploadPdfToR2(
  env: Env,
  bytes: Uint8Array,
  options?: { filename?: string; title?: string },
): Promise<UploadResult> {
  const key = buildReportObjectKey();
  const expiresAt = Date.now() + DOWNLOAD_TTL_MS;

  // R2 put — BodyInit accepts ArrayBuffer; copy to guarantee an ArrayBuffer (not SharedArrayBuffer)
  const body = new Uint8Array(bytes);
  await env.PDF_BUCKET.put(key, body, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `inline; filename="${sanitizeFilename(options?.filename ?? options?.title ?? "report")}.pdf"`,
      cacheControl: "private, max-age=86400",
    },
    customMetadata: {
      title: options?.title ?? "report",
      expiresAt: String(expiresAt),
      generatedAt: new Date().toISOString(),
    },
  });

  const url = await mintDownloadUrl(env, key, expiresAt);

  return {
    key,
    url,
    expiresAt,
    contentType: "application/pdf",
    size: bytes.byteLength,
  };
}

/**
 * Stream an object from R2 (used by the /download/:token route).
 */
export async function getPdfFromR2(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.PDF_BUCKET.get(key);
}

/**
 * Fire a styled Discord embed for a completed x402-paid PDF generation.
 *
 * No-ops when `DISCORD_WEBHOOK_URL` is missing. Safe to pass into
 * `executionCtx.waitUntil(...)` — errors are logged, never thrown to the caller.
 *
 * INSERT: `wrangler secret put DISCORD_WEBHOOK_URL`
 */
export async function notifyDiscordX402Sale(
  env: Env,
  sale: DiscordSaleAlert,
): Promise<void> {
  const webhook = (env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (!webhook) {
    return;
  }

  const modeLabel =
    sale.mode === "audit" || sale.mode === "monitor"
      ? "Audit"
      : sale.mode === "heavy"
      ? "Heavy"
      : sale.mode === "scrape"
        ? "Scrape"
        : sale.mode === "extract"
          ? "Extract"
          : "Fast";
  const earned = `$${sale.earnedUsd} USDC`;

  const payload = {
    embeds: [
      {
        title: " New x402 Sale - Canyon PDF Engine",
        color: DISCORD_EMBED_GREEN,
        fields: [
          { name: "Mode", value: modeLabel, inline: true },
          { name: "Earned", value: `${earned} on Base`, inline: true },
          ...(sale.toolName
            ? [{ name: "Tool", value: sale.toolName, inline: true }]
            : []),
          { name: "PDF Link", value: sale.pdfUrl },
        ],
        timestamp: new Date().toISOString(),
        footer: sale.paymentTxHash
          ? { text: `tx: ${sale.paymentTxHash}` }
          : sale.title
            ? { text: sale.title.slice(0, 100) }
            : undefined,
      },
    ],
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[discord] webhook failed", {
        status: res.status,
        body: body.slice(0, 300),
      });
    }
  } catch (err) {
    console.error("[discord] webhook error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function mintDownloadUrl(env: Env, key: string, expiresAt: number): Promise<string> {
  const publicBase = (env.PUBLIC_R2_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (publicBase) {
    // Public bucket / custom domain attached to R2
    return `${publicBase}/${key}`;
  }

  // Worker-mediated signed download (default — works without R2 public access)
  const token = await issueDownloadToken(env, { key, expiresAt });
  const origin = (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  return `${origin}/download/${token}`;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80)
    .replace(/^_|_$/g, "") || "report";
}
