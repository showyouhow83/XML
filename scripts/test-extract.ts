// Quick validation of the invoice extractor. Run with: npm run test:extract
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractInvoice } from '../src/lib/invoice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, 'samples');

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const mark = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

for (const file of readdirSync(samplesDir).filter((f) => f.endsWith('.xml'))) {
  const xml = readFileSync(join(samplesDir, file), 'utf8');
  const result = extractInvoice(xml);
  console.log(`\n${file}: ${result.status}`);

  if (file === 'factura.xml') {
    if (result.status !== 'invoice') { check('is invoice', false, result.status); continue; }
    const i = result.invoice;
    check('clave preserved as 50-digit string', i.clave === '50601062600310123456700100001010000000123199999999');
    check('docType', i.docType === 'Factura Electrónica', i.docType);
    check('emisor', i.emisorNombre === 'TECNOLOGIA EJEMPLO SOCIEDAD ANONIMA');
    check('emisorId', i.emisorId === '3101123456', String(i.emisorId));
    check('moneda CRC', i.moneda === 'CRC', String(i.moneda));
    check('totalGravado not double-counted (100000)', i.totalGravado === 100000, String(i.totalGravado));
    check('totalImpuesto 13000', i.totalImpuesto === 13000, String(i.totalImpuesto));
    check('totalComprobante 113000', i.totalComprobante === 113000, String(i.totalComprobante));
  }

  if (file === 'nota-credito-usd.xml') {
    if (result.status !== 'invoice') { check('is invoice', false, result.status); continue; }
    const i = result.invoice;
    check('docType Nota de Crédito', i.docType === 'Nota de Crédito', i.docType);
    check('moneda USD', i.moneda === 'USD', String(i.moneda));
    check('gravado summed from components (1500)', i.totalGravado === 1500, String(i.totalGravado));
    check('exento summed from components (250)', i.totalExento === 250, String(i.totalExento));
    check('descuentos 50', i.totalDescuentos === 50, String(i.totalDescuentos));
    check('totalComprobante 1895', i.totalComprobante === 1895, String(i.totalComprobante));
  }

  if (file === 'mensaje-receptor.xml') {
    check('acknowledgement is skipped', result.status === 'skipped', result.status);
  }
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
