// PDF storage in R2. PDFs are large binaries, so they live in R2 as raw bytes
// rather than base64 in D1 — keeps the database lean and off D1's 10 GB cap.
// Objects are grouped into a folder per mailbox: `<mailbox>/<clave>.pdf`, so a
// client's PDFs sit together (browsable in the R2 dashboard, zippable per client).
// Legacy objects were stored flat at `pdf/<clave>.pdf`; reads fall back to that.

/** Sanitize a mailbox email into a safe R2 folder name. */
export function accountFolder(account: string | null | undefined): string {
  const a = (account || '').trim().toLowerCase();
  return a ? a.replace(/[^a-z0-9._@+-]+/g, '_') : '_unassigned';
}

export function pdfKey(account: string | null | undefined, clave: string): string {
  return `${accountFolder(account)}/${clave}.pdf`;
}

/** Old flat key scheme (pre-foldering). Kept for read fallback + migration. */
export function legacyPdfKey(clave: string): string {
  return `pdf/${clave}.pdf`;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Store a PDF (base64) in R2 under its mailbox folder. Returns true on success. */
export async function putPdf(bucket: R2Bucket, account: string | null | undefined, clave: string, base64: string): Promise<boolean> {
  try {
    await bucket.put(pdfKey(account, clave), base64ToBytes(base64), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    return true;
  } catch {
    return false;
  }
}

/** Fetch a PDF object, trying the mailbox-foldered key then the legacy flat key. */
export async function getPdfObject(
  bucket: R2Bucket,
  account: string | null | undefined,
  clave: string
): Promise<R2ObjectBody | null> {
  return (await bucket.get(pdfKey(account, clave))) ?? (await bucket.get(legacyPdfKey(clave)));
}

export async function getPdf(bucket: R2Bucket, account: string | null | undefined, clave: string): Promise<ArrayBuffer | null> {
  const obj = await getPdfObject(bucket, account, clave);
  return obj ? obj.arrayBuffer() : null;
}

/** Move a PDF from the legacy flat key into its mailbox folder.
 *  Returns 'moved' | 'already' (foldered key exists) | 'missing' (nothing to move). */
export async function foldPdf(bucket: R2Bucket, account: string | null | undefined, clave: string): Promise<'moved' | 'already' | 'missing'> {
  const folded = pdfKey(account, clave);
  if (await bucket.head(folded)) return 'already';
  const legacy = await bucket.get(legacyPdfKey(clave));
  if (!legacy) return 'missing';
  await bucket.put(folded, await legacy.arrayBuffer(), { httpMetadata: { contentType: 'application/pdf' } });
  await bucket.delete(legacyPdfKey(clave));
  return 'moved';
}
