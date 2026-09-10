/**
 * TEST — F5.2 (RF-07 §13.3): geração de DOCX REAL sem dependência nova + entrega
 * do Resumo Executivo em Word pelo Fala Tu.
 *
 * Valida o container OOXML DE VERDADE com `unzip` (não só bytes de header nem a
 * extensão — Gate G5: Word não conta só por extensão reconhecida):
 *   - buildDocx produz um .docx VÁLIDO (assinatura PK, partes WordprocessingML,
 *     texto real em word/document.xml, XML escapado, negrito/tamanho, sectPr);
 *   - FalaTuReportService(format:'docx') gera o artefato DOCX + link assinado e
 *     HERDA a projeção por papel (vendedor não recebe o valor de finance);
 *   - o arquivo NÃO é um PDF renomeado (magic byte PK, não %PDF; MIME docx).
 *
 * Uso: npm run test:falatu-docx
 */
import os from "os"; import path from "path"; import fs from "fs"; import { execSync } from "child_process"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-docx-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-docx-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const write = (buf: Buffer, name = "t.docx") => { const p = path.join(tmpDir, name); fs.writeFileSync(p, buf); return p; };
const unzipList = (p: string) => execSync(`unzip -l "${p}"`).toString();
// unzip trata [ ] como glob; escapa pra casar o literal "[Content_Types].xml".
const unzipPart = (p: string, part: string) => execSync(`unzip -p "${p}" "${part.replace(/([[\]])/g, "\\$1")}"`).toString();

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { buildDocx, DOCX_MIME } = await import("../src/server/DocxService.js");
  const { FalaTuReportService: FR } = await import("../src/server/FalaTuReportService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // ── 1. buildDocx — container WordprocessingML válido ──
  const buf = buildDocx({
    title: "Relatório & Cia", subtitle: "sub",
    sections: [{ heading: "Seção <A>", lines: ["linha 1", "valor 42"] }], footer: "rodapé",
  });
  check("1.1 assinatura ZIP (PK\\x03\\x04)", buf.slice(0, 4).toString("hex") === "504b0304");
  check("1.2 NÃO é PDF renomeado (não começa com %PDF)", buf.slice(0, 4).toString() !== "%PDF");
  const p = write(buf);
  const list = unzipList(p);
  check("1.3 unzip lista as partes WordprocessingML", ["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every((x) => list.includes(x)));
  const doc = unzipPart(p, "word/document.xml");
  check("1.4 é wordprocessingml (w:document + w:body + sectPr)", doc.includes("<w:document") && doc.includes("<w:body>") && doc.includes("<w:sectPr>"));
  check("1.5 texto real nos parágrafos", doc.includes("<w:t xml:space=\"preserve\">linha 1</w:t>") && doc.includes("valor 42") && doc.includes("rodapé"));
  check("1.6 XML escapado (& e <>)", doc.includes("Relatório &amp; Cia") && doc.includes("Seção &lt;A&gt;"));
  check("1.7 formatação editável (negrito + tamanho no título)", doc.includes("<w:b/>") && doc.includes("<w:sz w:val=\"36\"/>"));
  check("1.8 Content_Types declara o MIME wordprocessingml", unzipPart(p, "[Content_Types].xml").includes("wordprocessingml.document.main+xml"));

  // ── 2. documento vazio ainda é válido ──
  const empty = write(buildDocx({ title: "", sections: [] }), "e.docx");
  check("2.1 documento mínimo abre (tem body + sectPr)", (() => { const d = unzipPart(empty, "word/document.xml"); return d.includes("<w:body>") && d.includes("<w:sectPr>"); })());

  // ── 3. Fala Tu entrega Resumo em DOCX (herda projeção por papel) ──
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), orgId);
  PermissionService.seedSystemProfiles(orgId);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any)?.id, role: key });
  (CE as any).build = (_o: string) => ({ narrative: "n", snapshot: { domains: { finance: { caixa: 9000 }, sales: { total: 120 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });

  const owner = userFor("owner");
  const rOwner = await FR.executiveSummary(orgId, owner, { format: "docx", correlationId: "c1" });
  check("3.1 artefato com MIME docx", rOwner.artifact.mimeType === DOCX_MIME && rOwner.format === "docx");
  const q = new URLSearchParams(rOwner.url!.split("?")[1]);
  const f = AS.resolveSigned(orgId, rOwner.artifact.id, q.get("exp")!, q.get("sig")!);
  check("3.2 entrega DOCX válido (PK, mime docx)", !!f && f.mime === DOCX_MIME && f.buffer.slice(0, 4).toString("hex") === "504b0304");
  const ownerDoc = unzipPart(write(f!.buffer, "owner.docx"), "word/document.xml");
  check("3.3 owner: documento traz finance + valor", ownerDoc.includes("finance") && ownerDoc.includes("9000"));

  const vendedor = userFor("vendedor");
  const rVend = await FR.executiveSummary(orgId, vendedor, { format: "docx" });
  const qv = new URLSearchParams(rVend.url!.split("?")[1]);
  const fv = AS.resolveSigned(orgId, rVend.artifact.id, qv.get("exp")!, qv.get("sig")!);
  const vendDoc = unzipPart(write(fv!.buffer, "vend.docx"), "word/document.xml");
  check("3.4 vendedor: documento NÃO traz o valor de finance (9000) — sem vazamento", !vendDoc.includes("9000"));
  check("3.5 vendedor: nota de omissão no documento", vendDoc.includes("omitidos") || vendDoc.includes("acesso"));

  // ── 4. isolamento multi-tenant ──
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja Y', 'active')`).run(randomUUID(), orgB);
  check("4.1 artefato de A não é visível em B", AS.get(orgB, rOwner.artifact.id) == null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-docx: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
