// Pure attachment -> invoice logic, shared by the collector and the IMAP probe.
// Node-oriented (uses Buffer); kept out of the Worker bundle.
import { extractInvoice, type ExtractedInvoice } from '../src/lib/invoice.ts';

export interface RawAttachment {
  filename?: string;
  contentType?: string;
  content: Buffer;
}

// Everything the extractor found, plus where it came from and the raw files.
export interface OutRecord extends ExtractedInvoice {
  sourceAccount: string;
  messageUid: string | null;
  xmlFilename: string | null;
  xmlContent: string;
  pdfFilename: string | null;
  pdfContentBase64: string | null;
  receivedAt: string | null;
}

// Identify by filename extension first — real senders (e.g. Grupo ICE) mark
// attachments as application/octet-stream, so mimeType alone isn't reliable.
export const isXml = (a: { filename?: string; contentType?: string }) =>
  /\.xml$/i.test(a.filename || '') || /xml/i.test(a.contentType || '');
export const isPdf = (a: { filename?: string; contentType?: string }) =>
  /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.contentType || '');

const baseName = (name = '') => name.replace(/\.[^.]+$/, '').toLowerCase();

/** Find the PDF that belongs to a given XML attachment. */
export function matchPdf(
  xmlName: string,
  clave: string,
  consecutivo: string | null,
  pdfs: Array<{ filename?: string; content: Buffer }>
) {
  if (pdfs.length === 0) return null;
  const base = baseName(xmlName);
  const sameName = pdfs.find((p) => baseName(p.filename) === base); // <clave>.xml <-> <clave>.pdf
  if (sameName) return sameName;
  if (pdfs.length === 1) return pdfs[0];
  const byKey = pdfs.find(
    (p) => (clave && (p.filename || '').includes(clave)) || (consecutivo && (p.filename || '').includes(consecutivo))
  );
  return byKey || null;
}

export interface BuildContext {
  sourceAccount: string;
  messageUid: string | null;
  receivedAt: string | null;
}

export interface BuildResult {
  records: OutRecord[];
  xmlCount: number;
  skipped: number; // XMLs that weren't invoices (e.g. Hacienda _respuesta messages)
}

/** Turn an email's attachments into invoice records, pairing each XML with its PDF. */
export function buildRecords(attachments: RawAttachment[], ctx: BuildContext): BuildResult {
  const xmls = attachments.filter(isXml);
  const pdfs = attachments.filter(isPdf).map((p) => ({ filename: p.filename, content: p.content }));
  const records: OutRecord[] = [];
  let skipped = 0;

  for (const xml of xmls) {
    const xmlText = xml.content.toString('utf8');
    const result = extractInvoice(xmlText);
    if (result.status !== 'invoice') {
      skipped++;
      continue;
    }
    const inv = result.invoice;
    const pdf = matchPdf(xml.filename || '', inv.clave, inv.consecutivo, pdfs);
    records.push({
      ...inv,
      sourceAccount: ctx.sourceAccount,
      messageUid: ctx.messageUid,
      xmlFilename: xml.filename || null,
      xmlContent: xmlText,
      pdfFilename: pdf?.filename || null,
      pdfContentBase64: pdf ? pdf.content.toString('base64') : null,
      receivedAt: ctx.receivedAt,
    });
  }

  return { records, xmlCount: xmls.length, skipped };
}
