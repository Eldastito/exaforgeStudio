/**
 * TEST — Reputation Health & Hardening (PRD 5 / ADR-162 F14). DB-backed, det., isolado.
 * Prova (§67-69, §84-87):
 *   - report(): saúde por conector (connected/auth_expired/stale) + backlog (casos abertos,
 *     confirmações de resposta pendentes) + rate-limit; status agregado healthy/degraded/blocked;
 *   - RATE-LIMIT (§68): backstop de resposta pública — canReply cai ao atingir o teto e o
 *     publish (F8) recusa com rate_limited ANTES do efeito externo;
 *   - multi-tenant.
 *
 * Uso: npm run test:reputation-health
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-hp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-hp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationReplyService: REPLY } = await import("../src/server/ReputationReplyService.js");
  const { ReputationHealthService: HEALTH } = await import("../src/server/ReputationHealthService.js");
  const { ReputationConnectorService: CONN } = await import("../src/server/ReputationConnectorService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = "org_hp_A", B = "org_hp_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  enableOrg(A); enableOrg(B); mkContact(A, "C1");
  const conn = (org: string) => HEALTH.report(org).connectors.find((c: any) => c.provider === "reclame_aqui")!;

  let n = 0;
  const complaint = (org: string) => {
    const externalId = `RA-${++n}`;
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content: "meu pedido não chegou", basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 2, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: "C1" });
    return sid;
  };
  const publishReply = async (org: string, sid: string) => {
    const d = REPLY.draft(org, sid, { content: "Sentimos muito, vamos verificar.", provider: "stub" })!;
    DA.approve(org, d.action.id, "U1");
    return REPLY.publish(org, d.action.id);
  };

  // ═══════════════ 1. Conector configurado mas SEM sync → stale (degraded) ═══════════════
  CONN.setConfig(A, "reclame_aqui", { baseUrl: "https://x", token: "tkn" }, { enabled: true });
  CONN.recordHealth(A, "reclame_aqui", "connected");
  const r1 = HEALTH.report(A);
  check("1.1 conector configurado+habilitado", conn(A).configured && conn(A).enabled);
  check("1.2 sem sync → stale → status degraded", conn(A).stale === true && r1.status === "degraded");

  // ═══════════════ 2. Após sync → not stale; backlog baixo → healthy ═══════════════
  CONN.setCursor(A, "reclame_aqui", "2026-08-12T00:00:00Z"); // marca last_synced_at
  complaint(A); complaint(A); // 2 casos abertos
  const r2 = HEALTH.report(A);
  check("2.1 não mais stale (sincronizou)", conn(A).stale === false);
  check("2.2 backlog: 2 casos abertos", r2.backlog.openCases === 2);
  check("2.3 status healthy (connected, fresco, backlog baixo, canReply)", r2.status === "healthy");

  // ═══════════════ 3. Resposta publicada → conta no rate-limit + backlog de confirmação ═══════════════
  await publishReply(A, complaint(A));
  const r3 = HEALTH.report(A);
  check("3.1 replies nas últimas 24h contabilizadas", r3.rateLimit.repliesLast24h === 1 && r3.rateLimit.canReply === true);
  check("3.2 confirmação de resposta pendente no backlog", r3.backlog.pendingReplyConfirmations === 1);

  // ═══════════════ 4. auth_expired → blocked ═══════════════
  CONN.recordHealth(A, "reclame_aqui", "auth_expired");
  const r4 = HEALTH.report(A);
  check("4.1 auth_expired → status blocked + recomendação", r4.status === "blocked" && r4.recommendations.some((x: string) => /auth_expired/.test(x)));
  CONN.recordHealth(A, "reclame_aqui", "connected");

  // ═══════════════ 5. RATE-LIMIT (§68) — backstop de runaway ═══════════════
  for (let i = 0; i < HEALTH.MAX_REPLIES_PER_DAY; i++) {
    db.prepare(`INSERT INTO action_execution_log (id, organization_id, action_id, attempt, handler, mode, status) VALUES (?, ?, 'fake', 1, 'ReputationPublishReplyCommandHandler', 'execute', 'done')`)
      .run(randomUUID(), A);
  }
  check("5.1 teto atingido → canReply false", HEALTH.canReply(A) === false);
  check("5.2 report → status blocked por rate-limit", HEALTH.report(A).status === "blocked");
  // publish recusa ANTES do efeito externo
  const dBlocked = REPLY.draft(A, complaint(A), { content: "Resposta.", provider: "stub" })!;
  DA.approve(A, dBlocked.action.id, "U1");
  let blocked = false;
  try { await REPLY.publish(A, dBlocked.action.id); } catch (e: any) { blocked = /rate_limited/.test(String(e?.message || e)); }
  check("5.3 publish recusado com rate_limited (backstop antes do efeito)", blocked);
  check("5.4 nada publicado: ação segue aprovada (não executou)", DA.get(A, dBlocked.action.id).status === "approved");

  // ═══════════════ 6. multi-tenant ═══════════════
  const rB = HEALTH.report(B);
  check("6.1 org B: conector não configurado, backlog 0, healthy", rB.connectors.find((c: any) => c.provider === "reclame_aqui")!.configured === false && rB.backlog.openCases === 0 && rB.status === "healthy");
  check("6.2 rate-limit não cruza org (B canReply)", HEALTH.canReply(B) === true);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-health: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
