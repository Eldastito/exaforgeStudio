/**
 * TEST — PRD 1 Fase 2.3 (§14/§65): geração de XLSX sem dependência nova + entrega
 * do Resumo Executivo em Excel pelo Fala Tu.
 *
 * Valida o container ZIP/OOXML DE VERDADE com `unzip` (não só os bytes de header):
 *   - buildXlsx produz um .xlsx válido (assinatura PK, partes OOXML, células
 *     numéricas vs inlineStr, XML escapado, multi-planilha);
 *   - FalaTuReportService(format:'xlsx') gera o artefato XLSX + link assinado e
 *     HERDA a projeção por papel (vendedor não recebe a linha de finance).
 *
 * Uso: npm run test:xlsx
 */
import os from "os";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-xlsx-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-xlsx-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const write = (buf: Buffer, name = "t.xlsx") => { const p = path.join(tmpDir, name); fs.writeFileSync(p, buf); return p; };
const unzipList = (p: string) => execSync(`unzip -l "${p}"`).toString();
const unzipPart = (p: string, part: string) => execSync(`unzip -p "${p}" ${part}`).toString();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { buildXlsx, XLSX_MIME } = await import("../src/server/XlsxService.js");
  const { FalaTuReportService: FR } = await import("../src/server/FalaTuReportService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // ===== 1. buildXlsx — container válido =====
  const buf = buildXlsx([{ name: "Resumo", rows: [["Nome", "Qtd"], ["Café & Cia", 42], ["<b>tag</b>", 7], [null, ""]] }]);
  check("1.1 assinatura ZIP (PK\\x03\\x04)", buf.slice(0, 4).toString("hex") === "504b0304");
  const p = write(buf);
  const list = unzipList(p);
  check("1.2 unzip lista as partes OOXML", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"].every((x) => list.includes(x)));
  const sheet = unzipPart(p, "xl/worksheets/sheet1.xml");
  check("1.3 número → célula numérica t=n", sheet.includes('t="n"><v>42</v>'));
  check("1.4 string → inlineStr", sheet.includes('t="inlineStr"'));
  check("1.5 XML escapado (& e <>)", sheet.includes("Café &amp; Cia") && sheet.includes("&lt;b&gt;tag&lt;/b&gt;"));
  check("1.6 nome da planilha no workbook", unzipPart(p, "xl/workbook.xml").includes('name="Resumo"'));

  // ===== 2. multi-planilha =====
  const p2 = write(buildXlsx([{ name: "A", rows: [[1]] }, { name: "B", rows: [[2]] }]), "m.xlsx");
  check("2.1 duas planilhas (sheet2.xml)", unzipList(p2).includes("sheet2.xml"));

  // ===== 3. Fala Tu entrega Resumo em XLSX (herda projeção por papel) =====
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), orgId);
  PermissionService.seedSystemProfiles(orgId);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any)?.id, role: key });
  (CE as any).build = (_o: string) => ({ narrative: "n", snapshot: { domains: { finance: { caixa: 9000 }, sales: { total: 120 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });

  const owner = userFor("owner");
  const rOwner = await FR.executiveSummary(orgId, owner, { format: "xlsx", correlationId: "c1" });
  check("3.1 artefato com MIME xlsx", rOwner.artifact.mimeType === XLSX_MIME && rOwner.format === "xlsx");
  const q = new URLSearchParams(rOwner.url!.split("?")[1]);
  const f = AS.resolveSigned(orgId, rOwner.artifact.id, q.get("exp")!, q.get("sig")!);
  check("3.2 entrega XLSX válido (PK)", !!f && f.buffer.slice(0, 4).toString("hex") === "504b0304");
  const ownerSheet = unzipPart(write(f!.buffer, "owner.xlsx"), "xl/worksheets/sheet1.xml");
  check("3.3 owner: planilha traz finance + valor", ownerSheet.includes("finance") && ownerSheet.includes("9000"));

  const vendedor = userFor("vendedor");
  const rVend = await FR.executiveSummary(orgId, vendedor, { format: "xlsx" });
  const qv = new URLSearchParams(rVend.url!.split("?")[1]);
  const fv = AS.resolveSigned(orgId, rVend.artifact.id, qv.get("exp")!, qv.get("sig")!);
  const vendSheet = unzipPart(write(fv!.buffer, "vend.xlsx"), "xl/worksheets/sheet1.xml");
  // O VALOR sensível (9000) some — sem vazamento. O nome "finance" só aparece na
  // nota de omissão (transparência §49: "isto foi ocultado"), nunca como dado.
  check("3.4 vendedor: planilha NÃO traz o valor de finance (9000) — sem vazamento", !vendSheet.includes("9000"));
  check("3.5 vendedor: planilha traz sales (o que ele pode ver)", vendSheet.includes("sales"));
  check("3.6 vendedor: nota de omissão na planilha", vendSheet.includes("Omitido"));

  console.log("\n=== TEST: XLSX + entrega em Excel (PRD 1 Fase 2.3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ XLSX + entrega em Excel (2.3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
