/**
 * TEST — Reputation Investigation (PRD 5 / ADR-162 F5). DB-backed, isolado, DETERMINÍSTICO.
 * Prova (§19-20):
 *   - separa CLAIM (alegação, estimate) / FACT (registro interno) / HYPOTHESIS (causa);
 *   - causa por CATEGORIA (F4) corroborada por fato do customer-360 (F3): entrega com
 *     pedido não-entregue → corroborada, grounding 'grounded', confiança sobe, não escala;
 *   - sem corroboração + caso sério → grounding 'unsupported', permanece ALEGAÇÃO, ESCALA;
 *   - reembolso corroborado por pedido em status de reembolso;
 *   - HIGH-RISK (F4): não deriva causa automática, headline de apuração humana, escala,
 *     IA não conclui (RN-CRR-4);
 *   - REÚSO: SignalInvestigationService traz causa por CORRELAÇÃO de sinais do mesmo
 *     contato (contextSignalCount > 0) como evidência;
 *   - multi-tenant + not_found.
 *
 * Uso: npm run test:reputation-investigation
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-inv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-inv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");
  const { ReputationInvestigationService: INV } = await import("../src/server/ReputationInvestigationService.js");
  const { BusinessSignalService: BSS } = await import("../src/server/BusinessSignalService.js");

  const A = "org_inv_A", B = "org_inv_B";
  const enableOrg = (org: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
  };
  const mkContact = (org: string, id: string) =>
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name, email) VALUES (?, ?, 'ch1', ?, ?, ?)`).run(id, org, `id-${id}`, id, `${id}@x.com`);
  const mkOrder = (org: string, id: string, contact: string, status: string) =>
    db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, 100, '2026-08-10')`).run(id, org, contact, status);
  enableOrg(A); enableOrg(B);
  mkContact(A, "C1"); mkContact(A, "C2"); mkContact(A, "C3");

  let n = 0;
  // ingere reclamação + resolve (re-sujeita ao contato + classifica) → devolve signalId
  const caseFor = (org: string, content: string, contact: string, rating: number) => {
    const externalId = `RA-${++n}`;
    const out = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, rating, ratingScale: 5 });
    const sid = out.signalId!;
    CASE.resolveCase(org, sid, { contactId: contact }); // re-sujeita → contact + classifica
    return sid;
  };

  // ═══════════════ 1. Entrega CORROBORADA por pedido não-entregue ═══════════════
  const s1 = caseFor(A, "meu pedido não chegou, um atraso enorme", "C1", 1);
  mkOrder(A, "O1", "C1", "pendente"); // NOT_DELIVERED → corrobora
  const inv1 = INV.investigate(A, s1)!;
  check("1.1 categoria delivery", inv1.category === "delivery");
  check("1.2 causa líder = atraso na entrega, corroborada", inv1.candidateCauses[0].cause.includes("entrega") && inv1.candidateCauses[0].corroborated === true);
  check("1.3 grounding 'grounded' (corroborado por fato interno)", inv1.grounding.status === "grounded" && inv1.grounding.corroboratedByInternalFact === true);
  check("1.4 claim é alegação (estimate), não fato", inv1.claim.basis === "estimate" && inv1.claim.statement.includes("pedido"));
  check("1.5 fatos internos incluem o pedido (SYSTEM_OF_RECORD/orders)", inv1.facts.some((f) => f.service === "orders" && f.sourceId === "O1"));
  check("1.6 corroborado + sério NÃO escala", inv1.escalate === false);
  check("1.7 confiança > base (bônus de corroboração)", inv1.confidence > 0.4);

  // ═══════════════ 2. Entrega SEM corroboração + sério → alegação + ESCALA ═══════════════
  const s2 = caseFor(A, "meu pedido não chegou até agora", "C2", 1); // C2 sem pedido
  const inv2 = INV.investigate(A, s2)!;
  check("2.1 sem fato interno → não corroborada", inv2.candidateCauses[0].corroborated === false);
  check("2.2 grounding 'unsupported' (alegação, não fato)", inv2.grounding.status === "unsupported" && inv2.grounding.corroboratedByInternalFact === false);
  check("2.3 caso sério sem corroboração ESCALA (humano decide)", inv2.escalate === true);
  check("2.4 headline marca ALEGAÇÃO ≠ fato (RN-CRR-2)", /alega|apurar/i.test(inv2.headline));

  // ═══════════════ 3. Reembolso corroborado por pedido em reembolso ═══════════════
  const s3 = caseFor(A, "quero meu reembolso, o estorno não caiu", "C3", 2);
  mkOrder(A, "O3", "C3", "reembolso");
  const inv3 = INV.investigate(A, s3)!;
  check("3.1 categoria refund_billing", inv3.category === "refund_billing");
  check("3.2 corroborada por pedido em reembolso + grounded", inv3.candidateCauses[0].corroborated === true && inv3.grounding.status === "grounded");

  // ═══════════════ 4. HIGH-RISK: não conclui, escala (RN-CRR-4) ═══════════════
  const s4 = caseFor(A, "isso é um golpe, não reconheço essa compra", "C1", 3);
  const inv4 = INV.investigate(A, s4)!;
  check("4.1 highRisk true", inv4.highRisk === true);
  check("4.2 headline de apuração humana (IA não conclui)", /alto risco|apura|não conclui/i.test(inv4.headline));
  check("4.3 high-risk escala", inv4.escalate === true);

  // ═══════════════ 5. REÚSO: causa por correlação de sinais do mesmo contato ═══════════════
  BSS.publish(A, { domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 0.8, sourceService: "test", subjectType: "contact", subjectId: "C1", dedupeKey: "test:overdue:C1" } as any);
  const inv5 = INV.investigate(A, s1)!; // s1 é do C1
  check("5.1 contexto correlato detectado (contextSignalCount > 0)", inv5.contextSignalCount > 0);
  check("5.2 causa por correlação presente (operacional interno)", inv5.candidateCauses.some((c) => /operacional interno/i.test(c.cause) && c.corroborated));

  // ═══════════════ 6. multi-tenant + not_found ═══════════════
  check("6.1 não cruza org", INV.investigate(B, s1) === null);
  check("6.2 signal inexistente → null", INV.investigate(A, "nope") === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-investigation: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
