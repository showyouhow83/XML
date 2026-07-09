-- Client mailboxes to collect from. IMAP passwords are stored encrypted (AES-GCM).
CREATE TABLE IF NOT EXISTS mailboxes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT,                        -- friendly name (client name)
  email          TEXT UNIQUE NOT NULL,        -- the mailbox address
  host           TEXT NOT NULL,               -- e.g. imap.gmail.com
  port           INTEGER NOT NULL DEFAULT 993,
  username       TEXT NOT NULL,               -- usually same as email
  password_enc   TEXT NOT NULL,               -- AES-GCM encrypted, base64
  use_ssl        INTEGER NOT NULL DEFAULT 1,
  lookback_days  INTEGER NOT NULL DEFAULT 30, -- how far back to search on each run
  active         INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_status    TEXT,                        -- 'ok' or an error message
  created_at     TEXT NOT NULL
);

-- One row per extracted electronic invoice (Costa Rica Hacienda comprobante).
-- Kept lean so listing / sorting stays fast; raw XML + PDF live in `attachments`.
CREATE TABLE IF NOT EXISTS invoices (
  clave              TEXT PRIMARY KEY,   -- 50-digit Hacienda key, unique per document
  doc_type           TEXT,               -- Factura, Nota de Crédito, Tiquete, ...
  doc_type_raw       TEXT,               -- original XML root element name
  consecutivo        TEXT,
  fecha_emision      TEXT,               -- ISO datetime from the XML
  emisor_nombre      TEXT,
  emisor_id          TEXT,
  receptor_nombre    TEXT,
  receptor_id        TEXT,
  moneda             TEXT,               -- CRC, USD, ...
  total_gravado      REAL,
  total_exento       REAL,
  total_descuentos   REAL,
  total_venta_neta   REAL,
  total_impuesto     REAL,
  total_comprobante  REAL,               -- grand total
  source_account     TEXT,               -- which mailbox it came from
  message_uid        TEXT,               -- IMAP UID it was found in
  xml_filename       TEXT,
  pdf_filename       TEXT,
  has_pdf            INTEGER NOT NULL DEFAULT 0,
  received_at        TEXT,               -- email date (ISO)
  created_at         TEXT NOT NULL
);

-- Raw file contents, fetched only when a user downloads them.
CREATE TABLE IF NOT EXISTS attachments (
  clave        TEXT PRIMARY KEY,
  xml_content  TEXT,                     -- raw XML text
  pdf_content  TEXT,                     -- base64-encoded PDF bytes
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_fecha   ON invoices(fecha_emision);
CREATE INDEX IF NOT EXISTS idx_invoices_emisor  ON invoices(emisor_id);
CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(source_account);
