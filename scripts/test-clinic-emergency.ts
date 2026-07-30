/**
 * TESTE — Módulo Clínica Fase 18: fixes emergenciais
 * ---------------------------------------------------
 * Consolida em uma única suíte a verificação dos 4 achados críticos que a
 * auditoria da Fatia 18 pegou em cima do módulo Clínica:
 *
 *   1. Retention cross-tenant: a Fase U lia a RAIZ de `CLINIC_DOCS_DIR` e
 *      apagava PDFs de OUTRAS orgs. Agora cada org tem subpasta própria e a
 *      retention só varre a sua.
 *   2. HMAC de URL assinada colapsava quando `JWT_SECRET` estava vazio (o
 *      segredo derivado virava público). Passamos a usar o `JWT_SECRET`
 *      resolvido pelo bootstrap — nunca vazio.
 *   3. RBAC ausente em rotas de alto blast-radius: emitir receita/atestado,
 *      gerar/revogar portal token, checar pin-status. Todas passam a exigir
 *      owner/admin — a auditoria do middleware `requireRole` valida.
 *   4. Portal do paciente ignorava revoke de consent — token continuava
 *      servindo receitas por até 30 dias após o titular revogar LGPD Art.11.
 *      `resolveToken` agora revalida em cada acesso e `revokeConsent` faz
 *      cascade nos tokens ativos.
 *
 * Uso:  npm run test:clinic-emergency
 */
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-emerg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-fatia-18-emerg-1234567890abcdef";
process.env.APP_URL = "https://test.example.com";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicRetentionService } = await import("../src/server/ClinicRetentionService.js");
  const { ClinicDocumentDeliveryService, CLINIC_DOCS_DIR } = await import("../src/server/ClinicDocumentDeliveryService.js");
  const { ClinicPatientPortalService } = await import("../src/server/ClinicPatientPortalService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { JWT_SECRET } = await import("../src/server/config/secret.js");
  const { requireRole } = await import("../src/server/middleware/auth.js");

  function seedOrg(tag: string, opts: { deliveryDays?: number; enabled?: boolean } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments) VALUES (?, ?, ?, 'active', ?, ?, 7300)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`, opts.enabled === false ? 0 : 1, opts.deliveryDays ?? 30);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e6)}`);
    return { orgId, contactId, channelId, actorId: `user_${tag}` };
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1. Cross-tenant retention isolation
  // ───────────────────────────────────────────────────────────────────────
  const A = seedOrg("A", { deliveryDays: 7 });   // retention agressiva
  const B = seedOrg("B", { deliveryDays: 730 }); // retention frouxa

  const dirA = path.join(CLINIC_DOCS_DIR, A.orgId);
  const dirB = path.join(CLINIC_DOCS_DIR, B.orgId);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const pdfA = path.join(dirA, `${randomUUID()}.pdf`);
  const pdfB = path.join(dirB, `${randomUUID()}.pdf`);
  fs.writeFileSync(pdfA, "%PDF-A-old");
  fs.writeFileSync(pdfB, "%PDF-B-old");
  const past = Date.now() - 60 * 86400_000; // 60 dias
  fs.utimesSync(pdfA, past / 1000, past / 1000);
  fs.utimesSync(pdfB, past / 1000, past / 1000);

  const statsA = ClinicRetentionService.runForOrg(A.orgId);
  check("A com deliveryDays=7 apagou seu PDF antigo", statsA.deliveriesPurged === 1);
  check("A retention não tocou no PDF de B", fs.existsSync(pdfB));
  check("PDF de A foi realmente removido do disco", !fs.existsSync(pdfA));

  const statsB = ClinicRetentionService.runForOrg(B.orgId);
  check("B com deliveryDays=730 não apaga PDF de 60d", statsB.deliveriesPurged === 0);
  check("PDF de B ainda intacto após seu próprio pass", fs.existsSync(pdfB));

  // Regressão: rodar A várias vezes é idempotente
  const statsA2 = ClinicRetentionService.runForOrg(A.orgId);
  check("A: 2ª rodada de retention purgou 0 (idempotência)", statsA2.deliveriesPurged === 0);

  // Isolamento cross-org visto pelo output do dispatch multi-org — o
  // `dispatch()` percorre orgs com pelo menos 1 encounter. Semear um
  // encounter dummy em A pra a org entrar na varredura.
  fs.writeFileSync(pdfA, "%PDF-A-fresh"); // arquivo novo em A
  db.prepare(`INSERT INTO clinical_encounters (id, organization_id, appointment_id, contact_id, status, created_by) VALUES (?, ?, ?, ?, 'draft', ?)`)
    .run(randomUUID(), A.orgId, randomUUID(), A.contactId, A.actorId);
  const disp = ClinicRetentionService.dispatch();
  const dispA = disp[A.orgId] || { deliveriesPurged: 0 };
  check("dispatch inclui org A no output", A.orgId in disp);
  check("dispatch: A não tem PDF antigo pra purgar", dispA.deliveriesPurged === 0);
  check("PDF novo de A preservado (mtime dentro da janela)", fs.existsSync(pdfA));

  // ───────────────────────────────────────────────────────────────────────
  // 2. Legacy orphans migration (PDFs pré-Fatia-18 na raiz)
  // ───────────────────────────────────────────────────────────────────────
  const orphan = path.join(CLINIC_DOCS_DIR, `legacy-${randomUUID()}.pdf`);
  fs.writeFileSync(orphan, "%PDF-legacy");
  // Backdate pra fora da janela de qualquer retention
  const veryOld = Date.now() - 1000 * 86400_000;
  fs.utimesSync(orphan, veryOld / 1000, veryOld / 1000);

  const legacyBefore = ClinicRetentionService.runForOrg(A.orgId);
  check("órfão na raiz NÃO é apagado pela retention de A", fs.existsSync(orphan));
  check("órfão na raiz não conta como delivery de A", legacyBefore.deliveriesPurged === 0);

  const mig = ClinicRetentionService.migrateLegacyPdfs();
  check("migrateLegacyPdfs moveu o órfão", mig.moved >= 1);
  check("órfão original SUMIU da raiz", !fs.existsSync(orphan));
  const orphanNew = path.join(CLINIC_DOCS_DIR, "_legacy_orphans", path.basename(orphan));
  check("órfão foi pra _legacy_orphans/", fs.existsSync(orphanNew));

  // Idempotência: 2ª chamada, nada pra mover (arquivo já saiu)
  const mig2 = ClinicRetentionService.migrateLegacyPdfs();
  check("migrateLegacyPdfs idempotente (2ª chamada moved=0)", mig2.moved === 0);
  check("órfão em _legacy_orphans/ intacto após 2ª chamada", fs.existsSync(orphanNew));

  // Retention de qualquer org ignora _legacy_orphans
  ClinicRetentionService.runForOrg(A.orgId);
  ClinicRetentionService.runForOrg(B.orgId);
  check("_legacy_orphans/ intacto após retention de A e B", fs.existsSync(orphanNew));

  // ───────────────────────────────────────────────────────────────────────
  // 3. JWT_SECRET não vazio & HMAC secret não é o valor público
  // ───────────────────────────────────────────────────────────────────────
  check("JWT_SECRET resolvido tem length >= 32", (JWT_SECRET?.length || 0) >= 32);

  // Se o bug antigo estivesse vivo, o secret seria sha256(":clinical_document_v1")
  // — publicamente reproduzível. Verificamos que a URL atual NÃO valida contra
  // esse secret ruim.
  const badSecret = crypto.createHash("sha256").update(":clinical_document_v1").digest("hex");
  const key = `${A.orgId}/${path.basename(pdfA)}`;
  const url = ClinicDocumentDeliveryService.signedUrl(key);
  const m = /\?exp=(\d+)&sig=([a-f0-9]+)$/.exec(url);
  check("signedUrl gera exp+sig válidos", !!m);
  if (m) {
    const [, expStr, sig] = m;
    const forgedSig = crypto.createHmac("sha256", badSecret).update(`${key}:${expStr}`).digest("hex");
    check("sig atual != sig forjada com secret público (bug C3 fechado)", sig !== forgedSig);
    // resolveSignedFile com sig forjada recusa
    const forgedResolve = ClinicDocumentDeliveryService.resolveSignedFile(key, expStr, forgedSig);
    check("resolveSignedFile recusa sig gerada com secret público", forgedResolve === null);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 4. RBAC — middleware bloqueia agent, deixa passar owner/admin
  // ───────────────────────────────────────────────────────────────────────
  function callMw(role: string): { status: number; body: any; nextCalled: boolean } {
    let status = 200;
    let body: any = null;
    let nextCalled = false;
    const req: any = { user: { role } };
    const res: any = {
      status(s: number) { status = s; return res; },
      json(b: any) { body = b; return res; },
    };
    const next = () => { nextCalled = true; };
    const mw: any = requireRole("owner", "admin");
    mw(req, res, next);
    return { status, body, nextCalled };
  }

  const agentBlock = callMw("agent");
  check("requireRole bloqueia agent com 403", agentBlock.status === 403 && !agentBlock.nextCalled);
  check("requireRole responde JSON com msg", !!agentBlock.body?.error?.includes("insufficient"));

  const ownerAllow = callMw("owner");
  check("requireRole libera owner (next chamado)", ownerAllow.nextCalled && ownerAllow.status === 200);

  const adminAllow = callMw("admin");
  check("requireRole libera admin (next chamado)", adminAllow.nextCalled && adminAllow.status === 200);

  // Sem user → 403 (defesa contra middleware fora de ordem)
  {
    let status = 200; let nextCalled = false;
    const req: any = {};
    const res: any = { status(s: number) { status = s; return res; }, json() { return res; } };
    (requireRole("owner", "admin") as any)(req, res, () => { nextCalled = true; });
    check("requireRole bloqueia request sem user (401/403)", status === 403 && !nextCalled);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 5. Portal do paciente respeita revoke de consent
  // ───────────────────────────────────────────────────────────────────────
  // Reset A: garante consent grants + gera token
  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.contactId, "comunicacoes", { actorId: A.actorId });
  const t1 = ClinicPatientPortalService.generateToken(A.orgId, A.contactId, A.actorId);
  const ctx1 = ClinicPatientPortalService.resolveToken(t1.token);
  check("token resolve com consent OK", !!ctx1 && ctx1.contactId === A.contactId);

  // Revoke sensitive → resolveToken retorna null (re-check no service)
  LgpdService.revokeConsent(A.orgId, A.contactId, "dados_sensiveis", A.actorId);
  const ctx2 = ClinicPatientPortalService.resolveToken(t1.token);
  check("resolveToken retorna null após revoke de dados_sensiveis", ctx2 === null);

  // Cascade também marcou active=0 no DB
  const row1 = db.prepare(`SELECT active FROM patient_portal_tokens WHERE id = ?`).get(t1.id) as any;
  check("cascade LGPD marcou patient_portal_tokens.active = 0", Number(row1?.active) === 0);

  // Audit event da cascade
  const auditCascade = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PATIENT_PORTAL_REVOKED_CASCADE'`).get(A.orgId) as any;
  check("audit CLINIC_PATIENT_PORTAL_REVOKED_CASCADE gravado ao menos 1×", Number(auditCascade?.c) >= 1);

  // Grant de novo + gera novo token → resolve normal (cascata só matou os antigos)
  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });
  const t2 = ClinicPatientPortalService.generateToken(A.orgId, A.contactId, A.actorId);
  const ctx3 = ClinicPatientPortalService.resolveToken(t2.token);
  check("novo token pós re-grant resolve normalmente", !!ctx3);

  // Revoke comunicacoes também dispara cascade
  LgpdService.revokeConsent(A.orgId, A.contactId, "comunicacoes", A.actorId);
  const ctx4 = ClinicPatientPortalService.resolveToken(t2.token);
  check("resolveToken retorna null após revoke de comunicacoes", ctx4 === null);
  const row2 = db.prepare(`SELECT active FROM patient_portal_tokens WHERE id = ?`).get(t2.id) as any;
  check("cascade também disparou por comunicacoes", Number(row2?.active) === 0);

  // Consent NÃO listado (ex: "marketing") NÃO cascata
  LgpdService.grantConsent(A.orgId, A.contactId, "comunicacoes", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.contactId, "marketing", { actorId: A.actorId });
  const t3 = ClinicPatientPortalService.generateToken(A.orgId, A.contactId, A.actorId);
  LgpdService.revokeConsent(A.orgId, A.contactId, "marketing", A.actorId);
  const ctx5 = ClinicPatientPortalService.resolveToken(t3.token);
  check("revoke de marketing NÃO cascata em portal token", !!ctx5);

  // Isolamento: revoke em A não afeta B
  LgpdService.grantConsent(B.orgId, B.contactId, "dados_sensiveis", { actorId: B.actorId });
  LgpdService.grantConsent(B.orgId, B.contactId, "comunicacoes", { actorId: B.actorId });
  const tB = ClinicPatientPortalService.generateToken(B.orgId, B.contactId, B.actorId);
  LgpdService.revokeConsent(A.orgId, A.contactId, "dados_sensiveis", A.actorId);
  const ctxB = ClinicPatientPortalService.resolveToken(tB.token);
  check("revoke em A não afeta token de B (isolamento cross-org)", !!ctxB);

  // ───────────────────────────────────────────────────────────────────────
  console.log("\n=== Fatia 18 — fixes emergenciais (ADR-080) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
