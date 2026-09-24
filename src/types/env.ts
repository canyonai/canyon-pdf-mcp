/**
 * Cloudflare Worker bindings & environment variables.
 *
 * INSERT POINTS
 * - SETTLEMENT_WALLET: your Phantom EVM / Base receiving address (0x…)
 * - HMAC_SECRET: wrangler secret — signs retry tokens & download URLs
 * - PDF_BUCKET: R2 binding named in wrangler.toml
 */

export type Env = {
  /** R2 bucket binding — configured in wrangler.toml as PDF_BUCKET → pdf-bucket */
  PDF_BUCKET: R2Bucket;

  /**
   * Receiving wallet for x402 USDC settlements on Base.
   * REPLACE `[INSERT_PHANTOM_EVM_ADDRESS_HERE]` in wrangler.toml with your 0x address.
   */
  SETTLEMENT_WALLET: string;

  /** Base mainnet USDC contract — default Circle USDC */
  BASE_USDC_CONTRACT: string;

  /** x402 facilitator base URL (e.g. https://facilitator.x402.org) */
  FACILITATOR_URL: string;

  /** USD price for fast/pdf-lib generate_pdf_report (e.g. "0.25") */
  PRICE_STANDARD: string;

  /** USD price for heavy/@pdfme generate_pdf_report (e.g. "1.50") */
  PRICE_HEAVY: string;

  /** USD price for scrape_url_to_pdf (e.g. "0.50") */
  PRICE_SCRAPE: string;

  /** USD price for extract_pdf_text (e.g. "0.10") */
  PRICE_EXTRACT: string;

  /** USD price for site_audit (e.g. "0.50") */
  PRICE_AUDIT: string;

  /** USD price for price_monitor create (e.g. "1.00") — 30-day watch */
  PRICE_MONITOR: string;

  /** Public Worker origin used when minting absolute download URLs */
  PUBLIC_ORIGIN: string;

  /**
   * Optional public CDN / custom domain for the R2 bucket.
   * When set, successful uploads can return `${PUBLIC_R2_BASE_URL}/${key}`.
   */
  PUBLIC_R2_BASE_URL: string;

  /**
   * Secret used for HMAC-SHA256 signing of freeToken / retryToken / download tokens.
   * Set with: `wrangler secret put HMAC_SECRET`
   */
  HMAC_SECRET: string;

  /**
   * Discord incoming webhook URL for x402 sale alerts.
   * Prefer secret: `wrangler secret put DISCORD_WEBHOOK_URL`
   * Leave empty / unset to disable notifications.
   */
  DISCORD_WEBHOOK_URL?: string;

  /**
   * Coinbase CDP facilitator (dual-stack discovery slot). Leave "" to disable;
   * when set, discovery routes can route through CDP for Bazaar indexing.
   * Requires CDP_API_KEY_NAME / CDP_API_KEY_PRIVATE secrets.
   */
  CDP_FACILITATOR_URL?: string;
  CDP_API_KEY_NAME?: string;
  CDP_API_KEY_PRIVATE?: string;

  /** Optional: Cloudflare account id for S3-compatible R2 pre-signed URLs */
  CF_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

/** Hono Variables shared across middleware → handlers */
export type AppVariables = {
  /** True when a valid retryToken bypassed the x402 challenge */
  paymentBypassed: boolean;
  /** Original payment tx hash extracted from PAYMENT-SIGNATURE or retryToken */
  paymentTxHash?: string;
  /** Charged USD amount for this request (informational) */
  chargedPriceUsd?: string;
  /** Pre-parsed MCP JSON-RPC body (so body stream is not consumed twice) */
  mcpParsedBody?: unknown;
};
