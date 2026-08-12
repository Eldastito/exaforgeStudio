/**
 * TEST — Reputation Root Cause & Learning (PRD 5 / ADR-162 F12). DB-backed, det., isolado.
 * Prova (§42-46, RN-CRR-8/§44):
 *   - clusters por CATEGORIA numa janela + tendência vs BASELINE (janela anterior);
 *   - sobre-representação exige baseline (correlação ≠ causa) — categoria que só subiu
 *     de fatia é flagada; a que caiu, não;
 *   - VOLUME-BASELINE: reclamações por 100 pedidos (atual vs anterior) → tendência;
 *   - PATTERN MEMORY: learn() memoriza via PatternMemoryService e publica sinal do padrão
 *     validado; opt-in (pattern_memory);
 *   - guardrail: nota marca "evidência, não causa" + "nunca ranking de funcionário" (§44);
 *   - multi-tenant.
 *
 * Uso: npm run test:reputation-rootcause
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-rc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-rc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationRootCauseService: RC } = await import("../src/server/ReputationRootCauseService.js");

  const A = "org_rc_A", B = "org_rc_B";
  const enableOrg = (org: string, patternMemory: boolean) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1, pattern_memory = ? WHERE organization_id = ?`).run(patternMemory ? 1 : 0, org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  enableOrg(A, true); enableOrg(B, false); mkContact(A, "C1");

  let n = 0;
  const complaint = (org: string, content: string, agoDays: number) => {
    const externalId = `RA-${++n}`;
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating: 2, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: "C1" }); // classifica (evidence.classification.category)
    if (agoDays > 0) db.prepare(`UPDATE business_signals SET detected_at = ? WHERE id = ?`).run(new Date(Date.now() - agoDays * 86400e3).toISOString(), sid);
    return sid;
  };
  const mkOrder = (org: string, agoDays: number) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, 'C1', 'pago', 50, ?)`)
      .run(`O-${org}-${++n}`, org, new Date(Date.now() - agoDays * 86400e3).toISOString());

  // Janela ATUAL (≤30d): 5 delivery + 1 refund. Janela ANTERIOR (~45d): 1 delivery + 3 refund.
  for (let i = 0; i < 5; i++) complaint(A, "meu pedido não chegou, atraso enorme", 1);
  complaint(A, "quero meu reembolso, estorno não caiu", 1);
  complaint(A, "meu pedido não chegou", 45);
  for (let i = 0; i < 3; i++) complaint(A, "quero reembolso, cobrança indevida", 45);
  // Volume: 100 pedidos atuais, 100 anteriores (reclamações crescem mais que o volume).
  for (let i = 0; i < 100; i++) mkOrder(A, 2);
  for (let i = 0; i < 100; i++) mkOrder(A, 45);

  // ═══════════════ 1. analyze — clusters + baseline ═══════════════
  const an = RC.analyze(A, { windowDays: 30 });
  const delivery = an.categories.find((c) => c.category === "delivery");
  const refund = an.categories.find((c) => c.category === "refund_billing");
  check("1.1 totais por janela (6 atual, 4 anterior)", an.totals.currentComplaints === 6 && an.totals.priorComplaints === 4);
  check("1.2 delivery SOBRE-representada vs baseline", !!delivery && delivery.currentCount === 5 && delivery.overRepresented === true && delivery.delta > 0);
  check("1.3 refund NÃO sobre-representada (fatia caiu)", !!refund && refund.overRepresented === false);
  check("1.4 baseline da categoria é a janela anterior (§43)", !!delivery && delivery.baselineShare === 0.25 && delivery.currentShare > delivery.baselineShare);

  // ═══════════════ 2. volume-baseline (§43) ═══════════════
  check("2.1 reclamações por 100 pedidos (atual 6, anterior 4)", an.totals.complaintsPer100OrdersCurrent === 6 && an.totals.complaintsPer100OrdersPrior === 4);
  check("2.2 volume-baseline disponível + tendência 'rising'", an.totals.volumeBaselineAvailable === true && an.totals.volumeTrend === "rising");

  // ═══════════════ 3. guardrail RN-CRR-8/§44 ═══════════════
  check("3.1 nota: evidência não causa + nunca ranking de funcionário", /evid[êe]ncia/i.test(an.note) && /funcion[áa]rio/i.test(an.note) && /RN-CRR-8/.test(an.note));

  // ═══════════════ 4. learn — pattern memory + sinal ═══════════════
  const learned = await RC.learn(A, { windowDays: 30 });
  check("4.1 detecta o padrão (delivery)", learned.detected === 1 && learned.validated >= 1);
  const pat = db.prepare(`SELECT * FROM business_patterns WHERE organization_id = ? AND domain = 'reputation' AND pattern_type = 'reputation_category_spike' AND scope_id = 'delivery'`).get(A) as any;
  check("4.2 padrão memorizado (business_patterns, validado)", pat && pat.status === "validated");
  check("4.3 padrão validado publica sinal", learned.published >= 1 && !!db.prepare(`SELECT id FROM business_signals WHERE organization_id = ? AND signal_type = 'reputation_category_spike'`).get(A));

  // opt-in gate
  check("4.4 learn é opt-in (pattern_memory): org sem flag → skipped", (await RC.learn(B, {})).skipped === true);

  // ═══════════════ 5. multi-tenant ═══════════════
  check("5.1 analyze não cruza org (B vazio)", RC.analyze(B, {}).totals.currentComplaints === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-rootcause: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
