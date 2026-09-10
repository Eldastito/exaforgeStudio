/**
 * XlsxService — PRD 1 Fase 2.3 (§14): geração de planilha .xlsx SEM dependência
 * nova. O repo não tinha lib de xlsx e depender de uma transitiva (archiver) é
 * frágil; então escrevemos um .xlsx mínimo mas VÁLIDO à mão:
 *   - OOXML mínimo (Content_Types + rels + workbook + worksheet, strings inline);
 *   - container ZIP STORED + CRC32 pelo helper compartilhado `ooxmlZip` (mesmo
 *     empacotador do DOCX F5.2 — sem duplicar).
 * Determinístico (data DOS fixa → mesmo input dá mesmo byte a byte), roda em CI,
 * abre no Excel/LibreOffice/Sheets. Escopo: texto e número por célula (o que os
 * exports do ZapFlow precisam). Estilos/fórmulas ficam pra quando forem pedidos.
 */
import { zipStored, xmlEscape } from "./ooxmlZip.js";

export type CellValue = string | number | null | undefined;
export interface XlsxSheet { name: string; rows: CellValue[][]; }

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

  return zipStored(files); // container OOXML (STORED) pelo empacotador compartilhado
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
