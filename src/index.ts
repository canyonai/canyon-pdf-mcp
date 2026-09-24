/**
 * Canyon PDF MCP — Cloudflare Worker entrypoint
 * Domain: https://pdf.canyonai.io
 *
 * Stack: Hono + @modelcontextprotocol/server (Streamable HTTP) + @x402/hono
 * Storage: R2 (PDF_BUCKET) · Settlement: Base USDC via x402
 *
 * Tools: generate_pdf_report · scrape_url_to_pdf · extract_pdf_text · pdf_pricing
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Env, AppVariables } from "./types/env";
import { GeneratePdfReportInputSchema } from "./types/payload";
import { priceUsdForTier } from "./types/pricing";
import { createX402McpMiddleware } from "./middleware/x402PaidMcp";
import { createPdfMcpServer } from "./mcp/server";
import { runSiteAudit } from "./services/auditService";
import { generatePdfReport } from "./services/pdfService";
import { SiteAuditInputSchema } from "./types/payload";
import {
  getPdfFromR2,
  notifyDiscordX402Sale,
  uploadPdfToR2,
} from "./services/r2Service";
import {
  buildRefundChallenge,
  issueFreeToken,
  verifyDownloadToken,
} from "./services/refundService";
import { discoveryHelpPayload } from "./discovery/bazaar";
import { buildX402WellKnown } from "./discovery/wellKnownX402";
import { buildOpenApi } from "./discovery/openapi";
import { buildAgentCard } from "./discovery/agentCard";
import { renderLandingHtml } from "./pages/landingHtml";
import { renderLlmsTxt } from "./pages/llmsTxt";

type AppEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "PAYMENT-SIGNATURE",
      "X-PAYMENT",
      "PAYMENT-RESPONSE",
      "Mcp-Session-Id",
      "Last-Event-ID",
    ],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "Mcp-Session-Id"],
    maxAge: 86400,
  }),
);

// ---------------------------------------------------------------------------
// Scanner / vulnerability probing safeguards (immediately after CORS)
// ---------------------------------------------------------------------------

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname.toLowerCase();
  if (
    path.startsWith("/.env") ||
    path.startsWith("/.git") ||
    path.startsWith("/wp-") ||
    path.startsWith("/config")
  ) {
    return c.text("Forbidden", 403);
  }
  return next();
});

// Explicit common probe paths (middleware above already covers prefixes)
app.get("/.env", (c) => c.text("Forbidden", 403));
app.get("/.env.local", (c) => c.text("Forbidden", 403));
app.get("/.git/config", (c) => c.text("Forbidden", 403));
app.get("/wp-admin", (c) => c.text("Forbidden", 403));
app.get("/wp-login.php", (c) => c.text("Forbidden", 403));
app.get("/config.json", (c) => c.text("Forbidden", 403));

// ---------------------------------------------------------------------------
// Health / discovery / agent surfaces
// ---------------------------------------------------------------------------

function wantsHtml(acceptHeader: string | undefined): boolean {
  const accept = (acceptHeader ?? "").toLowerCase();
  // Explicit JSON clients (agents/curl -H Accept: application/json)
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  // Browsers send text/html first; also default to HTML when Accept is empty/*/*
  if (!accept || accept.includes("*/*") || accept.includes("text/html")) {
    return true;
  }
  return false;
}

