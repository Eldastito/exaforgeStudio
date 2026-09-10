/**
 * TEST — F5.3 (RF-07 §13.3/§13.4): entrega tipada por MIME + URL absoluta + job.
 *
 * Prova, offline (tmp db, sendDocument/sendMessage stubados — sem rede), que a
 * entrega de arquivo pela conversa:
 *   - manda o MIME CERTO por formato (docx não sai como application/pdf);
 *   - usa URL assinada ABSOLUTA (APP_URL) — o provedor baixa server-to-server;
 *   - gera o do catálogo (executive_summary) OU localiza um artefato existente;
 *   - REVALIDA a autorização na entrega (revogação → não envia nem conteúdo nem
 *     link);
 *   - fallback DECLARADO: anexo nativo falhou → manda o LINK identificado;
 *   - sem APP_URL não inventa link quebrado (no_public_base);
 *   - consulta de domínio pendente não gera nada (honesto);
 *   - enqueue cria job durável na JobQueueService (deliver_file).
 *
 * Uso: npm run test:falatu-file-delivery
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-file-deliv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-file-deliv-1";
process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FileDeliveryService: FD } = await import("../src/server/FileDeliveryService.js");
  const { MessageProviderService: MP } = await import("../src/server/MessageProviderService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { JobQueueService: JQ } = await import("../src/server/JobQueueService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { XLSX_MIME } = await import("../src/server/XlsxService.js");
  const { DOCX_MIME } = await import("../src/server/DocxService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // Stubs de envio — capturam a última chamada (sem tocar em rede).
  let lastDoc: any = null; let lastMsg: any = null; let throwOnDoc = false;
  (MP as any).sendDocument = async (channelId: string, to: string, url: string, fileName: string, caption: string, opts: any) => {
    if (throwOnDoc) throw new Error("provedor recusou anexo");
    lastDoc = { channelId, to, url, fileName, caption, opts }; return true;
  };
  (MP as any).sendMessage = async (channelId: string, to: string, text: string) => { lastMsg = { channelId, to, text }; return true; };

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), orgId);
  PermissionService.seedSystemProfiles(orgId);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, key) as any)?.id, role: key });
  (CE as any).build = (_o: string) => ({ narrative: "n", snapshot: { domains: { finance: { caixa: 9000 }, sales: { total: 120 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });
  const owner = userFor("owner");

  // ── 1. mimeForFormat ──
  check("1.1 MIME por formato", FD.mimeForFormat("pdf") === "application/pdf" && FD.mimeForFormat("xlsx") === XLSX_MIME && FD.mimeForFormat("docx") === DOCX_MIME);

  // ── 2. gerar do catálogo (docx) + entregar com MIME tipado + URL absoluta ──
  lastDoc = null;
  const r1 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "docx", catalogKey: "executive_summary", correlationId: "c1" });
  check("2.1 enviado nativo", r1.sent === true && (r1 as any).native === true);
  check("2.2 MIME tipado docx (não application/pdf)", lastDoc?.opts?.mimeType === DOCX_MIME);
  check("2.3 URL ABSOLUTA (APP_URL) pro artefato", typeof lastDoc?.url === "string" && lastDoc.url.startsWith("https://app.test/api/public/artifacts/"));
  check("2.4 nome do arquivo com extensão .docx", typeof lastDoc?.fileName === "string" && lastDoc.fileName.endsWith(".docx"));
  check("2.5 feature 'falatu' no gate de finalidade", lastDoc?.opts?.feature === "falatu");

  // ── 3. localizar artefato existente + entregar ──
  const art = AS.create(orgId, { kind: "report", title: "Vendas Maio", mimeType: XLSX_MIME, content: Buffer.from("PKxx"), origin: "falatu", createdBy: owner.userId });
  lastDoc = null;
  const r2 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "xlsx", artifactId: art.id });
  check("3.1 entrega o artefato existente com seu MIME", r2.sent === true && lastDoc?.opts?.mimeType === XLSX_MIME && (r2 as any).artifactId === art.id);

  // ── 4. revogação: usuário sem acesso não recebe (nem conteúdo nem link) ──
  const sensitive = AS.create(orgId, { kind: "report", title: "Sigiloso", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4"), origin: "falatu", createdBy: owner.userId, classification: "sensitive" });
  const vendedor = userFor("vendedor");
  lastDoc = null; lastMsg = null;
  const r3 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: vendedor, format: "pdf", artifactId: sensitive.id });
  check("4.1 sem acesso → não envia + reason not_authorized", r3.sent === false && (r3 as any).reason === "not_authorized" && lastDoc === null && lastMsg === null);

  // ── 5. fallback declarado: anexo nativo falhou → manda o LINK ──
  throwOnDoc = true; lastDoc = null; lastMsg = null;
  const r4 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "xlsx", artifactId: art.id });
  check("5.1 fallback: enviado como LINK (native false)", r4.sent === true && (r4 as any).native === false);
  check("5.2 mensagem identifica que é LINK + traz a URL", typeof lastMsg?.text === "string" && lastMsg.text.toLowerCase().includes("link") && lastMsg.text.includes("https://app.test/"));
  throwOnDoc = false;

  // ── 6. sem APP_URL não inventa link quebrado ──
  const savedAppUrl = process.env.APP_URL; delete process.env.APP_URL;
  lastDoc = null; lastMsg = null;
  const r5 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "xlsx", artifactId: art.id });
  check("6.1 sem APP_URL → reason no_public_base, não envia", r5.sent === false && (r5 as any).reason === "no_public_base" && lastDoc === null);
  process.env.APP_URL = savedAppUrl;

  // ── 7. consulta de domínio pendente não gera nada ──
  const r6 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "pdf", catalogKey: "sales_by_period" });
  check("7.1 pending_domain_query → nada gerado/enviado", r6.sent === false && (r6 as any).reason === "pending_domain_query");

  // ── 8. enqueue cria job durável ──
  const jobId = FD.enqueue(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "docx", catalogKey: "executive_summary" });
  const job = JQ.get(jobId);
  check("8.1 job deliver_file enfileirado", !!job && job.type === "deliver_file" && job.organization_id === orgId);

  // ── 9. isolamento ──
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja Y', 'active')`).run(randomUUID(), orgB);
  lastDoc = null;
  const r7 = await FD.deliverNow(orgB, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "xlsx", artifactId: art.id });
  check("9.1 artefato de A não é entregável em B", r7.sent === false && lastDoc === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-file-delivery: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
