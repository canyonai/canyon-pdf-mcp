/**
 * x402 payment middleware for the /mcp (and /api/generate) routes.
 *
 * Features:
 * - Dynamic price by MCP tool + mode:
 *     generate_pdf_report fast/heavy → PRICE_STANDARD / PRICE_HEAVY
 *     scrape_url_to_pdf → PRICE_SCRAPE
 *     extract_pdf_text → PRICE_EXTRACT
 * - Bypass (grantAccess) when a valid HMAC retryToken is present
 * - Free pass for MCP lifecycle methods + unpaid tools (pdf_pricing)
 * - Settles Base mainnet USDC via ExactEvmScheme + FACILITATOR_URL
 *
 * INSERT POINTS
 * - env.SETTLEMENT_WALLET  → Phantom EVM address (0x…)
 * - env.FACILITATOR_URL    → https://facilitator.payai.network (Base mainnet)
 * - env.PRICE_*            → wrangler.toml prices
 * - env.HMAC_SECRET        → wrangler secret
 */

import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import {
  HTTPFacilitatorClient,
  type HTTPRequestContext,
  type RoutesConfig,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Env, AppVariables } from "../types/env";
import {
  dollarPriceForTier,
  isPaidMcpTool,
  priceUsdForTier,
  resolvePaidTier,
} from "../types/pricing";
import { consumeRetryNonce, verifyFreeToken } from "../services/refundService";
import {
  bazaarServiceMeta,
  mcpResourceUrl,
  publicOrigin as publicOriginEnv,
  restResourceUrl,
} from "../discovery/bazaar";

/** Base mainnet CAIP-2 */
export const BASE_MAINNET = "eip155:8453";

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

type McpJsonRpc = {
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    // modern envelope variants may nest differently
    [key: string]: unknown;
  };
  // MCP 2026 envelope may wrap the RPC message
  message?: McpJsonRpc;
  [key: string]: unknown;
};

/** Per-isolate cache so we don't rebuild / re-sync the facilitator on every request */
let cached:
  | {
      wallet: string;
      facilitatorUrl: string;
      middleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }>;
      ready: Promise<void>;
    }
  | undefined;

/**
 * Build the x402 Hono middleware bound to Worker env.
 * Facilitator `/supported` is synced once per isolate via `initialize()`.
 */
