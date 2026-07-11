// PDF storage in R2 (object storage). PDFs are large binaries, so they live in
// R2 as raw bytes rather than base64 in D1 — keeps the database lean and avoids
// D1's 10 GB-per-database cap. XML stays in D1 (small, queried, served directly).

export function pdfKey(clave: string): string {
  return `pdf/${clave}.pdf`;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Store a PDF (given as base64) in R2 under its clave. Returns true on success. */
export async function putPdf(bucket: R2Bucket, clave: string, base64: string): Promise<boolean> {
  try {
    await bucket.put(pdfKey(clave), base64ToBytes(base64), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    return true;
  } catch {
    return false;
  }
}

/** Fetch a PDF's bytes from R2, or null if not present. */
export async function getPdf(bucket: R2Bucket, clave: string): Promise<ArrayBuffer | null> {
  const obj = await bucket.get(pdfKey(clave));
  if (!obj) return null;
  return obj.arrayBuffer();
}
