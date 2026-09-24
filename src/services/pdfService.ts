/**
 * Dual-engine PDF generation:
 *  - heavy → @pdfme/generator (template / vector report)
 *  - fast  → pdf-lib (lightweight summary)
 *
 * If @pdfme fails (WASM / rendering), we log and fall back to pdf-lib.
 *
 * NOTE: The brief referenced `@pdf-me/generator`; the published package is
 * `@pdfme/generator` (no hyphen). We use the published name.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Template } from "@pdfme/common";
import { generate } from "@pdfme/generator";
import { text, table, line } from "@pdfme/schemas";
import type {
  ContentSection,
  GeneratePdfReportInput,
  JsonData,
  MetricsRow,
  PdfGenerationResult,
  ScrapeUrlToPdfInput,
} from "../types/payload";
import { JsonDataSchema } from "../types/payload";
import { assertPublicHttpUrl, fetchPublicUrl } from "./ssrf";

const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve input → JsonData, then render with the requested engine (+ fallback).
 */
export async function generatePdfReport(
  input: GeneratePdfReportInput,
): Promise<PdfGenerationResult> {
  const data = await resolveReportData(input);
  const wantHeavy = input.mode === "heavy";

  if (!wantHeavy) {
    const bytes = await renderWithPdfLib(data);
    return { bytes, engine: "pdf-lib", fallbackUsed: false, title: data.title };
  }

  // Heavy path: try @pdfme first
  try {
    const bytes = await renderWithPdfme(data);
    return { bytes, engine: "@pdfme", fallbackUsed: false, title: data.title };
  } catch (err) {
    // Stage: engine failure → automatic pdf-lib fallback (still counts as paid attempt)
    console.error("[pdfService] @pdfme rendering/WASM failed — falling back to pdf-lib", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      title: data.title,
    });
    const bytes = await renderWithPdfLib(data);
    return { bytes, engine: "pdf-lib", fallbackUsed: true, title: data.title };
  }
}

// ---------------------------------------------------------------------------
// Source resolution (json | url scrape)
// ---------------------------------------------------------------------------

async function resolveReportData(input: GeneratePdfReportInput): Promise<JsonData> {
  if (input.sourceType === "markdown") {
    if (!input.markdown?.trim()) {
      throw new Error('sourceType="markdown" requires markdown');
    }
    return markdownToJsonData(input.markdown, input.title);
  }

  if (input.sourceType === "json") {
    if (!input.jsonData) {
      throw new Error('sourceType="json" requires jsonData');
    }
    const data = JsonDataSchema.parse(input.jsonData);
    if (input.title) data.title = input.title;
    return data;
  }

  if (!input.url) {
    throw new Error('sourceType="url" requires a public url');
  }

  const scraped = await scrapeUrlToJsonData(input.url);
  if (input.title) scraped.title = input.title;
  return JsonDataSchema.parse(scraped);
}

/** Dedicated scrape tool — always renders via fast pdf-lib path after SSRF-safe fetch */
export async function scrapeUrlToPdf(
  input: ScrapeUrlToPdfInput,
): Promise<PdfGenerationResult> {
  assertPublicHttpUrl(input.url);
  const data = await scrapeUrlToJsonData(input.url);
  if (input.title) data.title = input.title;
  const bytes = await renderWithPdfLib(JsonDataSchema.parse(data));
  return {
    bytes,
    engine: "pdf-lib",
    fallbackUsed: false,
    title: data.title,
  };
}