export function createX402McpMiddleware(env: Env): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  assertWallet(env);

  const facilitatorUrl = env.FACILITATOR_URL || "https://facilitator.payai.network";
  if (
    cached &&
    cached.wallet === env.SETTLEMENT_WALLET &&
    cached.facilitatorUrl === facilitatorUrl
  ) {
    const hit = cached;
    return async (c, next) => {
      await hit.ready;
      return hit.middleware(c, next);
    };
  }

  const facilitatorClient = new HTTPFacilitatorClient({
    // INSERT: override via wrangler.toml FACILITATOR_URL
    // Must support eip155:8453 (Base mainnet) — PayAI does; x402.org is testnet-only.
    url: facilitatorUrl,
  });

  // NOTE: Do NOT register @x402/extensions/bazaar on Cloudflare Workers.
  // x402 validates bazaar route extensions with Ajv (`ajv.compile` → `new Function`).
  // Workers disallow string→code generation ("Code generation from strings disallowed"),
  // which produced "invalid bazaar extension" / schema compile errors in observability.
  // Agent discovery stays on /discovery, /llms.txt, and /.well-known/mcp.json.
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    BASE_MAINNET,
    new ExactEvmScheme(),
  );

  // Fetch supported schemes/networks from the facilitator (required before first 402)
  const ready = resourceServer.initialize().catch((err) => {
    console.error("[x402] facilitator initialize failed", err);
    throw err;
  });

  const meta = bazaarServiceMeta(env);
  const mcpUrl = mcpResourceUrl(env);
  const restUrl = restResourceUrl(env);

  const routes: RoutesConfig = {
    // Protect MCP Streamable HTTP
    "POST /mcp": {
      accepts: {
        scheme: "exact",
        network: BASE_MAINNET,
        // INSERT: SETTLEMENT_WALLET in wrangler.toml
        payTo: env.SETTLEMENT_WALLET,
        // Dynamic price based on MCP tool + generate mode
        price: async (ctx: HTTPRequestContext) => {
          const { toolName, args } = await peekToolCall(ctx);
          return dollarPriceForTier(env, resolvePaidTier(toolName, args));
        },
        extra: {
          name: "USDC",
          version: "2",
          asset: env.BASE_USDC_CONTRACT,
        },
      },
      resource: mcpUrl,
      description: meta.description,
      mimeType: "application/json",
      serviceName: meta.serviceName,
      tags: meta.tags,
    },
    // REST twin
    "POST /api/audit": {
      accepts: {
        scheme: "exact",
        network: BASE_MAINNET,
        payTo: env.SETTLEMENT_WALLET,
        price: async () => dollarPriceForTier(env, "audit"),
        extra: {
          name: "USDC",
          version: "2",
          asset: env.BASE_USDC_CONTRACT,
        },
      },
      resource: `${publicOriginEnv(env)}/api/audit`,
      description: meta.description,
      mimeType: "application/json",
      serviceName: meta.serviceName,
      tags: [...meta.tags, "security", "audit"],
    },
    // REST twin
    "POST /api/generate": {
      accepts: {
        scheme: "exact",
        network: BASE_MAINNET,
        payTo: env.SETTLEMENT_WALLET,
        price: async (ctx: HTTPRequestContext) => {
          const { args } = await peekToolCall(ctx);
          return dollarPriceForTier(env, resolvePaidTier("generate_pdf_report", args));
        },
        extra: {
          name: "USDC",
          version: "2",
          asset: env.BASE_USDC_CONTRACT,
        },
      },
      resource: restUrl,
      description: meta.description,
      mimeType: "application/json",
      serviceName: meta.serviceName,
      tags: meta.tags,
    },
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes).onProtectedRequest(
    async (ctx) => {
      // 1) Free MCP control-plane methods (initialize, tools/list, etc.)
      const rpc = await safeGetBody(ctx);
      const method = resolveRpcMethod(rpc);
      const toolName = resolveToolName(rpc);

      if (method && method !== "tools/call") {
        return { grantAccess: true };
      }

      // tools/call for unpaid tools (e.g. pdf_pricing) is free
      if (method === "tools/call" && !isPaidMcpTool(toolName)) {
        return { grantAccess: true };
      }

      // 2) Valid retryToken → free single retry (Stage 1 recovery)
      const retryToken = extractRetryToken(rpc, ctx);
      if (retryToken) {
        try {
          // HMAC_SECRET must be set via `wrangler secret put HMAC_SECRET`
          const claims = await verifyFreeToken(env, retryToken);
          // Single-use enforcement: claim the nonce in R2 (fail-closed unless R2 down)
          await consumeRetryNonce(env, claims.nonce);
          // Stash claims on the adapter URL search — recovered in prep middleware
          // (HTTPRequestContext has no Hono c.set; we encode into a request header via side channel)
          (ctx as HTTPRequestContext & { __retryClaims?: typeof claims }).__retryClaims = claims;
          return { grantAccess: true };
        } catch (err) {
          console.warn("[x402] retryToken rejected:", err instanceof Error ? err.message : err);
          return {
            abort: true as const,
            reason: err instanceof Error ? err.message : "Invalid retryToken",
          };
        }
      }

      // 3) Continue to normal x402 payment challenge / verification
      return;
    },
  );

  // syncFacilitatorOnStart=false — we already call resourceServer.initialize() above
  const x402 = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  // Wrapper: parse body once (Hono caches c.req.json()), stash payment metadata, then run x402
  const middleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (
    c: AppContext,
    next: Next,
  ) => {
    await ready;
    c.set("paymentBypassed", false);

    // Buffer JSON body so MCP handler + x402 dynamic price + retryToken checks all share it.
    // Hono caches the result of c.req.json(), so later adapter.getBody() calls succeed.
    let parsed: unknown = undefined;
    if (c.req.method === "POST") {
      try {
        parsed = await c.req.json();
        c.set("mcpParsedBody", parsed);
      } catch {
        parsed = undefined;
      }
    }

    // Detect retryToken early for Hono variables (mirror of onProtectedRequest)
    const retryToken = extractRetryToken(parsed as McpJsonRpc | undefined, null);
    const { toolName, args } = extractToolCall(parsed as McpJsonRpc | undefined);
    if (retryToken) {
      try {
        const claims = await verifyFreeToken(env, retryToken);
        c.set("paymentBypassed", true);
        c.set("paymentTxHash", claims.txHash);
        c.set("chargedPriceUsd", priceUsdForTier(env, claims.mode));
      } catch {
        // x402 onProtectedRequest will abort with 403
      }
    } else {
      c.set(
        "chargedPriceUsd",
        priceUsdForTier(env, resolvePaidTier(toolName, args)),
      );
      // Best-effort tx ref from PAYMENT-SIGNATURE (prefer facilitator tx after settle)
      const paymentHeader =
        c.req.header("PAYMENT-SIGNATURE") ||
        c.req.header("X-PAYMENT") ||
        c.req.header("payment-signature");
      if (paymentHeader) {
        c.set("paymentTxHash", derivePaymentRef(paymentHeader));
      }
    }

    // IMPORTANT: return the middleware result — unpaid calls return a 402 Response
    const result = await x402(c, async () => {
      // After successful verify/settle, prefer facilitator transaction id if present
      const settlement =
        c.res?.headers?.get("PAYMENT-RESPONSE") ||
        c.req.header("PAYMENT-RESPONSE");
      if (settlement && !c.get("paymentBypassed")) {
        const tx = tryParseSettlementTx(settlement);
        if (tx) c.set("paymentTxHash", tx);
      }
      await next();
    });

    const res402 = result && result.status === 402 ? result : c.res && c.res.status === 402 ? c.res : null;
    if (res402) {
      try {
        const rawText = await res402.clone().text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(rawText) as Record<string, unknown>;
        } catch {
          body = { error: "Payment required" };
        }
        // The full challenge JSON (x402Version, accepts, resource) often lives in
        // the PAYMENT-REQUIRED header (base64). Merge it into the body so JSON-body
        // parsers (agentcash, x402scan) see the complete x402 v2 challenge.
        if (!body.accepts) {
          const prHeader = res402.headers.get("PAYMENT-REQUIRED");
          if (prHeader) {
            try {
              const pad = "=".repeat((4 - (prHeader.length % 4)) % 4);
              const decoded = JSON.parse(atob(prHeader + pad)) as Record<string, unknown>;
              for (const k of ["x402Version", "accepts", "resource", "error"]) {
                if (decoded[k] !== undefined && body[k] === undefined) body[k] = decoded[k];
              }
            } catch {
              // header decode failed - keep whatever body had
            }
          }
        }
        if (!body.extensions || typeof body.extensions !== "object") {
          body.extensions = {
            bazaar: {
              schema: {
                properties: {
                  input: {
                    properties: {
                      body: bazaarInputSchema(),
                    },
                  },
                  output: {
                    properties: {
                      example: bazaarOutputExample(),
                    },
                  },
                },
              },
            },
          };
        }
        const headers = new Headers(res402.headers);
        // Re-encode the full challenge (with extensions) into the PAYMENT-REQUIRED
        // header - checkers prefer header payload over body (agentcash probe source).
        // btoa cannot hold non-latin1; challenge JSON is ASCII-safe (base64 anyway).
        const encoded = btoa(JSON.stringify(body));
        headers.set("PAYMENT-REQUIRED", encoded);
        headers.set("x-payment-protocol", "x402");
        const out = new Response(JSON.stringify(body), {
          status: 402,
          statusText: res402.statusText,
          headers,
        });
        c.res = out;
        c.header("PAYMENT-REQUIRED", encoded);
        c.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Mcp-Session-Id");
        return out;
      } catch {
        return res402;
      }
    }
    return result ?? c.res;
  };

  cached = {
    wallet: env.SETTLEMENT_WALLET,
    facilitatorUrl,
    middleware,
    ready,
  };

  return async (c, next) => {
    await ready;
    return middleware(c, next);
  };
}

