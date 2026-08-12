/**
 * TEST — Reputation Escalation-Risk Detector (PRD 5 / ADR-162 F11). DB-backed, det., isolado.
 * Prova (§39-41):
 *   - score DERIVADO por query (RN-004): high-risk (F4), recorrência, severidade, idade,
 *     churn↔reputação (§41, via SignalCorrelationService), atrito de atendimento;
 *   - só publica o ACIONÁVEL (≥60); abaixo do limite não vira sinal;
 *   - sinal advisory (basis=estimate, RN-014/RN-CRR-4) em business_signals (convenção #12);
 *   - sweep resolve quem saiu do risco; opt-in (reputation_prevention_enabled); multi-tenant.
 *
 * Uso: npm run test:reputation-escalation
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-esc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-esc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { BusinessSignalService: BSS } = await import("../src/server/BusinessSignalService.js");
  const { ReputationEscalationRiskDetectorService: DET } = await import("../src/server/ReputationEscalationRiskDetectorService.js");

  const A = "org_esc_A", B = "org_esc_B";
  const enableOrg = (org: string, prevention: boolean) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1, reputation_prevention_enabled = ? WHERE organization_id = ?`).run(prevention ? 1 : 0, org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  enableOrg(A, true); enableOrg(B, false);
  for (const c of ["C1", "C2", "C3"]) mkContact(A, c); mkContact(B, "CB1");

  let n = 0;
  const complaint = (org: string, contact: string, content: string, rating: number) => {
    const externalId = `RA-${++n}`;
    const sid = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating, ratingScale: 5 }).signalId!;
    CASE.resolveCase(org, sid, { contactId: contact });
    return sid;
  };
  const byContact = (cands: any[], cid: string) => cands.find((c) => c.contactId === cid);

  // C1 — reclamação HIGH-RISK aberta (fraude) → forte candidato.
  const s1 = complaint(A, "C1", "isso é um golpe, não reconheço essa compra", 3);
  // C2 — reclamação única leve (delivery, nota 3 → attention) → abaixo do limite.
  complaint(A, "C2", "meu pedido não chegou ainda", 3);
  // C3 — reincidente (2 reclamações risk) + churn no mesmo contato (§41).
  complaint(A, "C3", "meu pedido não chegou, atraso enorme", 1);
  complaint(A, "C3", "continua sem resolver, péssimo", 1);
  BSS.publish(A, { domain: "churn", signalType: "churn_risk_high", severity: "risk", basis: "fact", confidence: 0.8, sourceService: "test", subjectType: "contact", subjectId: "C3", dedupeKey: "churn:risk:C3" } as any);

  // ═══════════════ 1. detect() — scoring ═══════════════
  const cands = DET.detect(A);
  const c1 = byContact(cands, "C1"), c3 = byContact(cands, "C3");
  check("1.1 C1 (high-risk) é candidato", !!c1 && c1.breakdown.highRisk.present && c1.score >= 60);
  check("1.2 C2 (leve) NÃO é candidato (abaixo do limite)", !byContact(cands, "C2"));
  check("1.3 C3 reincidente detectado", !!c3 && c3.breakdown.recurrence.count === 2 && c3.breakdown.recurrence.points > 0);
  check("1.4 C3 churn↔reputação correlacionado (§41)", !!c3 && c3.breakdown.churnCorrelated.present === true && c3.breakdown.churnCorrelated.points > 0);
  check("1.5 fatores explicáveis (ScoreBreakdown)", !!c1 && Array.isArray(c1.factors) && c1.factors.length > 0);

  // ═══════════════ 2. publish() — sinal advisory ═══════════════
  const pub = DET.publish(A);
  check("2.1 publica candidatos (≥1)", pub.published >= 2);
  const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'reputational_escalation_risk' AND source_entity_id = 'C1'`).get(A) as any;
  check("2.2 sinal em business_signals (domain reputation, subject contact)", sig && sig.domain === "reputation" && sig.subject_type === "contact" && sig.subject_id === "C1");
  check("2.3 advisory: basis=estimate (previsão, não fato)", sig && sig.basis === "estimate");
  check("2.4 evidência marca 'humano decide' (RN-014)", /humano decide/i.test(sig.evidence_json));

  // idempotente: re-publish não duplica
  const before = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'reputational_escalation_risk'`).get(A) as any).n;
  DET.publish(A);
  const after = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'reputational_escalation_risk'`).get(A) as any).n;
  check("2.5 idempotente (dedupe por contato)", before === after);

  // ═══════════════ 3. sweep — contato que saiu do risco ═══════════════
  BSS.resolve(A, s1); // resolve a reclamação high-risk de C1 → C1 cai do risco
  const sweep = DET.publish(A);
  check("3.1 sweep resolve o sinal de escalada de C1", sweep.resolved >= 1);
  const c1sig = db.prepare(`SELECT status FROM business_signals WHERE organization_id = ? AND signal_type = 'reputational_escalation_risk' AND source_entity_id = 'C1'`).get(A) as any;
  check("3.2 sinal de escalada de C1 resolvido", c1sig.status === "resolved");

  // ═══════════════ 4. opt-in gate + multi-tenant ═══════════════
  check("4.1 org sem opt-in não publica", DET.publish(B).published === 0);
  check("4.2 detect não cruza org (B vazio)", DET.detect(B).length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-escalation: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
