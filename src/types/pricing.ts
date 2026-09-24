import type { Env } from "./env";

/** Paid product tiers used by x402 pricing + retry tokens */
export type PaidTier = "fast" | "heavy" | "scrape" | "extract" | "audit" | "monitor";

export const PAID_MCP_TOOLS = [
  "generate_pdf_report",
  "scrape_url_to_pdf",
  "extract_pdf_text",
  "site_audit",
] as const;

export type PaidMcpTool = (typeof PAID_MCP_TOOLS)[number];

export function isPaidMcpTool(name: string | undefined): name is PaidMcpTool {
  return !!name && (PAID_MCP_TOOLS as readonly string[]).includes(name);
}

export function priceUsdForTier(env: Env, tier: PaidTier): string {
  switch (tier) {
    case "heavy":
      return env.PRICE_HEAVY;
    case "scrape":
      return env.PRICE_SCRAPE || "0.50";
    case "extract":
      return env.PRICE_EXTRACT || "0.10";
    case "audit":
      return env.PRICE_AUDIT || "0.50";
    case "monitor":
      return env.PRICE_MONITOR || "1.00";
    case "fast":
    default:
      return env.PRICE_STANDARD;
  }
}

export function dollarPriceForTier(env: Env, tier: PaidTier): `$${string}` {
  return `$${priceUsdForTier(env, tier)}`;
}

export function tierLabel(tier: PaidTier): string {
  switch (tier) {
    case "heavy":
      return "Heavy";
    case "scrape":
      return "Scrape";
    case "extract":
      return "Extract";
    case "fast":
    default:
      return "Fast";
  }
}

/** Resolve price tier from MCP tool + optional generate mode */
export function resolvePaidTier(
  toolName: string | undefined,
  args?: Record<string, unknown> | null,
): PaidTier {
  if (toolName === "scrape_url_to_pdf") return "scrape";
  if (toolName === "extract_pdf_text") return "extract";
  if (toolName === "site_audit") return "audit";
  if (toolName === "price_monitor") return "monitor";
  if (toolName === "generate_pdf_report") {
    return args?.mode === "heavy" ? "heavy" : "fast";
  }
  // REST /api/generate body
  if (args?.mode === "heavy") return "heavy";
  return "fast";
}
