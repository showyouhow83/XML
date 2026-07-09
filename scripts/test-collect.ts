// Reproduces a real Grupo ICE invoice email through the shared collector logic:
// three attachments (<clave>.xml, <clave>_respuesta.xml, <clave>.pdf), all sent
// as application/octet-stream. Run with: npm run test:collect
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRecords, type RawAttachment } from '../collector/core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const facturaXml = readFileSync(join(here, 'samples', 'factura.xml'), 'utf8');
const respuestaXml = readFileSync(join(here, 'samples', 'mensaje-hacienda.xml'), 'utf8');
const CLAVE = '50601062600310123456700100001010000000123199999999';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// Mimic ICE exactly: real invoice XML + a _respuesta acknowledgement + the PDF,
// every part typed application/octet-stream (so only the extension identifies it).
const attachments: RawAttachment[] = [
  { filename: `${CLAVE}.xml`, contentType: 'application/octet-stream', content: Buffer.from(facturaXml) },
  { filename: `${CLAVE}_respuesta.xml`, contentType: 'application/octet-stream', content: Buffer.from(respuestaXml) },
  { filename: `${CLAVE}.pdf`, contentType: 'application/octet-stream', content: Buffer.from('%PDF-1.4 fake') },
];

console.log('\nICE-style email (3 octet-stream attachments):');
const r = buildRecords(attachments, { sourceAccount: 'facturas@acme.cr', messageUid: '99', receivedAt: '2026-06-25T22:27:41Z' });

check('both XMLs detected despite octet-stream mimeType', r.xmlCount === 2, String(r.xmlCount));
check('_respuesta acknowledgement skipped', r.skipped === 1, String(r.skipped));
check('exactly one invoice record produced', r.records.length === 1, String(r.records.length));
if (r.records.length === 1) {
  const rec = r.records[0];
  check('clave extracted', rec.clave === CLAVE, rec.clave);
  check('invoice XML kept (not the respuesta)', rec.xmlFilename === `${CLAVE}.xml`, String(rec.xmlFilename));
  check('PDF paired by identical base name', rec.pdfFilename === `${CLAVE}.pdf`, String(rec.pdfFilename));
  check('PDF bytes captured', typeof rec.pdfContentBase64 === 'string' && rec.pdfContentBase64.length > 0);
  check('totals extracted through buildRecords', rec.totalComprobante === 113000, String(rec.totalComprobante));
}

// Email with an XML but no PDF -> record with no PDF, still valid.
console.log('\nEmail with XML but no PDF:');
const r2 = buildRecords(
  [{ filename: 'factura.xml', contentType: 'text/xml', content: Buffer.from(facturaXml) }],
  { sourceAccount: 'x@y.cr', messageUid: '1', receivedAt: null }
);
check('one record, no PDF', r2.records.length === 1 && r2.records[0].pdfContentBase64 === null);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
