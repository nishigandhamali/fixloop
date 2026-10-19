import { extractText, getDocumentProxy } from "unpdf";
import { AppError } from "../../errors.js";

export const ALLOWED_TYPES = ["application/pdf", "text/plain"] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];
export const MAX_PAGES = 200;
const PDF_TIMEOUT_MS = 15_000;

/** Validates the bytes rather than trusting the declared type or extension. */
export function sniffType(declared: string, bytes: Buffer): AllowedType {
  const base = declared.split(";")[0]!.trim().toLowerCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(base)) throw new AppError("UNSUPPORTED_MEDIA_TYPE", "Only PDF and plain-text documents are accepted", 415);
  const isPdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
  if (base === "application/pdf" && !isPdf) throw new AppError("MALFORMED_PDF", "File is not a valid PDF", 422);
  if (base === "text/plain" && isPdf) throw new AppError("CONTENT_TYPE_MISMATCH", "File content does not match the declared type", 422);
  return base as AllowedType;
}

export async function extractPages(type: AllowedType, bytes: Buffer): Promise<string[]> {
  let pages: string[];
  if (type === "text/plain") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AppError("INVALID_TEXT", "Text must be valid UTF-8", 422); }
    if (text.includes("\u0000")) throw new AppError("INVALID_TEXT", "Text contains binary data", 422);
    pages = text.split("\f");
  } else {
    try {
      const work = (async () => {
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        if (pdf.numPages > MAX_PAGES) throw new AppError("DOCUMENT_TOO_LONG", `PDF exceeds ${MAX_PAGES} pages`, 422);
        const { text } = await extractText(pdf, { mergePages: false });
        return text;
      })();
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new AppError("EXTRACTION_TIMEOUT", "PDF extraction timed out", 422)), PDF_TIMEOUT_MS); });
      pages = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("MALFORMED_PDF", "PDF could not be parsed", 422);
    }
  }
  if (pages.every((p) => p.trim() === "")) throw new AppError("EMPTY_DOCUMENT", "No extractable text (scanned documents need OCR, which is not supported)", 422);
  return pages;
}