function markdownToJsonData(markdown: string, titleOverride?: string): JsonData {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const title =
    titleOverride ||
    lines.find((l) => l.startsWith("# "))?.replace(/^#\s+/, "").trim() ||
    "Markdown Report";

  const sections: ContentSection[] = [];
  let current: ContentSection | null = null;
  const push = () => {
    if (current && (current.body.trim() || current.bullets?.length)) {
      sections.push(current);
    }
  };

  for (const line of lines) {
    const h2 = /^#{2,3}\s+(.+)$/.exec(line);
    if (h2) {
      push();
      current = { heading: h2[1]!.trim(), body: "", bullets: [] };
      continue;
    }
    if (/^#\s+/.test(line)) continue; // title already captured
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) current = { heading: "Content", body: "", bullets: [] };
      current.bullets = current.bullets ?? [];
      current.bullets.push(bullet[1]!.trim());
      continue;
    }
    if (!current) current = { heading: "Content", body: "", bullets: [] };
    current.body = current.body ? `${current.body}\n${line}` : line;
  }
  push();

  return {
    title,
    metadata: { sourceType: "markdown" },
    contentSections: sections.length
      ? sections
      : [{ heading: "Content", body: markdown.slice(0, 12_000) }],
    metricsTable: [],
  };
}

/**
 * Fetch a public URL, strip script/style, extract headings + body text,
 * and structure it into the PDF rendering pipeline.
 */
export async function scrapeUrlToJsonData(url: string): Promise<JsonData> {
  assertPublicHttpUrl(url);
  const { response: res } = await fetchPublicUrl(url, {
    headers: {
      "User-Agent": "CanyonPDF-MCP/1.0 (+https://pdf.canyonai.io)",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch URL (${res.status} ${res.statusText}): ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        return JsonDataSchema.parse(parsed);
      }
    } catch {
      // fall through to HTML/text extraction
    }
  }

  const cleaned = stripHtml(raw);
  const title =
    extractTagText(raw, "title") ||
    extractFirstHeading(raw) ||
    new URL(url).hostname ||
    "Web Report";

  const sections = extractSections(raw, cleaned);
  const metadata: Record<string, string | number | boolean> = {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    contentType: contentType.split(";")[0] ?? "text/html",
  };

  return {
    title,
    metadata,
    contentSections: sections.length
      ? sections
      : [{ heading: "Content", body: cleaned.slice(0, 12_000) }],
    metricsTable: [],
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractTagText(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m?.[1] ? stripHtml(m[1]).slice(0, 200) : null;
}

function extractFirstHeading(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m?.[1] ? stripHtml(m[1]).slice(0, 200) : null;
}

function extractSections(html: string, cleanedFallback: string): ContentSection[] {
  const sections: ContentSection[] = [];
  const headingRe = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches = [...html.matchAll(headingRe)];

  if (matches.length === 0) {
    const paras = cleanedFallback
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 40)
      .slice(0, 8);
    return paras.map((body, i) => ({
      heading: `Section ${i + 1}`,
      body: body.slice(0, 2500),
    }));
  }

  for (let i = 0; i < matches.length && sections.length < 12; i++) {
    const match = matches[i]!;
    const heading = stripHtml(match[2] ?? `Section ${i + 1}`).slice(0, 120);
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : html.length;
    const chunk = stripHtml(html.slice(start, end)).slice(0, 2500);
    if (heading || chunk) {
      sections.push({ heading: heading || `Section ${i + 1}`, body: chunk || "—" });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Engine: pdf-lib (fast / fallback)
// ---------------------------------------------------------------------------

async function renderWithPdfLib(data: JsonData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number): void => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  // Title
  ensureSpace(36);
  page.drawText(truncate(data.title, 80), {
    x: MARGIN,
    y: y - 18,
    size: 20,
    font: fontBold,
    color: rgb(0.08, 0.12, 0.22),
  });
  y -= 36;

  // Accent line
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 1.5,
    color: rgb(0.2, 0.55, 0.95),
  });
  y -= 20;

  // Metadata
  if (data.metadata && Object.keys(data.metadata).length > 0) {
    ensureSpace(20);
    page.drawText("Metadata", {
      x: MARGIN,
      y,
      size: 12,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.2),
    });
    y -= 16;
    for (const [k, v] of Object.entries(data.metadata)) {
      ensureSpace(14);
      const line = `${k}: ${String(v)}`;
      page.drawText(truncate(line, 95), {
        x: MARGIN,
        y,
        size: 9,
        font,
        color: rgb(0.3, 0.3, 0.35),
      });
      y -= 12;
    }
    y -= 8;
  }

  // Metrics table
  if (data.metricsTable?.length) {
    y = drawMetricsTable(page, font, fontBold, data.metricsTable, y, () => {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      return page;
    });
    y -= 12;
  }

  // Content sections
  for (const section of data.contentSections ?? []) {
    ensureSpace(28);
    page.drawText(truncate(section.heading, 80), {
      x: MARGIN,
      y,
      size: 13,
      font: fontBold,
      color: rgb(0.1, 0.15, 0.25),
    });
    y -= 16;

    y = drawWrappedText(page, font, section.body, y, 10, rgb(0.2, 0.2, 0.25), () => {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      return { page, y };
    });

    if (section.bullets?.length) {
      for (const bullet of section.bullets) {
        ensureSpace(14);
        const text = `• ${truncate(bullet, 90)}`;
        page.drawText(text, {
          x: MARGIN + 8,
          y,
          size: 9,
          font,
          color: rgb(0.25, 0.25, 0.3),
        });
        y -= 12;
      }
    }
    y -= 10;
  }

  // Footer on last page
  page.drawText("Generated by Canyon PDF MCP · pdf.canyonai.io", {
    x: MARGIN,
    y: 24,
    size: 8,
    font,
    color: rgb(0.55, 0.55, 0.6),
  });

  return doc.save();
}