// ---------------------------------------------------------------------------
// Body / MCP helpers
// ---------------------------------------------------------------------------

async function peekToolCall(
  ctx: HTTPRequestContext,
): Promise<{ toolName?: string; args?: Record<string, unknown> }> {
  try {
    const getBody = ctx.adapter.getBody?.bind(ctx.adapter);
    if (!getBody) return {};
    return extractToolCall((await getBody()) as McpJsonRpc);
  } catch {
    return {};
  }
}

function extractToolCall(
  body: McpJsonRpc | undefined | null,
): { toolName?: string; args?: Record<string, unknown> } {
  if (!body || typeof body !== "object") return {};
  const toolName = resolveToolName(body);
  const args =
    (body.params?.arguments as Record<string, unknown> | undefined) ||
    (body.message?.params?.arguments as Record<string, unknown> | undefined) ||
    // REST twin: top-level body is the args
    (typeof body.mode === "string" || typeof body.url === "string" || typeof body.sourceType === "string"
      ? (body as Record<string, unknown>)
      : undefined);
  return { toolName, args };
}

async function safeGetBody(ctx: HTTPRequestContext): Promise<McpJsonRpc | undefined> {
  try {
    const getBody = ctx.adapter.getBody?.bind(ctx.adapter);
    if (!getBody) return undefined;
    return (await getBody()) as McpJsonRpc;
  } catch {
    return undefined;
  }
}

