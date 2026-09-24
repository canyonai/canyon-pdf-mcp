import type { Env } from "../types/env";

/** Polished HTML landing for browser Accept: text/html */
export function renderLandingHtml(env: Env): string {
  const origin = (env.PUBLIC_ORIGIN || "https://pdf.canyonai.io").replace(/\/+$/, "");
  const scrape = env.PRICE_SCRAPE || "0.50";
  const extract = env.PRICE_EXTRACT || "0.10";
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        "canyon-pdf": {
          url: `${origin}/mcp`,
        },
      },
    },
    null,
    2,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Canyon PDF Engine — x402 Paid MCP on Base USDC</title>
  <meta name="description" content="AI agent PDF suite: generate reports, scrape URLs to PDF, extract PDF text. Paid via x402 USDC on Base." />
  <style>
    :root {
      --bg: #070b14;
      --card: #0f1628;
      --border: #1e2a44;
      --text: #e8eefc;
      --muted: #93a0bd;
      --accent: #3b82f6;
      --green: #22c55e;
      --amber: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(1200px 600px at 20% -10%, #132044 0%, var(--bg) 55%);
      color: var(--text);
      line-height: 1.55;
    }
    .wrap { max-width: 880px; margin: 0 auto; padding: 48px 20px 80px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px; border-radius: 999px;
      background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.35);
      color: #86efac; font-size: 13px; font-weight: 600;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); }
    h1 { font-size: clamp(2rem, 4vw, 2.75rem); margin: 18px 0 8px; letter-spacing: -0.03em; }
    .lead { color: var(--muted); font-size: 1.1rem; max-width: 62ch; }
    .grid { display: grid; gap: 14px; margin: 32px 0; }
    @media (min-width: 720px) { .grid { grid-template-columns: 1fr 1fr 1fr; } }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 16px;
      padding: 16px 16px 18px;
    }
    .card h3 { margin: 0 0 8px; font-size: 1rem; }
    .price { color: var(--amber); font-weight: 700; font-size: 0.95rem; margin-bottom: 8px; }
    .card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
    .section { margin-top: 36px; }
    .section h2 { font-size: 1.15rem; margin: 0 0 12px; }
    pre {
      background: #0a1020; border: 1px solid var(--border); border-radius: 12px;
      padding: 14px 16px; overflow-x: auto; font-size: 12.5px; color: #dbe7ff;
    }
    a { color: #93c5fd; }
    .links { display: flex; flex-wrap: wrap; gap: 12px 18px; margin-top: 10px; }
    .links a {
      text-decoration: none; border: 1px solid var(--border); background: var(--card);
      padding: 8px 12px; border-radius: 10px; font-size: 0.9rem;
    }
    footer { margin-top: 48px; color: var(--muted); font-size: 0.85rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="badge"><span class="dot" aria-hidden="true"></span> ● x402 Live on Base USDC</div>
    <h1>Canyon PDF Engine</h1>
    <p class="lead">
      Paid MCP suite for AI agents — generate executive PDFs, scrape public pages into clean vector documents,
      and extract text from existing PDFs. Settled in USDC on Base via the x402 protocol. No API keys.
    </p>

    <section class="section">
      <h2>Tool capabilities</h2>
      <div class="grid">
        <article class="card">
          <h3><code>generate_pdf_report</code></h3>
          <div class="price">$${env.PRICE_STANDARD} fast · $${env.PRICE_HEAVY} heavy</div>
          <p>High-resolution multi-page vector PDFs from structured JSON or raw Markdown — financial reports, invoices, executive summaries.</p>
        </article>
        <article class="card">
          <h3><code>scrape_url_to_pdf</code></h3>
          <div class="price">$${scrape} USDC</div>
          <p>Scrapes any public web page URL, strips clutter, and renders contents into a clean vector PDF.</p>
        </article>
        <article class="card">
          <h3><code>extract_pdf_text</code></h3>
          <div class="price">$${extract} USDC</div>
          <p>Parses a PDF from a public URL and extracts structured raw text, pages, and document metadata.</p>
        </article>
      </div>
    </section>

    <section class="section">
      <h2>Connect Claude Desktop / Cursor</h2>
      <p class="lead" style="font-size:0.95rem;margin:0 0 10px">Copy-paste MCP config (Streamable HTTP):</p>
      <pre><code>${escapeHtml(mcpConfig)}</code></pre>
    </section>

    <section class="section">
      <h2>Protocol specs</h2>
      <div class="links">
        <a href="${origin}/.well-known/mcp.json">/.well-known/mcp.json</a>
        <a href="${origin}/discovery">/discovery</a>
        <a href="${origin}/llms.txt">/llms.txt</a>
        <a href="${origin}/mcp">/mcp</a>
        <a href="${origin}/health">/health</a>
      </div>
    </section>

    <footer>
      Network <code>eip155:8453</code> · Asset USDC <code>${env.BASE_USDC_CONTRACT}</code> ·
      Pay to <code>${env.SETTLEMENT_WALLET}</code>
    </footer>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
