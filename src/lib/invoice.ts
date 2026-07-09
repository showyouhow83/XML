// Extracts financial fields from Costa Rica "Hacienda" electronic-invoice XML
// (Factura Electrónica v4.x and related comprobantes). Pure logic — no I/O — so
// it runs identically in the Cloudflare Worker and in the Node collector, and is
// easy to unit-test.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  removeNSPrefix: true, // strip xmlns prefixes so tag names are clean
  parseTagValue: false, // keep values as strings — the 50-digit Clave must not become a float
  trimValues: true,
});

// Root element -> human-readable document type.
const DOC_TYPES: Record<string, string> = {
  FacturaElectronica: 'Factura Electrónica',
  TiqueteElectronico: 'Tiquete Electrónico',
  NotaCreditoElectronica: 'Nota de Crédito',
  NotaDebitoElectronica: 'Nota de Débito',
  FacturaElectronicaCompra: 'Factura de Compra',
  FacturaElectronicaExportacion: 'Factura de Exportación',
  ReciboElectronicoPago: 'Recibo de Pago',
};

// Acceptance/response messages — not invoices, skipped by the collector.
const MESSAGE_TYPES = new Set(['MensajeReceptor', 'MensajeHacienda']);

export interface ExtractedInvoice {
  clave: string;
  docType: string;
  docTypeRaw: string;
  consecutivo: string | null;
  fechaEmision: string | null;
  emisorNombre: string | null;
  emisorId: string | null;
  receptorNombre: string | null;
  receptorId: string | null;
  moneda: string | null;
  totalGravado: number | null;
  totalExento: number | null;
  totalDescuentos: number | null;
  totalVentaNeta: number | null;
  totalImpuesto: number | null;
  totalComprobante: number | null;
}

export type ExtractResult =
  | { status: 'invoice'; invoice: ExtractedInvoice }
  | { status: 'skipped'; docType: string; reason: string }
  | { status: 'invalid'; reason: string };

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null; // objects/arrays aren't scalar text
}

function num(v: unknown): number | null {
  const s = text(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Sum every numeric field on `obj` whose key matches `re` (handles the many
// TotalServGravados / TotalMercanciasGravadas / TotalServExentos variants).
function sumMatching(obj: Record<string, unknown> | undefined, re: RegExp): number | null {
  if (!obj || typeof obj !== 'object') return null;
  let sum = 0;
  let found = false;
  for (const [key, value] of Object.entries(obj)) {
    if (re.test(key)) {
      const n = num(value);
      if (n != null) {
        sum += n;
        found = true;
      }
    }
  }
  return found ? sum : null;
}

// Prefer the pre-computed aggregate (e.g. TotalGravado) if the XML provides it;
// otherwise sum the component fields. Avoids double-counting aggregate + parts.
function aggregate(resumen: Record<string, any>, exactKey: string, re: RegExp): number | null {
  const exact = num(resumen[exactKey]);
  if (exact != null) return exact;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resumen)) if (k !== exactKey) rest[k] = v;
  return sumMatching(rest, re);
}

export function extractInvoice(xml: string): ExtractResult {
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    return { status: 'invalid', reason: `XML parse error: ${(err as Error).message}` };
  }

  const rootKey = Object.keys(root).find((k) => k in DOC_TYPES || MESSAGE_TYPES.has(k));
  if (!rootKey) {
    const seen = Object.keys(root)[0] ?? '(empty)';
    return { status: 'invalid', reason: `Unrecognized root element: ${seen}` };
  }

  if (MESSAGE_TYPES.has(rootKey)) {
    return { status: 'skipped', docType: rootKey, reason: 'Hacienda acceptance message, not an invoice' };
  }

  const doc = root[rootKey] as Record<string, any>;
  const clave = text(doc.Clave);
  if (!clave) {
    return { status: 'invalid', reason: `${rootKey} has no <Clave>` };
  }

  const resumen: Record<string, any> = doc.ResumenFactura ?? {};
  const moneda =
    text(resumen?.CodigoTipoMoneda?.CodigoMoneda) ?? text(resumen?.CodigoMoneda) ?? null;

  const invoice: ExtractedInvoice = {
    clave,
    docType: DOC_TYPES[rootKey],
    docTypeRaw: rootKey,
    consecutivo: text(doc.NumeroConsecutivo),
    fechaEmision: text(doc.FechaEmision),
    emisorNombre: text(doc.Emisor?.Nombre),
    emisorId: text(doc.Emisor?.Identificacion?.Numero),
    receptorNombre: text(doc.Receptor?.Nombre),
    receptorId: text(doc.Receptor?.Identificacion?.Numero),
    moneda,
    totalGravado: aggregate(resumen, 'TotalGravado', /Gravad/i),
    totalExento: aggregate(resumen, 'TotalExento', /Exent/i),
    totalDescuentos: num(resumen.TotalDescuentos),
    totalVentaNeta: num(resumen.TotalVentaNeta),
    totalImpuesto: num(resumen.TotalImpuesto),
    totalComprobante: num(resumen.TotalComprobante),
  };

  return { status: 'invoice', invoice };
}