function resolveRpcMethod(body: McpJsonRpc | undefined): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  if (typeof body.method === "string") return body.method;
  if (body.message && typeof body.message.method === "string") return body.message.method;
  return undefined;
}

function resolveToolName(body: McpJsonRpc | undefined): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const params = (body.params ?? body.message?.params) as McpJsonRpc["params"];
  if (params && typeof params.name === "string") return params.name;
  return undefined;
}

function extractRetryToken(
  body: McpJsonRpc | undefined | null,
  _ctx: HTTPRequestContext | null,
): string | undefined {
  if (!body || typeof body !== "object") return undefined;

  if (typeof body.retryToken === "string") return body.retryToken;

  const args =
    (body.params?.arguments as Record<string, unknown> | undefined) ||
    (body.message?.params?.arguments as Record<string, unknown> | undefined) ||
    (body.arguments as Record<string, unknown> | undefined);

  if (typeof args?.retryToken === "string") return args.retryToken;
  return undefined;
}

/** Stable payment reference when facilitator tx hash is not yet known */
function derivePaymentRef(paymentHeader: string): string {
  // Use a truncated SHA-256 hex of the payment header as a correlator
  // (real Base tx hash is preferred when PAYMENT-RESPONSE is available)
  return `payref_${simpleHash(paymentHeader)}`;
}

function tryParseSettlementTx(headerValue: string): string | undefined {
  try {
    const json = JSON.parse(atob(headerValue.replace(/-/g, "+").replace(/_/g, "/")));
    if (json && typeof json.transaction === "string") return json.transaction;
    if (json && typeof json.txHash === "string") return json.txHash;
  } catch {
    // not base64 JSON — ignore
  }
  return undefined;
}

function simpleHash(input: string): string {
  // FNV-1a 32-bit → hex (fast correlator; not a security boundary)
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function assertWallet(env: Env): void {
  if (
    !env.SETTLEMENT_WALLET ||
    !env.SETTLEMENT_WALLET.startsWith("0x") ||
    env.SETTLEMENT_WALLET.includes("INSERT")
  ) {
    console.warn(
      "[x402] SETTLEMENT_WALLET is a placeholder. Replace [INSERT_PHANTOM_EVM_ADDRESS_HERE] in wrangler.toml before taking mainnet payments.",
    );
  }
}

// ---------------------------------------------------------------------------
// Bazaar discovery payloads injected into 402 challenge bodies
// ---------------------------------------------------------------------------

function bazaarInputSchema(): Record<string, unknown> {
  return {
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
  };
}

function bazaarOutputExample(): Record<string, unknown> {
  return {
    success: true,
    url: "https://pdf.canyonai.io/download/<signed-token>",
    expiresAt: "2026-09-15T00:00:00Z",
    engine: "pdf-lib",
    chargedUsd: "0.25",
    paymentTxHash: "0x<tx-hash>",
  };
}
