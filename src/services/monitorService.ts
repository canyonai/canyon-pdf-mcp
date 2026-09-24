/**
 * Price Monitor service — recurring watch on a public URL with webhook notification.
 *
 * Semantics:
 *  - POST /api/monitor  ($1, x402)  → create a watch {url, webhookUrl}. 30-day life.
 *  - GET  /api/monitor/:id?token=… → status: last seen price, history, next sweep.
 *  - DELETE /api/monitor/:id?token=… → cancel.
 *  - Cron sweep (every 6h) fetches each watch, extracts price, diffs, and on change
 *    POSTs the webhook with an HMAC signature header.
 *
 * State: R2 under monitor/<id>.json. Tokens: HMAC-signed via HMAC_SECRET.
 */

import type { Env } from "../types/env";
import { fetchPublicUrl, SsrfBlockedError } from "./ssrf";

const WATCH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const USER_AGENT =
  "Mozilla/5.0 (compatible; CanyonPriceMonitor/1.0; +https://canyonai.io) AppleWebKit/537.36 Chrome/124 Safari/537.36";

export type MonitorCreateInput = {
  url: string;
  webhookUrl: string;
  label?: string;
};

export type MonitorState = {
  id: string;
  url: string;
  webhookUrl: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
  lastCheckedAt?: number;
  lastPrice?: string;
  history: { at: number; price: string }[];
};

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stateKey(id: string): string {
  return `monitor/${id}.json`;
}

export async function createMonitor(env: Env, input: MonitorCreateInput): Promise<MonitorState> {
  const now = Date.now();
  const state: MonitorState = {
    id: randomId(),
    url: input.url,
    webhookUrl: input.webhookUrl,
    label: input.label?.slice(0, 120),
    createdAt: now,
    expiresAt: now + WATCH_TTL_MS,
    history: [],
  };
  await env.PDF_BUCKET.put(stateKey(state.id), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
  return state;
}

export async function getMonitor(env: Env, id: string): Promise<MonitorState | null> {
  const obj = await env.PDF_BUCKET.get(stateKey(id));
  if (!obj) return null;
  try {
    const state = JSON.parse(await obj.text()) as MonitorState;
    if (Date.now() > state.expiresAt) return null;
    return state;
  } catch {
    return null;
  }
}

export async function deleteMonitor(env: Env, id: string): Promise<boolean> {
  const obj = await env.PDF_BUCKET.head(stateKey(id));
  if (!obj) return false;
  await env.PDF_BUCKET.delete(stateKey(id));
  return true;
}

// ---------------------------------------------------------------------------
// Price extraction
// ---------------------------------------------------------------------------

const PRICE_REGEX = /(?:US\$,?\s?|\$|€|£|USD\s?)\s?(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})?)/;

export function extractPrice(html: string): string | undefined {
  // 1. JSON-LD offers (most reliable when present)
  for (const m of html.matchAll(
    /"price"\s*:\s*"?([\d.,]+)"?/g,
  )) {
    const v = normalizePrice(m[1]);
    if (v) return v;
  }
  // 2. meta tags
  for (const prop of ["og:price:amount", "product:price:amount", "twitter:data1"]) {
    const m = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([\\d.,]+)["']`,
      "i",
    ).exec(html);
    if (m) {
      const v = normalizePrice(m[1]);
      if (v) return v;
    }
  }
  // 3. first plausible currency-marked number in the page
  const m = PRICE_REGEX.exec(html);
  if (m) return normalizePrice(m[1]);
  return undefined;
}

function normalizePrice(raw: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return undefined;
  // treat , as decimal separator when it looks like one (e.g. "12,99")
  const normalized = /^\d{1,3}([.,]\d{3})+$/.test(cleaned)
    ? cleaned.replace(/[.,]/g, "")
    : cleaned.replace(",", ".");
  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return num.toFixed(2);
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const { response } = await fetchPublicUrl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      redirect: "manual",
    });
    if (!response.ok) return null;
    return (await response.text()).slice(0, 600_000);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cron sweep
// ---------------------------------------------------------------------------

export async function runMonitorSweep(env: Env): Promise<{ checked: number; notified: number }> {
  const list = await env.PDF_BUCKET.list({ prefix: "monitor/" });
  let checked = 0;
  let notified = 0;

  for (const obj of list.objects) {
    if (!obj.key.endsWith(".json")) continue;
    try {
      const raw = await env.PDF_BUCKET.get(obj.key);
      if (!raw) continue;
      const state = JSON.parse(await raw.text()) as MonitorState;
      if (Date.now() > state.expiresAt) {
        await env.PDF_BUCKET.delete(obj.key);
        continue;
      }

      const html = await fetchPage(state.url);
      checked++;
      if (!html) continue;
      const price = extractPrice(html);
      if (!price) continue;

      const prev = state.lastPrice;
      state.lastCheckedAt = Date.now();
      state.lastPrice = price;

      if (prev !== undefined && prev !== price) {
        state.history.push({ at: Date.now(), price });
        if (state.history.length > 50) state.history = state.history.slice(-50);
        const ok = await notifyWebhook(env, state, prev, price);
        if (ok) notified++;
      }

      await env.PDF_BUCKET.put(stateKey(state.id), JSON.stringify(state), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (err) {
      console.error("[monitor] sweep error for", obj.key, err instanceof Error ? err.message : err);
    }
    if (checked >= 100) break; // per-sweep cap; 6h interval gives plenty of headroom
  }
  return { checked, notified };
}

async function notifyWebhook(
  env: Env,
  state: MonitorState,
  oldPrice: string,
  newPrice: string,
): Promise<boolean> {
  const payload = JSON.stringify({
    service: "canyonai-price-monitor",
    id: state.id,
    url: state.url,
    label: state.label ?? null,
    oldPrice,
    newPrice,
    currency: null,
    detectedAt: new Date().toISOString(),
  });
  const sig = await hmacSign(env, payload);
  try {
    const res = await fetch(state.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canyon-Signature": `sha256=${sig}`,
      },
      body: payload,
    });
    return res.ok;
  } catch (err) {
    console.error("[monitor] webhook failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function hmacSign(env: Env, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export { SsrfBlockedError, WATCH_TTL_MS };
