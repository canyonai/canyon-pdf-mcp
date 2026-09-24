/**
 * HMAC-signed freeToken / retryToken issuance + x402 Refund Challenge builder.
 *
 * INSERT POINTS
 * - env.HMAC_SECRET  → `wrangler secret put HMAC_SECRET`
 * - env.SETTLEMENT_WALLET / BASE_USDC_CONTRACT used in refund challenges
 */

import type { Env } from "../types/env";
import type { PaidTier } from "../types/pricing";
import type { RefundChallengePayload } from "../types/payload";

const FREE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFUND_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type FreeTokenClaims = {
  /** Original x402 settlement / payment transaction hash */
  txHash: string;
  /** Unix ms when the token was issued */
  iat: number;
  /** Unix ms when the token expires */
  exp: number;
  /** Tier that was paid for (so retries keep the same entitlement) */
  mode: PaidTier;
  /** Single-use nonce */
  nonce: string;
  /** "free" = Stage-1 retry; "used" is tracked client-side via single presentation */
  kind: "free";
};

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(sig);
}

async function hmacVerify(secret: string, message: string, signatureB64: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  const sigBytes = fromBase64Url(signatureB64);
  // subtle.verify needs an ArrayBuffer-backed view in some runtimes
  const copy = new Uint8Array(sigBytes);
  return crypto.subtle.verify("HMAC", key, copy, new TextEncoder().encode(message));
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64Url(bytes);
}

/**
 * Enforce single-use: atomically claim the token nonce in R2.
 * R2 conditional put with etagDoesNotExist succeeds only if the object is new.
 * Throws when the nonce was already consumed.
 */
export async function consumeRetryNonce(env: Env, nonce: string): Promise<void> {
  try {
    const res = await env.PDF_BUCKET.put(`nonce/${nonce}`, "1", {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (res === null) throw new Error("retryToken already used");
  } catch (err) {
    if (err instanceof Error && err.message === "retryToken already used") throw err;
    // R2 unavailable: fail open (availability over strictness) but log
    console.warn("[refundService] nonce store unavailable, allowing retry:", err instanceof Error ? err.message : err);
  }
}

/**
 * Stage 1 — mint a single-use freeToken after a paid generation failed.
 * Token embeds tx_hash + timestamp and is valid for 1 hour.
 */
export async function issueFreeToken(
  env: Env,
  params: { txHash: string; mode: PaidTier },
): Promise<string> {
  assertHmacSecret(env);
  const now = Date.now();
  const claims: FreeTokenClaims = {
    txHash: params.txHash,
    iat: now,
    exp: now + FREE_TOKEN_TTL_MS,
    mode: params.mode,
    nonce: randomNonce(),
    kind: "free",
  };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await hmacSign(env.HMAC_SECRET, payload);
  return `${payload}.${signature}`;
}

/**
 * Validate a client-supplied retryToken.
 * Returns claims on success; throws on invalid / expired tokens.
 */
export async function verifyFreeToken(env: Env, token: string): Promise<FreeTokenClaims> {
  assertHmacSecret(env);
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed retryToken");
  }
  const [payload, signature] = parts as [string, string];
  const ok = await hmacVerify(env.HMAC_SECRET, payload, signature);
  if (!ok) {
    throw new Error("Invalid retryToken signature");
  }
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as FreeTokenClaims;
  if (claims.kind !== "free") {
    throw new Error("Invalid retryToken kind");
  }
  if (!claims.txHash || !claims.exp || !claims.mode) {
    throw new Error("Incomplete retryToken claims");
  }
  if (Date.now() > claims.exp) {
    throw new Error("retryToken expired (valid for 1 hour from issuance)");
  }
  return claims;
}

/**
 * Stage 2 — build a signed x402 Refund Challenge referencing the original tx_hash.
 * The AI agent presents this payload to the facilitator to reclaim USDC.
 */
export async function buildRefundChallenge(
  env: Env,
  params: {
    originalTxHash: string;
    amountUsd: string;
    reason?: string;
  },
): Promise<RefundChallengePayload> {
  assertHmacSecret(env);
  assertSettlementWallet(env);

  const issuedAt = Date.now();
  const expiresAt = issuedAt + REFUND_CHALLENGE_TTL_MS;

  const unsigned: Omit<RefundChallengePayload, "signature"> = {
    protocol: "x402-refund",
    version: "1",
    network: "eip155:8453",
    asset: env.BASE_USDC_CONTRACT,
    originalTxHash: params.originalTxHash,
    payTo: env.SETTLEMENT_WALLET,
    amountUsd: params.amountUsd,
    reason: params.reason ?? "PDF rendering failed after paid retry (Stage 2)",
    issuedAt,
    expiresAt,
  };

  // Canonical JSON (stable key order) for HMAC
  const canonical = JSON.stringify(unsigned);
  const signature = await hmacSign(env.HMAC_SECRET, canonical);

  return { ...unsigned, signature };
}

/** Sign an R2 download token (key + expiry) for Worker-mediated 24h URLs */
export async function issueDownloadToken(
  env: Env,
  params: { key: string; expiresAt: number },
): Promise<string> {
  assertHmacSecret(env);
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ key: params.key, exp: params.expiresAt })),
  );
  const signature = await hmacSign(env.HMAC_SECRET, payload);
  return `${payload}.${signature}`;
}

export async function verifyDownloadToken(
  env: Env,
  token: string,
): Promise<{ key: string; exp: number }> {
  assertHmacSecret(env);
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed download token");
  const [payload, signature] = parts as [string, string];
  const ok = await hmacVerify(env.HMAC_SECRET, payload, signature);
  if (!ok) throw new Error("Invalid download token signature");
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
    key: string;
    exp: number;
  };
  if (!claims.key || !claims.exp) throw new Error("Incomplete download token");
  if (Date.now() > claims.exp) throw new Error("Download URL expired");
  return claims;
}

function assertHmacSecret(env: Env): void {
  if (!env.HMAC_SECRET || env.HMAC_SECRET.length < 16) {
    throw new Error(
      "HMAC_SECRET is missing or too short. Set it with: wrangler secret put HMAC_SECRET",
    );
  }
}

function assertSettlementWallet(env: Env): void {
  if (!env.SETTLEMENT_WALLET || !env.SETTLEMENT_WALLET.startsWith("0x") || env.SETTLEMENT_WALLET.includes("INSERT")) {
    throw new Error(
      "SETTLEMENT_WALLET is not configured. Replace [INSERT_PHANTOM_EVM_ADDRESS_HERE] in wrangler.toml with your 0x address.",
    );
  }
}
