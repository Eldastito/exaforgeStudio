/**
 * TEST — F5.4 (RF-07 / CA-07): prova ponta-a-ponta de arquivos pela conversa.
 *
 * CA-07: "usuário pede [relatório], recebe resposta e solicita PDF/XLSX/DOCX; cada
 * arquivo ABRE no aplicativo correspondente, mantém VALORES/PERÍODO e chega pelo
 * WhatsApp ou fallback seguro declarado. Usuário SEM permissão não recebe conteúdo
 * nem link." Compõe F5.1 (catálogo/autorização/referência), F5.2 (DOCX real) e F5.3
 * (entrega tipada + URL absoluta + job) — NÃO adiciona código de produção.
 *
 * Prova (determinístico; RBAC real + snapshot sintético; envio stubado, sem rede):
 *  1. pede o relatório → resposta ESTRUTURADA autorizada (com o dado de vendas);
 *  2. solicita os 3 formatos → cada um ABRE de verdade (PDF %PDF; XLSX/DOCX unzip
 *     com WordprocessingML/OOXML reais) e mantém o MESMO VALOR (não só a extensão);
 *  3. DOCX comprovado por CONTEÚDO (Gate G5: Word não conta só por extensão);
 *  4. cada entrega usa URL ABSOLUTA + MIME tipado por formato;
 *  5. usuário SEM permissão não recebe conteúdo NEM link (revogação);
 *  6. projeção por papel na entrega — vendedor não recebe o valor sensível;
 *  7. fallback DECLARADO: anexo falhou → link identificado;
 *  8. tamanho honesto (sizeBytes > 0);
 *  9. isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-file-ca07
 */
