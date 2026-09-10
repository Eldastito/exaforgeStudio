/**
 * DocxService — PRD WhatsApp Unificado F5.2 (RF-07 §13.3): geração de DOCX REAL,
 * SEM dependência nova. O HEAD tinha PDF (pdfkit) e XLSX (à mão), mas NENHUM
 * gerador de Word — só o mapa MIME→ext do ArtifactService. Aqui escrevemos um
 * `.docx` mínimo mas VÁLIDO e EDITÁVEL (OOXML WordprocessingML), empacotado pelo
 * MESMO container do XLSX (`ooxmlZip`, STORED/determinístico):
 *   - `[Content_Types].xml` + `_rels/.rels` + `word/document.xml`;
 *   - parágrafos reais (título/subtítulo/seções com heading/linhas/rodapé),
 *     runs com negrito e tamanho — abre e edita no Word/LibreOffice/Google Docs.
 * NUNCA renomeia PDF/HTML pra `.docx` (§13.3): é wordprocessingml de verdade,
 * com MIME/extensão corretos. Escopo: texto formatado por parágrafo (o que os
 * relatórios do ZapFlow precisam); tabelas/imagens ficam pra quando forem pedidas.
 */
import { zipStored, xmlEscape } from "./ooxmlZip.js";

export interface DocxSection { heading?: string; lines: string[]; }
export interface DocxInput {
  title: string;
  subtitle?: string;
  sections: DocxSection[];
  footer?: string;
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Tamanhos em HALF-POINTS (w:sz) — 36=18pt (título), 28=14pt (heading), 22=11pt
// (corpo), 18=9pt (rodapé). Negrito via <w:b/>.
function paragraph(text: string, opts: { bold?: boolean; italic?: boolean; sz?: number } = {}): string {
  const rPr: string[] = [];
  if (opts.bold) rPr.push("<w:b/>");
  if (opts.italic) rPr.push("<w:i/>");
  if (opts.sz) rPr.push(`<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : "";
  return `<w:p><w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

/** Constrói o buffer .docx a partir de título + seções (heading + linhas). */
export function buildDocx(input: DocxInput): Buffer {
  const body: string[] = [];
  body.push(paragraph(input.title || "Documento", { bold: true, sz: 36 }));
  if (input.subtitle) body.push(paragraph(input.subtitle, { italic: true, sz: 22 }));
  for (const s of input.sections || []) {
    if (s.heading) body.push(paragraph(s.heading, { bold: true, sz: 28 }));
    for (const line of s.lines || []) body.push(paragraph(line, { sz: 22 }));
  }
  if (input.footer) body.push(paragraph(input.footer, { italic: true, sz: 18 }));
  if (body.length === 0) body.push(paragraph("Sem conteúdo.", { sz: 22 }));

  // sectPr fecha o corpo (obrigatório num documento wordprocessingml bem formado).
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`, "utf-8") },
    { name: "_rels/.rels", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`, "utf-8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf-8") },
  ];

  return zipStored(files);
}
