/**
 * Extract text / metadata from a public PDF URL (SSRF-guarded).
 * Primary: unpdf · Fallback: pdf-lib page count + basic info.
 */

import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import type { ExtractPdfTextInput } from "../types/payload";
import { assertPublicHttpUrl, fetchPublicUrl } from "./ssrf";

export type ExtractPdfTextResult = {
  success: true;
  url: string;
  title?: string;
  author?: string;
  pageCount: number;
  text: string;
  pages: Array<{ page: number; text: string }>;
  engine: "unpdf" | "pdf-lib-meta";
  truncated: boolean;
};

const DEFAULT_MAX_PAGES = 40;
const MAX_TEXT_CHARS = 200_000;

export async function extractPdfTextFromUrl(
  input: ExtractPdfTextInput,
): Promise<ExtractPdfTextResult> {
  const url = assertPublicHttpUrl(input.url);
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;

  const { response } = await fetchPublicUrl(url.toString(), {
    headers: {
      "User-Agent": "CanyonPDF-MCP/1.0 (+https://pdf.canyonai.io)",
      Accept: "application/pdf,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch PDF (${response.status} ${response.statusText}): ${url}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("Fetched PDF is empty");
  }
  if (
    contentType &&
    !contentType.includes("pdf") &&
    !contentType.includes("octet-stream") &&
    bytes[0] !== 0x25 // '%' of %PDF
  ) {
    // Soft warning — some CDNs mislabel; still try if magic looks like PDF
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      throw new Error(`URL does not look like a PDF (content-type: ${contentType || "unknown"})`);
    }
  }

  try {
    const pdf = await getDocumentProxy(bytes);
    const raw = await extractText(pdf, { mergePages: false });
    const pageTexts = Array.isArray(raw.text) ? raw.text : [String(raw.text ?? "")];
    const limited = pageTexts.slice(0, maxPages).map((t, i) => ({
      page: i + 1,
      text: String(t ?? "").trim(),
    }));
    let text = limited.map((p) => p.text).filter(Boolean).join("\n\n---\n\n");
    let truncated = pageTexts.length > maxPages;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }

    let title: string | undefined;
    let author: string | undefined;
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      title = doc.getTitle() || undefined;
      author = doc.getAuthor() || undefined;
    } catch {
      // ignore metadata failures
    }

    return {
      success: true,
      url: url.toString(),
      title,
      author,
      pageCount: pageTexts.length,
      text,
      pages: limited,
      engine: "unpdf",
      truncated,
    };
  } catch (err) {
    console.error("[extractPdfText] unpdf failed — falling back to pdf-lib metadata", {
      error: err instanceof Error ? err.message : String(err),
    });

    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = doc.getPageCount();
    return {
      success: true,
      url: url.toString(),
      title: doc.getTitle() || undefined,
      author: doc.getAuthor() || undefined,
      pageCount,
      text: "",
      pages: [],
      engine: "pdf-lib-meta",
      truncated: false,
    };
  }
}