function drawMetricsTable(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  rows: MetricsRow[],
  startY: number,
  newPage: () => PDFPage,
): number {
  let y = startY;
  let current = page;
  const col1 = MARGIN;
  const col2 = MARGIN + 220;
  const col3 = MARGIN + 400;

  current.drawText("Metrics", {
    x: MARGIN,
    y,
    size: 12,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.2),
  });
  y -= 16;

  current.drawText("Label", { x: col1, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.45) });
  current.drawText("Value", { x: col2, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.45) });
  current.drawText("Unit", { x: col3, y, size: 9, font: fontBold, color: rgb(0.4, 0.4, 0.45) });
  y -= 4;
  current.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.75, 0.75, 0.8),
  });
  y -= 12;

  for (const row of rows) {
    if (y < MARGIN + 20) {
      current = newPage();
      y = PAGE_HEIGHT - MARGIN;
    }
    current.drawText(truncate(row.label, 40), { x: col1, y, size: 9, font });
    current.drawText(truncate(row.value, 30), { x: col2, y, size: 9, font });
    current.drawText(truncate(row.unit ?? "", 15), { x: col3, y, size: 9, font });
    y -= 12;
  }
  return y;
}

function drawWrappedText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  startY: number,
  size: number,
  color: ReturnType<typeof rgb>,
  onNewPage: () => { page: PDFPage; y: number },
): number {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  let line = "";
  let y = startY;
  let current = page;

  const flush = (content: string) => {
    if (y < MARGIN + 20) {
      const next = onNewPage();
      current = next.page;
      y = next.y;
    }
    current.drawText(content, { x: MARGIN, y, size, font, color });
    y -= size + 3;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, size);
    if (width > maxWidth && line) {
      flush(truncate(line, 120));
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) flush(truncate(line, 120));
  return y;
}

// ---------------------------------------------------------------------------
// Engine: @pdfme (heavy)
// ---------------------------------------------------------------------------

