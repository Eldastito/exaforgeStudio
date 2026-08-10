/**
 * XlsxService — PRD 1 Fase 2.3 (§14): geração de planilha .xlsx SEM dependência
 * nova. O repo não tinha lib de xlsx e depender de uma transitiva (archiver) é
 * frágil; então escrevemos um .xlsx mínimo mas VÁLIDO à mão:
 *   - OOXML mínimo (Content_Types + rels + workbook + worksheet, strings inline);
 *   - container ZIP com entradas STORED (sem compressão) + CRC32 próprio.
 * Determinístico (data DOS fixa → mesmo input dá mesmo byte a byte), roda em CI,
 * abre no Excel/LibreOffice/Sheets. Escopo: texto e número por célula (o que os
 * exports do ZapFlow precisam). Estilos/fórmulas ficam pra quando forem pedidos.
 */

export type CellValue = string | number | null | undefined;
export interface XlsxSheet { name: string; rows: CellValue[][]; }

// CRC32 (tabela padrão IEEE) — próprio, pra não depender de zlib.crc32 nem de lib.
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01 (fixo → determinístico)

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Letra da coluna (0→A, 25→Z, 26→AA…). */
function colLetter(i: number): string {
  let s = "";
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function sheetXml(rows: CellValue[][]): string {
  const out: string[] = [];
  rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((val, c) => {
      if (val === null || val === undefined || val === "") return;
      const ref = `${colLetter(c)}${r + 1}`;
      if (typeof val === "number" && Number.isFinite(val)) {
        cells.push(`<c r="${ref}" t="n"><v>${val}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(val))}</t></is></c>`);
      }
    });
    out.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out.join("")}</sheetData></worksheet>`;
}

/** Constrói o buffer .xlsx a partir de N planilhas (nome + linhas). */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  const list = (sheets && sheets.length ? sheets : [{ name: "Planilha1", rows: [] }]);
  const files: { name: string; data: Buffer }[] = [];

  files.push({ name: "[Content_Types].xml", data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `</Types>`, "utf-8") });

  files.push({ name: "_rels/.rels", data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`, "utf-8") });

  files.push({ name: "xl/workbook.xml", data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    list.map((s, i) => `<sheet name="${xmlEscape(String(s.name || `Planilha${i + 1}`)).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    `</sheets></workbook>`, "utf-8") });

  files.push({ name: "xl/_rels/workbook.xml.rels", data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `</Relationships>`, "utf-8") });

  list.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows || []), "utf-8") }));

  // ── Container ZIP (STORED, sem compressão) ──
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(0, 8);       // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);   // compressed = uncompressed (stored)
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra len
    nameBuf.copy(local, 30);
    locals.push(local, f.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);    // version made by
    central.writeUInt16LE(20, 6);    // version needed
    central.writeUInt16LE(0, 8);     // flags
    central.writeUInt16LE(0, 10);    // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);    // extra len
    central.writeUInt16LE(0, 32);    // comment len
    central.writeUInt16LE(0, 34);    // disk start
    central.writeUInt16LE(0, 36);    // internal attrs
    central.writeUInt32LE(0, 38);    // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + f.data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const localAll = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);          // disk
  eocd.writeUInt16LE(0, 6);          // cd start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localAll.length, 16); // cd offset = after all locals
  eocd.writeUInt16LE(0, 20);         // comment len

  return Buffer.concat([localAll, centralDir, eocd]);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
