// AES-GCM encryption for secrets at rest (IMAP passwords), using Web Crypto.
// Works on the Cloudflare Workers runtime and in modern Node.

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Copy into a fresh ArrayBuffer so Web Crypto's BufferSource typing is satisfied
// regardless of the source view's backing buffer.
function ab(u: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(u.byteLength);
  new Uint8Array(copy).set(u);
  return copy;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  }
  return crypto.subtle.importKey('raw', ab(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a UTF-8 string. Output is base64(iv || ciphertext). */
export async function encryptSecret(plain: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(new TextEncoder().encode(plain)))
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return bytesToBase64(packed);
}

/** Decrypt a value produced by encryptSecret. */
export async function decryptSecret(packedB64: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const packed = base64ToBytes(packedB64);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(iv) }, key, ab(ct));
  return new TextDecoder().decode(pt);
}