async function renderWithPdfme(data: JsonData): Promise<Uint8Array> {
  // Blank A4 base (mm). pdfme blank basePdf — no external PDF asset required.
  const basePdf = {
    width: 210,
    height: 297,
    padding: [15, 15, 15, 15] as [number, number, number, number],
  };

  const schemas: Template["schemas"] = [[]];
  const inputs: Record<string, string | string[][]> = {};
  let cursorY = 10;

  // Title
  schemas[0]!.push({
    name: "title",
    type: "text",
    position: { x: 15, y: cursorY },
    width: 180,
    height: 12,
    fontSize: 18,
    fontColor: "#14213d",
    content: data.title,
  } as Template["schemas"][0][0]);
  inputs.title = data.title;
  cursorY += 16;

  // Divider
  schemas[0]!.push({
    name: "divider",
    type: "line",
    position: { x: 15, y: cursorY },
    width: 180,
    height: 0.5,
    color: "#3498db",
  } as Template["schemas"][0][0]);
  cursorY += 8;

  // Metadata block
  if (data.metadata && Object.keys(data.metadata).length > 0) {
    const metaText = Object.entries(data.metadata)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n");
    schemas[0]!.push({
      name: "metadata",
      type: "text",
      position: { x: 15, y: cursorY },
      width: 180,
      height: Math.min(40, 6 + Object.keys(data.metadata).length * 5),
      fontSize: 9,
      fontColor: "#555555",
      content: metaText,
    } as Template["schemas"][0][0]);
    inputs.metadata = metaText;
    cursorY += Math.min(40, 6 + Object.keys(data.metadata).length * 5) + 6;
  }

  // Metrics as table schema (pdfme table requires head + headWidthPercentages)
  if (data.metricsTable?.length) {
    const bodyRows = data.metricsTable.map((r) => [
      r.label,
      r.value,
      r.unit ?? "",
    ]);
    schemas[0]!.push({
      name: "metrics",
      type: "table",
      position: { x: 15, y: cursorY },
      width: 180,
      height: 12 + data.metricsTable.length * 8,
      content: JSON.stringify(bodyRows),
      showHead: true,
      head: ["Label", "Value", "Unit"],
      headWidthPercentages: [40, 40, 20],
      tableStyles: { borderWidth: 0.3, borderColor: "#cccccc" },
      headStyles: {
        fontSize: 10,
        fontColor: "#ffffff",
        backgroundColor: "#2980ba",
        borderWidth: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: { top: 3, right: 3, bottom: 3, left: 3 },
      },
      bodyStyles: {
        fontSize: 9,
        fontColor: "#333333",
        borderColor: "#dddddd",
        alternateBackgroundColor: "#f7f9fc",
        borderWidth: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
        padding: { top: 3, right: 3, bottom: 3, left: 3 },
      },
      columnStyles: {},
    } as Template["schemas"][0][0]);
    // Generator input: 2D body rows (head comes from schema)
    inputs.metrics = bodyRows;
    cursorY += 12 + data.metricsTable.length * 8 + 8;
  }

  // Content sections (cap to keep within a couple of pages in one schema page;
  // pdfme will flow within field heights)
  let sectionIdx = 0;
  for (const section of (data.contentSections ?? []).slice(0, 8)) {
    if (cursorY > 250) break;
    const headingName = `h_${sectionIdx}`;
    const bodyName = `b_${sectionIdx}`;
    schemas[0]!.push({
      name: headingName,
      type: "text",
      position: { x: 15, y: cursorY },
      width: 180,
      height: 8,
      fontSize: 12,
      fontColor: "#1a1a2e",
      content: section.heading,
    } as Template["schemas"][0][0]);
    inputs[headingName] = section.heading;
    cursorY += 10;

    const body =
      section.body +
      (section.bullets?.length ? "\n" + section.bullets.map((b) => `• ${b}`).join("\n") : "");
    const bodyHeight = Math.min(50, 10 + Math.ceil(body.length / 90) * 4);
    schemas[0]!.push({
      name: bodyName,
      type: "text",
      position: { x: 15, y: cursorY },
      width: 180,
      height: bodyHeight,
      fontSize: 9,
      fontColor: "#333333",
      content: body.slice(0, 2000),
    } as Template["schemas"][0][0]);
    inputs[bodyName] = body.slice(0, 2000);
    cursorY += bodyHeight + 6;
    sectionIdx++;
  }

  const template: Template = {
    basePdf,
    schemas,
  };

  // Plugins required for text / table / line schema types
  const pdf = await generate({
    template,
    inputs: [inputs],
    plugins: { text, table, line },
  });

  return pdf;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
