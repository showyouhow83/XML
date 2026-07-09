// Extracts financial fields from Costa Rica "Hacienda" electronic-invoice XML
// (Factura Electrónica v4.x and related comprobantes). Pure logic — no I/O — so
// it runs identically in the Cloudflare Worker and in the Node collector, and is
// easy to unit-test.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false, // needed for <OtroTexto codigo="..."> key/value pairs
  attributeNamePrefix: '@_',
  textNodeName: '#text',
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

export interface TaxItem {
  codigo: string | null;
  codigoTarifaIVA: string | null;
  tarifa: number | null; // IVA %
  monto: number | null;
}

export interface InvoiceLine {
  linea: string | null;
  codigoCabys: string | null;
  codigoComercial: string | null;
  detalle: string | null;
  cantidad: number | null;
  unidad: string | null;
  precioUnitario: number | null;
  descuento: number | null;
  subtotal: number | null;
  baseImponible: number | null;
  impuestoTarifa: number | null;
  impuestoMonto: number | null;
  montoTotalLinea: number | null;
  impuestos: TaxItem[];
}

export interface OtroCargo {
  detalle: string | null;
  porcentaje: number | null;
  monto: number | null;
}

// Everything else worth keeping, serialized to JSON in the DB and rendered on
// the invoice detail page.
export interface InvoiceDetail {
  lines: InvoiceLine[];
  otrosCargos: OtroCargo[];
  taxes: TaxItem[]; // summary-level breakdown (TotalDesgloseImpuesto)
  otros: Record<string, string>; // <Otros><OtroTexto codigo="...">value pairs
}

export interface ExtractedInvoice {
  clave: string;
  docType: string;
  docTypeRaw: string;
  consecutivo: string | null;
  fechaEmision: string | null;
  codigoActividad: string | null;
  condicionVenta: string | null;
  emisorNombre: string | null;
  emisorId: string | null;
  emisorEmail: string | null;
  receptorNombre: string | null;
  receptorId: string | null;
  receptorEmail: string | null;
  moneda: string | null;
  tipoCambio: number | null;
  ivaRate: number | null; // representative IVA % (e.g. 13)
  totalGravado: number | null;
  totalExento: number | null;
  totalExonerado: number | null;
  totalDescuentos: number | null;
  totalVentaNeta: number | null;
  totalImpuesto: number | null;
  totalOtrosCargos: number | null;
  totalComprobante: number | null;
  detail: InvoiceDetail;
}

export type ExtractResult =
  | { status: 'invoice'; invoice: ExtractedInvoice }
  | { status: 'skipped'; docType: string; reason: string }
  | { status: 'invalid'; reason: string };

function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && '#text' in (v as any)) return text((v as any)['#text']);
  return null;
}

function num(v: unknown): number | null {
  const s = text(v);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toArray<T = any>(v: unknown): T[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]) as T[];
}

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

function aggregate(resumen: Record<string, any>, exactKey: string, re: RegExp): number | null {
  const exact = num(resumen[exactKey]);
  if (exact != null) return exact;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(resumen)) if (k !== exactKey) rest[k] = v;
  return sumMatching(rest, re);
}

function taxItem(t: any): TaxItem {
  return {
    codigo: text(t?.Codigo),
    codigoTarifaIVA: text(t?.CodigoTarifaIVA),
    tarifa: num(t?.Tarifa),
    monto: num(t?.Monto) ?? num(t?.TotalMontoImpuesto),
  };
}

function extractLine(l: any): InvoiceLine {
  const impuestos = toArray(l?.Impuesto).map(taxItem);
  return {
    linea: text(l?.NumeroLinea),
    codigoCabys: text(l?.CodigoCABYS),
    codigoComercial: text(l?.CodigoComercial?.Codigo),
    detalle: text(l?.Detalle),
    cantidad: num(l?.Cantidad),
    unidad: text(l?.UnidadMedida),
    precioUnitario: num(l?.PrecioUnitario),
    descuento: num(l?.MontoDescuento) ?? num(l?.Descuento?.MontoDescuento),
    subtotal: num(l?.SubTotal),
    baseImponible: num(l?.BaseImponible),
    impuestoTarifa: impuestos.find((t) => t.tarifa != null)?.tarifa ?? null,
    impuestoMonto: num(l?.ImpuestoNeto) ?? (impuestos.reduce((s, t) => s + (t.monto ?? 0), 0) || null),
    montoTotalLinea: num(l?.MontoTotalLinea),
    impuestos,
  };
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
  if (!clave) return { status: 'invalid', reason: `${rootKey} has no <Clave>` };

  const resumen: Record<string, any> = doc.ResumenFactura ?? {};
  const moneda = text(resumen?.CodigoTipoMoneda?.CodigoMoneda) ?? text(resumen?.CodigoMoneda) ?? null;

  const lines = toArray(doc.DetalleServicio?.LineaDetalle).map(extractLine);
  const otrosCargos: OtroCargo[] = toArray(doc.OtrosCargos).map((c: any) => ({
    detalle: text(c?.Detalle),
    porcentaje: num(c?.PorcentajeOC),
    monto: num(c?.MontoCargo),
  }));
  const taxes = toArray(resumen.TotalDesgloseImpuesto).map(taxItem);

  const otros: Record<string, string> = {};
  for (const o of toArray(doc.Otros?.OtroTexto)) {
    const codigo = text((o as any)?.['@_codigo']);
    const val = text(o);
    if (codigo) otros[codigo] = val ?? '';
  }

  const lineRates = lines.map((l) => l.impuestoTarifa).filter((r): r is number => r != null);
  const ivaRate = lineRates.length
    ? Math.max(...lineRates)
    : (taxes.map((t) => t.tarifa).find((r) => r != null) ?? null);

  const invoice: ExtractedInvoice = {
    clave,
    docType: DOC_TYPES[rootKey],
    docTypeRaw: rootKey,
    consecutivo: text(doc.NumeroConsecutivo),
    fechaEmision: text(doc.FechaEmision),
    codigoActividad: text(doc.CodigoActividadEmisor) ?? text(doc.CodigoActividad),
    condicionVenta: text(doc.CondicionVenta),
    emisorNombre: text(doc.Emisor?.Nombre),
    emisorId: text(doc.Emisor?.Identificacion?.Numero),
    emisorEmail: text(doc.Emisor?.CorreoElectronico),
    receptorNombre: text(doc.Receptor?.Nombre),
    receptorId: text(doc.Receptor?.Identificacion?.Numero),
    receptorEmail: text(doc.Receptor?.CorreoElectronico),
    moneda,
    tipoCambio: num(resumen?.CodigoTipoMoneda?.TipoCambio),
    ivaRate,
    totalGravado: aggregate(resumen, 'TotalGravado', /Gravad/i),
    totalExento: aggregate(resumen, 'TotalExento', /Exent/i),
    totalExonerado: num(resumen.TotalExonerado),
    totalDescuentos: num(resumen.TotalDescuentos),
    totalVentaNeta: num(resumen.TotalVentaNeta),
    totalImpuesto: num(resumen.TotalImpuesto),
    totalOtrosCargos: num(resumen.TotalOtrosCargos),
    totalComprobante: num(resumen.TotalComprobante),
    detail: { lines, otrosCargos, taxes, otros },
  };

  return { status: 'invoice', invoice };
}