function serviceJson(env: Env) {
  const origin = (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  return {
    name: "canyon-pdf-mcp",
    version: "1.2.0",
    serviceName: "Canyon PDF Engine",
    status: "ok",
    mcp: "/mcp",
    rest: "/api/generate",
    discovery: "/discovery",
    llmsTxt: "/llms.txt",
    wellKnown: "/.well-known/mcp.json",
    docs:
      "Paid MCP suite for AI agents: generate PDFs from JSON/Markdown, scrape URLs to PDF, extract PDF text. Settles USDC on Base via x402.",
    prices: {
      generate_pdf_report: {
        fast: `$${env.PRICE_STANDARD}`,
        heavy: `$${env.PRICE_HEAVY}`,
      },
      scrape_url_to_pdf: `$${env.PRICE_SCRAPE || "0.50"}`,
      extract_pdf_text: `$${env.PRICE_EXTRACT || "0.10"}`,
      site_audit: `$${env.PRICE_AUDIT || "0.50"}`,
    },
    tools: [
      "generate_pdf_report",
      "scrape_url_to_pdf",
      "extract_pdf_text",
      "site_audit",
      "pdf_pricing",
    ],
    network: "eip155:8453",
    asset: env.BASE_USDC_CONTRACT,
    payTo: env.SETTLEMENT_WALLET,
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/generate`,
      discovery: `${origin}/discovery`,
      llmsTxt: `${origin}/llms.txt`,
      wellKnown: `${origin}/.well-known/mcp.json`,
      health: `${origin}/health`,
    },
    tags: ["pdf", "reports", "invoice", "summary", "mcp", "x402", "base"],
  };
}

app.get("/", (c) => {
  if (wantsHtml(c.req.header("Accept"))) {
    return c.html(renderLandingHtml(c.env));
  }
  return c.json(serviceJson(c.env));
});

// Browsers / hosts often probe these — avoid noisy 404s on the landing experience
app.get("/index.html", (c) => c.html(renderLandingHtml(c.env)));
app.get("/favicon.ico", (c) => c.body(null, 204));

// SVG favicon for discovery audit + browser tabs
app.get("/favicon.svg", (c) =>
  c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f1628"/><text x="16" y="22" font-family="system-ui" font-size="16" font-weight="700" fill="#3b82f6" text-anchor="middle">P</text></svg>`,
    200,
    { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
  ),
);

// Link header helps crawlers find the favicon without parsing HTML
app.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res?.status === 200) {
    c.res.headers.set("Link", '</favicon.svg>; rel="icon"');
  }
});

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get("/llms.txt", (c) => {
  return c.text(renderLlmsTxt(c.env), 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
});

/**
 * Well-Known MCP Manifest for autonomous agent crawlers
 */
app.get("/.well-known/mcp.json", (c) => {
  const origin = (c.env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  return c.json({
    schema_version: "1.0",
    name: "Canyon PDF Engine",
    description:
      "Paid vector PDF suite for AI agents: generate reports, scrape URLs to PDF, extract PDF text. Gated by x402 on Base USDC.",
    mcp_version: "1.0",
    endpoints: {
      mcp: `${origin}/mcp`,
      rest: `${origin}/api/generate`,
      discovery: `${origin}/discovery`,
      llmsTxt: `${origin}/llms.txt`,
    },
    capabilities: {
      tools: [
        "generate_pdf_report",
        "scrape_url_to_pdf",
        "extract_pdf_text",
        "site_audit",
        "pdf_pricing",
      ],
    },
    pricing: {
      generate_pdf_report: {
        fast: c.env.PRICE_STANDARD,
        heavy: c.env.PRICE_HEAVY,
      },
      scrape_url_to_pdf: c.env.PRICE_SCRAPE || "0.50",
      extract_pdf_text: c.env.PRICE_EXTRACT || "0.10",
      site_audit: c.env.PRICE_AUDIT || "0.50",
      currency: "USDC",
    },
    payment: {
      protocol: "x402",
      network: "eip155:8453",
      token: "USDC",
      asset_contract: c.env.BASE_USDC_CONTRACT,
      payTo: c.env.SETTLEMENT_WALLET,
    },
  });
});

/**
 * Agent / operator discovery help — links to facilitator Bazaar catalogs
 * and documents how to connect MCP clients.
 */
app.get("/discovery", (c) => c.json(discoveryHelpPayload(c.env)));

// ---------------------------------------------------------------------------
// Well-known discovery surfaces (x402, OpenAPI, A2A) + free sample
// ---------------------------------------------------------------------------

// Both variants required: registerFromOrigin checks /.well-known/x402 FIRST,
// then /.well-known/x402.json. Serving only one breaks origin registration.
app.get("/.well-known/x402", (c) =>
  c.json(buildX402WellKnown(c.env), 200, { "Cache-Control": "public, max-age=300" }),
);
app.get("/.well-known/x402.json", (c) =>
  c.json(buildX402WellKnown(c.env), 200, { "Cache-Control": "public, max-age=300" }),
);

app.get("/openapi.json", (c) =>
  c.json(buildOpenApi(c.env), 200, { "Cache-Control": "public, max-age=300" }),
);

app.get("/.well-known/agent-card.json", (c) =>
  c.json(buildAgentCard(c.env), 200, { "Cache-Control": "public, max-age=300" }),
);

// Free sample call: probing agents try before they pay. Returns the exact
// response schema of a real generate call with sample data - no 402 wall.
app.post("/sample", async (c) => {
  const origin = (c.env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  return c.json({
    sample: true,
    note:
      "Free sample response demonstrating the exact shape of a paid /api/generate result. Pay via x402 to run your own data.",
    chargedUsd: "0.00 (sample)",
    result: {
      success: true,
      url: `${origin}/download/<signed-token>`,
      key: "reports/<example-key>.pdf",
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      engine: "pdf-lib",
      fallbackUsed: false,
      title: "Sample Report",
      sizeBytes: 48213,
      chargedUsd: "0.25",
      paymentTxHash: "0x<tx-hash>",
    },
    howToPay: {
      protocol: "x402",
      flow: "POST /api/generate without payment -> receive 402 with PAYMENT-REQUIRED -> sign EIP-3009 USDC (Base) -> retry with X-PAYMENT header",
      prices: {
        generate_fast: c.env.PRICE_STANDARD || "0.25",
        generate_heavy: c.env.PRICE_HEAVY || "1.50",
        scrape_url_to_pdf: c.env.PRICE_SCRAPE || "0.50",
        extract_pdf_text: c.env.PRICE_EXTRACT || "0.10",
      },
      payTo: c.env.SETTLEMENT_WALLET,
    },
  });
});

// ---------------------------------------------------------------------------
// 24h signed download (Worker-mediated when PUBLIC_R2_BASE_URL is unset)
// ---------------------------------------------------------------------------

app.get("/download/:token", async (c) => {
  try {
    const claims = await verifyDownloadToken(c.env, c.req.param("token"));
    const obj = await getPdfFromR2(c.env, claims.key);
    if (!obj) {
      return c.json({ error: "Object not found or expired" }, 404);
    }
    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set(
      "Content-Disposition",
      obj.httpMetadata?.contentDisposition ?? `inline; filename="report.pdf"`,
    );
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Invalid download token" },
      403,
    );
  }
});

// ---------------------------------------------------------------------------
// x402-gated routes
// ---------------------------------------------------------------------------

app.use("/mcp", async (c, next) => {
  const mw = createX402McpMiddleware(c.env);
  return mw(c, next);
});

app.use("/api/generate", async (c, next) => {
  const mw = createX402McpMiddleware(c.env);
  return mw(c, next);
});

app.use("/api/audit", async (c, next) => {
  const mw = createX402McpMiddleware(c.env);
  return mw(c, next);
});

// ---------------------------------------------------------------------------
// MCP Streamable HTTP — @modelcontextprotocol/server createMcpHandler
// ---------------------------------------------------------------------------

app.all("/mcp", async (c) => {
  const parsedBody = c.get("mcpParsedBody");
  const paymentBypassed = c.get("paymentBypassed") ?? false;
  const paymentTxHash = c.get("paymentTxHash");
  const chargedPriceUsd = c.get("chargedPriceUsd");
  const isRetryAttempt = paymentBypassed;

  let request = c.req.raw;
  if (parsedBody !== undefined) {
    request = new Request(c.req.raw, {
      body: JSON.stringify(parsedBody),
      headers: c.req.raw.headers,
    });
  }

  const waitUntil = (task: Promise<unknown>) => {
    c.executionCtx.waitUntil(task);
  };

  return handleMcp(request, c.env, {
    paymentBypassed,
    paymentTxHash,
    chargedPriceUsd,
    isRetryAttempt,
    parsedBody,
    waitUntil,
  });
});

async function handleMcp(
  request: Request,
  env: Env,
  opts: {
    paymentBypassed: boolean;
    paymentTxHash?: string;
    chargedPriceUsd?: string;
    isRetryAttempt: boolean;
    parsedBody: unknown;
    waitUntil: (task: Promise<unknown>) => void;
  },
): Promise<Response> {
  const handler = createMcpHandler(() =>
    createPdfMcpServer(env, {
      paymentBypassed: opts.paymentBypassed,
      paymentTxHash: opts.paymentTxHash,
      chargedPriceUsd: opts.chargedPriceUsd,
      isRetryAttempt: opts.isRetryAttempt,
      waitUntil: opts.waitUntil,
    }),
  );

  return handler.fetch(request, {
    parsedBody: opts.parsedBody,
  });
}

// ---------------------------------------------------------------------------
// REST twin — generate_pdf_report only (exact HTTP Stage-1 / Stage-2 semantics)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REST twin — site_audit
// ---------------------------------------------------------------------------

app.post("/api/audit", async (c) => {
  let body: unknown;
  try {
    body = c.get("mcpParsedBody") ?? (await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const parsed = SiteAuditInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  const input = parsed.data;
  const isRetry = Boolean(input.retryToken) || c.get("paymentBypassed");
  const priceUsd = c.get("chargedPriceUsd") ?? (c.env.PRICE_AUDIT || "0.50");
  const txHash =
    c.get("paymentTxHash") ??
    `unknown_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const paymentBypassed = c.get("paymentBypassed") ?? false;

  try {
    const report = await runSiteAudit({ url: input.url });

    if (!paymentBypassed) {
      c.executionCtx.waitUntil(
        notifyDiscordX402Sale(c.env, {
          mode: "audit",
          earnedUsd: priceUsd,
          pdfUrl: input.url,
          title: `Site audit: ${input.url}`,
          paymentTxHash: txHash,
          toolName: "site_audit",
        }),
      );
    }

    return c.json(
      {
        ...report,
        chargedUsd: paymentBypassed ? "0.00 (retryToken)" : priceUsd,
        paymentTxHash: txHash,
      },
      200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/audit] failed after payment", { error: message, isRetry, txHash });

    if (isRetry) {
      const refundChallenge = await buildRefundChallenge(c.env, {
        originalTxHash: txHash,
        amountUsd: priceUsd,
        reason: `Stage-2 site_audit failure: ${message}`,
      });
      return c.json(
        {
          success: false,
          error: "Critical audit failure after paid retry",
          refundChallenge,
          instruction:
            "Present refundChallenge to the x402 facilitator to reclaim your USDC.",
        },
        500,
      );
    }

    const retryToken = await issueFreeToken(c.env, { txHash, mode: "audit" });
    return c.json(
      {
        success: false,
        error: "Audit failed",
        retryToken,
        instruction:
          "Re-submit your request including this retryToken. You will not be charged again.",
        details: message,
        paymentTxHash: txHash,
      },
      200,
    );
  }
});


app.post("/api/generate", async (c) => {
  let body: unknown;
  try {
    body = c.get("mcpParsedBody") ?? (await c.req.json());
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const parsed = GeneratePdfReportInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  const input = parsed.data;
  const isRetry = Boolean(input.retryToken) || c.get("paymentBypassed");
  const tier = input.mode === "heavy" ? "heavy" : "fast";
  const priceUsd =
    c.get("chargedPriceUsd") ?? priceUsdForTier(c.env, tier);
  const txHash =
    c.get("paymentTxHash") ??
    `unknown_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  try {
    const pdf = await generatePdfReport(input);
    const uploaded = await uploadPdfToR2(c.env, pdf.bytes, {
      title: pdf.title,
      filename: pdf.title,
    });

    const paymentBypassed = c.get("paymentBypassed") ?? false;

    if (!paymentBypassed) {
      c.executionCtx.waitUntil(
        notifyDiscordX402Sale(c.env, {
          mode: tier,
          earnedUsd: priceUsd,
          pdfUrl: uploaded.url,
          title: pdf.title,
          paymentTxHash: txHash,
          toolName: "generate_pdf_report",
        }),
      );
    }

    return c.json(
      {
        success: true,
        url: uploaded.url,
        key: uploaded.key,
        expiresAt: new Date(uploaded.expiresAt).toISOString(),
        engine: pdf.engine,
        fallbackUsed: pdf.fallbackUsed,
        title: pdf.title,
        sizeBytes: uploaded.size,
        chargedUsd: paymentBypassed ? "0.00 (retryToken)" : priceUsd,
        paymentTxHash: txHash,
      },
      200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/generate] rendering failed after payment", {
      error: message,
      isRetry,
      txHash,
    });

    if (isRetry) {
      console.error("[POST /api/generate] CRITICAL Stage-2 failure", { txHash });
      const refundChallenge = await buildRefundChallenge(c.env, {
        originalTxHash: txHash,
        amountUsd: priceUsd,
        reason: `Stage-2 PDF rendering failure: ${message}`,
      });
      return c.json(
        {
          success: false,
          error: "Critical rendering failure after paid retry",
          refundChallenge,
          instruction:
            "Present refundChallenge to the x402 facilitator to reclaim your USDC.",
        },
        500,
      );
    }

    const retryToken = await issueFreeToken(c.env, {
      txHash,
      mode: tier,
    });
    return c.json(
      {
        success: false,
        error: "Rendering failed",
        retryToken,
        instruction:
          "Re-submit your prompt including this retryToken. You will not be charged again.",
        details: message,
        paymentTxHash: txHash,
      },
      200,
    );
  }
});

export default app;
