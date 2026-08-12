/**
 * TEST — Reputation Classification (PRD 5 / ADR-162 F4). DB-backed, isolado, DETERMINÍSTICO.
 * Prova:
 *   - TAXONOMIA (§15-16): cada categoria base casa pelo termo; `other` quando nada casa;
 *     extensão POR VERTICAL (food) só aparece com a vertical setada (fallback seguro);
 *   - SEVERIDADE (§17): LOW/MEDIUM/HIGH da nota/sentimento; bump financeiro; mapeamento
 *     pro vocabulário do ledger (info/attention/risk/critical);
 *   - HIGH-RISK GATES (§18/RN-CRR-4): acidente/fraude/LGPD/jurídico/imprensa → CRITICAL +
 *     escalate + improviseAllowed=false, mesmo com nota alta; CONSERVADOR (indício de
 *     high-risk + categoria normal → high-risk vence e vira manchete);
 *   - PERSISTÊNCIA MONOTÔNICA: classifySignal sobe a severidade do sinal (attention→critical)
 *     e carimba a classificação; NUNCA rebaixa (critical + conteúdo LOW continua critical);
 *     re-classificar é idempotente;
 *   - COMPOSIÇÃO F3: resolveCase embute a classificação e escala em high-risk;
 *   - multi-tenant.
 *
 * Uso: npm run test:reputation-classification
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rep-classif-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rep-classif-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ReputationClassificationService: CLS } = await import("../src/server/ReputationClassificationService.js");
  const { ExternalSignalService: EXT } = await import("../src/server/ExternalSignalService.js");
  const { ReputationCaseService: CASE } = await import("../src/server/ReputationCaseService.js");

  const A = "org_classif_A", B = "org_classif_B";
  const enableOrg = (org: string, vertical?: string) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET radar_external_signals_enabled = 1 WHERE organization_id = ?`).run(org);
    if (vertical) db.prepare(`UPDATE organization_settings SET vertical = ? WHERE organization_id = ?`).run(vertical, org);
  };
  enableOrg(A);
  enableOrg(B, "food");

  // helper: ingere uma reclamação externa e devolve o signalId
  let n = 0;
  const ingest = (org: string, content: string, extra: any = {}) => {
    const externalId = `RA-${++n}`;
    const out = EXT.ingest(org, { source: "reclame_aqui", externalId, domain: "reputation", signalType: "public_complaint", content, basis: "estimate", verifiable: false, subjectType: "reputation_item", subjectId: externalId, ...extra });
    return out.signalId!;
  };
  const sevOf = (org: string, id: string) => (db.prepare(`SELECT severity, evidence_json FROM business_signals WHERE organization_id = ? AND id = ?`).get(org, id) as any);

  // ═══════════════ 1. classify() PURO — taxonomia ═══════════════
  check("1.1 reembolso → refund_billing", CLS.classify({ content: "quero meu reembolso, o estorno não caiu" }).category === "refund_billing");
  check("1.2 entrega → delivery", CLS.classify({ content: "meu pedido não chegou, atraso enorme dos correios" }).category === "delivery");
  check("1.3 defeito → product_defect", CLS.classify({ content: "o produto veio com defeito e não funciona" }).category === "product_defect");
  check("1.4 atendimento → service_quality", CLS.classify({ content: "péssimo atendimento, a atendente foi grosseira" }).category === "service_quality");
  check("1.5 sem casar → other", CLS.classify({ content: "bom dia, tudo certo por aqui" }).category === "other");
  const acents = CLS.classify({ content: "PÉSSIMO ATENDIMENTO com GROSSERIA" });
  check("1.6 normaliza caixa/acento", acents.category === "service_quality");

  // ═══════════════ 2. HIGH-RISK gates (§18) ═══════════════
  const acc = CLS.classify({ content: "sofri um acidente usando o produto e fui parar no hospital", rating: 5, ratingScale: 5 });
  check("2.1 acidente/saúde → high_risk + CRITICAL mesmo com nota 5", acc.highRisk && acc.tier === "high_risk" && acc.category === "safety_health" && acc.severityLevel === "CRITICAL");
  check("2.2 high-risk desliga improviso e liga escalate (RN-CRR-4)", acc.improviseAllowed === false && acc.escalate === true);
  check("2.3 fraude → high_risk", CLS.classify({ content: "isso é um golpe, não autorizei essa compra" }).category === "fraud");
  check("2.4 LGPD → high_risk", CLS.classify({ content: "vocês vazaram meus dados pessoais, isso fere a lgpd" }).category === "data_privacy");
  check("2.5 jurídico → high_risk", CLS.classify({ content: "vou processar e já acionei o procon" }).category === "legal_regulatory");
  check("2.6 imprensa → high_risk", CLS.classify({ content: "vou levar isso pra imprensa e pro jornal" }).category === "press_media");
  // conservador: high-risk + normal → high-risk vira manchete
  const mix = CLS.classify({ content: "meu pedido não chegou no prazo e vou processar vocês" });
  check("2.7 conservador: delivery + jurídico → high-risk vence (manchete legal)", mix.highRisk && mix.category === "legal_regulatory" && mix.highRiskReasons.includes("legal_regulatory"));
  // sem falso-positivo: 'processo de compra' não dispara jurídico
  check("2.8 sem falso-positivo ('processo de compra')", CLS.classify({ content: "adorei o processo de compra de vocês" }).highRisk === false);

  // ═══════════════ 3. SEVERIDADE (§17) ═══════════════
  check("3.1 nota baixa → HIGH", CLS.classify({ content: "atendimento ruim", rating: 1, ratingScale: 5 }).severityLevel === "HIGH");
  check("3.2 nota alta → LOW", CLS.classify({ content: "atendimento ok", rating: 5, ratingScale: 5 }).severityLevel === "LOW");
  check("3.3 sem nota/sentimento → MEDIUM (default conservador)", CLS.classify({ content: "reclamação genérica de atendimento" }).severityLevel === "MEDIUM");
  // bump financeiro: refund + base MEDIUM → HIGH
  const fin = CLS.classify({ content: "cobrança indevida, quero meu dinheiro de volta" });
  check("3.4 bump financeiro: refund_billing sobe MEDIUM→HIGH", fin.category === "refund_billing" && fin.severityLevel === "HIGH");
  // mapeamento pro ledger
  check("3.5 LOW→info", CLS.classify({ content: "tudo certo", rating: 5, ratingScale: 5 }).signalSeverity === "info");
  check("3.6 CRITICAL→critical", acc.signalSeverity === "critical");

  // ═══════════════ 4. EXTENSÃO POR VERTICAL (§15) ═══════════════
  const foodTxt = "a comida chegou fria e sem sabor";
  check("4.1 sem vertical → base only → other", CLS.classify({ content: foodTxt }).category === "other");
  check("4.2 vertical food → food_quality", CLS.classify({ content: foodTxt, vertical: "food" }).category === "food_quality");
  check("4.3 vertical desconhecida → fallback base (sem crash)", CLS.classify({ content: foodTxt, vertical: "inexistente" }).category === "other");

  // ═══════════════ 5. classifySignal() — persistência monotônica ═══════════════
  // 5a — high-risk sobe attention→critical
  const sHigh = ingest(A, "sofri um acidente com o produto, fui ao hospital", { rating: 3, ratingScale: 5 });
  const before = sevOf(A, sHigh).severity;
  const up = CLS.classifySignal(A, sHigh);
  const afterRow = sevOf(A, sHigh);
  check("5.1 ingest coarse = attention (nota 3/5)", before === "attention");
  check("5.2 high-risk sobe attention→critical (upgrade)", up!.severityUpgraded === true && up!.to === "critical" && afterRow.severity === "critical");
  const ev = JSON.parse(afterRow.evidence_json);
  check("5.3 carimba classificação no evidence + severityUpgradedFrom", ev.classification && ev.classification.highRisk === true && ev.classification.severityUpgradedFrom === "attention");

  // 5b — mesma severidade não é upgrade (risk == risk)
  const sSame = ingest(A, "produto veio com defeito", { rating: 1, ratingScale: 5 }); // coarse risk; HIGH→risk
  const same = CLS.classifySignal(A, sSame);
  check("5.4 severidade igual não conta como upgrade (risk→risk)", same!.severityUpgraded === false && sevOf(A, sSame).severity === "risk" && JSON.parse(sevOf(A, sSame).evidence_json).classification);

  // 5c — MONOTÔNICO: critical + conteúdo LOW não rebaixa
  const sCrit = ingest(A, "adorei tudo, nota maxima, muito obrigado", { rating: 5, ratingScale: 5, severity: "critical" });
  check("5.5 pré: sinal critical (nota 5, sev explícita)", sevOf(A, sCrit).severity === "critical");
  const noDown = CLS.classifySignal(A, sCrit);
  check("5.6 NUNCA rebaixa: critical + LOW continua critical", noDown!.severityUpgraded === false && noDown!.to === "critical" && sevOf(A, sCrit).severity === "critical");
  check("5.7 idempotente: re-classificar não muda", CLS.classifySignal(A, sCrit)!.to === "critical" && sevOf(A, sCrit).severity === "critical");

  // 5d — vertical da org é lida automaticamente (B = food)
  const sFood = ingest(B, "a comida chegou fria e sem sabor", { rating: 2, ratingScale: 5 });
  check("5.8 classifySignal lê vertical da org (B=food → food_quality)", CLS.classifySignal(B, sFood)!.classification.category === "food_quality");

  // ═══════════════ 6. COMPOSIÇÃO F3 (resolveCase) ═══════════════
  const sCase = ingest(A, "isso foi um golpe, não reconheço essa compra", { rating: 3, ratingScale: 5 });
  const ctx = CASE.resolveCase(A, sCase);
  check("6.1 resolveCase embute classificação", !!ctx && !!ctx.classification && ctx.classification.category === "fraud");
  check("6.2 high-risk força escalate no caso", !!ctx && ctx.escalate === true && ctx.classification.highRisk === true);
  check("6.3 resolveCase persistiu upgrade (attention→critical)", sevOf(A, sCase).severity === "critical");

  // ═══════════════ 7. multi-tenant (RN-CRR-9) ═══════════════
  check("7.1 classifySignal não cruza org", CLS.classifySignal(B, sHigh) === null);
  check("7.2 signal inexistente → null", CLS.classifySignal(A, "nope") === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} reputation-classification: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