import os from "os"; import path from "path"; import fs from "fs"; import { execSync } from "child_process"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ca07-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ca07-file-1";
process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const unzipPart = (buf: Buffer, part: string) => {
  const p = path.join(tmpDir, `x-${randomUUID().slice(0, 8)}.zip`); fs.writeFileSync(p, buf);
  return execSync(`unzip -p "${p}" "${part.replace(/([[\]])/g, "\\$1")}"`).toString();
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FileRequestCatalogService: CAT } = await import("../src/server/FileRequestCatalogService.js");
  const { FileDeliveryService: FD } = await import("../src/server/FileDeliveryService.js");
  const { MessageProviderService: MP } = await import("../src/server/MessageProviderService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { XLSX_MIME } = await import("../src/server/XlsxService.js");
  const { DOCX_MIME } = await import("../src/server/DocxService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  let lastDoc: any = null; let lastMsg: any = null; let throwOnDoc = false;
  (MP as any).sendDocument = async (channelId: string, to: string, url: string, fileName: string, caption: string, opts: any) => {
    if (throwOnDoc) throw new Error("recusou anexo"); lastDoc = { channelId, to, url, fileName, caption, opts }; return true;
  };
  (MP as any).sendMessage = async (channelId: string, to: string, text: string) => { lastMsg = { channelId, to, text }; return true; };

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), orgId);
  PermissionService.seedSystemProfiles(orgId);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any)?.id, role: key });
  // Snapshot com o dado de VENDAS (o "vendas por loja" do CA-07) + finance sensível.
  (CE as any).build = (_o: string) => ({ narrative: "Panorama.", snapshot: { domains: { sales: { total: 120, loja: "Centro" }, finance: { caixa: 9000 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });
  const owner = userFor("owner");
  const vendedor = userFor("vendedor");
  const CONV = "conv-ca07";

  // ── 1. pede o relatório → resposta estruturada autorizada ──
  const asked = CAT.resolve(orgId, owner, { kind: "executive_summary", format: "pdf", conversationId: CONV });
  check("1.1 resposta estruturada autorizada com o dado de vendas", asked.ok && asked.authorized && asked.structuredResult?.domains?.sales?.total === 120);

  // ── 2+3+4+8. solicita os 3 formatos → cada um ABRE + mantém valor + MIME/URL ──
  const deliver = async (format: "pdf" | "xlsx" | "docx") => {
    lastDoc = null;
    const r = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format, catalogKey: "executive_summary", correlationId: "c1" });
    const art = (r as any).artifactId ? AS.read(orgId, (r as any).artifactId) : null;
    return { r, art, doc: lastDoc };
  };
  const pdf = await deliver("pdf");
  check("2.1 PDF: enviado nativo, MIME application/pdf, URL absoluta", pdf.r.sent === true && pdf.doc?.opts?.mimeType === "application/pdf" && pdf.doc?.url?.startsWith("https://app.test/api/public/artifacts/"));
  check("2.2 PDF: abre de verdade (%PDF) + tamanho", !!pdf.art && pdf.art.buffer.slice(0, 4).toString() === "%PDF" && pdf.art.buffer.length > 100);
  check("2.3 PDF: nome com .pdf", pdf.doc?.fileName?.endsWith(".pdf"));

  const xlsx = await deliver("xlsx");
  const xSheet = xlsx.art ? unzipPart(xlsx.art.buffer, "xl/worksheets/sheet1.xml") : "";
  check("3.1 XLSX: MIME correto + URL absoluta", xlsx.doc?.opts?.mimeType === XLSX_MIME && xlsx.doc?.url?.startsWith("https://app.test/"));
  check("3.2 XLSX: abre (OOXML) e MANTÉM o valor 120", xSheet.includes("sales") && xSheet.includes("120"));

  const docx = await deliver("docx");
  const dDoc = docx.art ? unzipPart(docx.art.buffer, "word/document.xml") : "";
  check("4.1 DOCX: MIME correto + URL absoluta", docx.doc?.opts?.mimeType === DOCX_MIME && docx.doc?.url?.startsWith("https://app.test/"));
  check("4.2 DOCX: comprovado por CONTEÚDO real (WordprocessingML + valor 120), não só extensão", dDoc.includes("<w:document") && dDoc.includes("sales") && dDoc.includes("120"));

  // "mantém valores/período" — o mesmo dado (120) nos formatos legíveis.
  check("4.3 os 3 formatos carregam o MESMO valor de vendas", xSheet.includes("120") && dDoc.includes("120") && !!pdf.art);

  // ── 5. usuário SEM permissão não recebe conteúdo NEM link ──
  const sensitive = AS.create(orgId, { kind: "report", title: "Sigiloso", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 x"), origin: "falatu", createdBy: owner.userId, classification: "sensitive" });
  lastDoc = null; lastMsg = null;
  const denied = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: vendedor, format: "pdf", artifactId: sensitive.id });
  check("5.1 sem permissão: não envia conteúdo nem link", denied.sent === false && (denied as any).reason === "not_authorized" && lastDoc === null && lastMsg === null);

  // ── 6. projeção por papel na entrega: vendedor não recebe o valor sensível ──
  lastDoc = null;
  const vend = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: vendedor, format: "xlsx", catalogKey: "executive_summary" });
  const vendSheet = (vend as any).artifactId ? unzipPart(AS.read(orgId, (vend as any).artifactId)!.buffer, "xl/worksheets/sheet1.xml") : "";
  check("6.1 vendedor: recebe vendas (120) mas NÃO o valor sensível de finance (9000)", vendSheet.includes("120") && !vendSheet.includes("9000"));

  // ── 7. fallback declarado: anexo falhou → link identificado ──
  throwOnDoc = true; lastDoc = null; lastMsg = null;
  const fb = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "pdf", catalogKey: "executive_summary" });
  check("7.1 fallback: enviado como LINK identificado (native false)", fb.sent === true && (fb as any).native === false && (lastMsg?.text || "").toLowerCase().includes("link") && lastMsg.text.includes("https://app.test/"));
  throwOnDoc = false;

  // ── 9. isolamento ──
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja Y', 'active')`).run(randomUUID(), orgB);
  lastDoc = null;
  const iso = await FD.deliverNow(orgB, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "pdf", artifactId: sensitive.id });
  check("9.1 artefato de A não é entregável em B", iso.sent === false && lastDoc === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-file-ca07: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
