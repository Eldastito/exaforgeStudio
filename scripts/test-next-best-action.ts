/**
 * TESTE — ADR-206 F5.9: Inteligência de produto por atributo (cor/tamanho) + NEXT BEST ACTION formal (máx. 3).
 * Prova, nos serviços REAIS:
 *   A) atributo: agrega por cor/tamanho só o que está ligado a uma VARIANTE; cobertura dita; venda cancelada fora; null≠0;
 *   B) honestidade: cobertura baixa → números sim, dicas NÃO; amostra mínima por valor; variação só com amostra nos 2 períodos;
 *      estoque negativo fora da soma; dica é hipótese (máx. 3, ordenada pela maior diferença); R$ só com includeMoney;
 *   C) NBA: no máximo 3, mesma ordem da priorização (com política e metas), porquê/evidência/aprovação/medição, dedupe, vazio sem enchimento,
 *      dinheiro oculto sem permissão, dicas de produto SEPARADAS da ordem, read-only, override crítico primeiro;
 *   D) isolamento por empresa; fiação (rotas, sem tabela, sem LLM).
 * Uso: npm run test:next-best-action
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nba-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-nba-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const A = await import("../src/server/ProductAttributeIntelligenceService.js");
  const { ProductAttributeIntelligenceService: PA } = A;
  const { NextBestActionService: N } = await import("../src/server/NextBestActionService.js");
  const { ImpactPrioritizationService: I } = await import("../src/server/ImpactPrioritizationService.js");
  const { StrategicPolicyService: SP } = await import("../src/server/StrategicPolicyService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const ASOF = "2026-06-30";
  const prod = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Camisa')`).run(id, org); return id; };
  const variant = (org: string, pid: string, color: string | null, size: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, color, size) VALUES (?, ?, ?, ?, ?, ?)`).run(id, org, pid, `${color}/${size}`, color, size); return id; };
  let boletaN = 0;
  const sale = (org: string, date: string, status: string | null, items: Array<{ variantId: string | null; q: number; v: number }>) => {
    const boleta = `B${++boletaN}`;
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status) VALUES (?, ?, 'F1', ?, ?, 0, 0, ?)`).run(randomUUID(), org, boleta, date, status);
    items.forEach((it, i) => db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, variant_id) VALUES (?, ?, 'F1', ?, ?, ?, 'X', ?, ?, ?)`).run(randomUUID(), org, boleta, date, i, it.q, it.v, it.variantId));
  };
  const lines = (org: string, date: string, variantId: string | null, n: number, status: string | null = null) => sale(org, date, status, Array.from({ length: n }, () => ({ variantId, q: 1, v: 100 })));
  const stock = (org: string, pid: string, vid: string, q: number) => db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, `s-${randomUUID().slice(0, 4)}`, pid, vid, q);

  // ── A/B) atributo ──
  const o = mkOrg(); const p = prod(o);
  const vPM = variant(o, p, "Preto", "M"), vPG = variant(o, p, "Preto", "G"), vBM = variant(o, p, "Branco", "M"), vAP = variant(o, p, "Azul", "P");
  lines(o, "2026-06-10", vPM, 40); lines(o, "2026-06-11", vPG, 20);   // Preto 60
  lines(o, "2026-06-12", vBM, 20);                                      // Branco 20 (< 30)
  lines(o, "2026-06-13", vAP, 40);                                      // Azul 40
  lines(o, "2026-06-14", null, 40);                                     // sem variante (fora)
  lines(o, "2026-06-15", vPM, 15, "C");                                 // cancelada (fora)
  lines(o, "2026-03-10", vPM, 30); lines(o, "2026-03-11", vAP, 5);                                      // período ANTERIOR (Preto 30)
  stock(o, p, vPM, 6); stock(o, p, vPG, 4); stock(o, p, vBM, 200); stock(o, p, vAP, 40); stock(o, p, vAP, -5);
  const r = PA.performance(o, { asOf: ASOF, days: 90, includeMoney: false });
  const col = (v: string) => r.color.values.find((x: any) => x.value === v);
  check("cobertura dita: 160 linhas, 120 ligadas a variante, 40 sem; venda cancelada fora", r.coverage.lines === 160 && r.coverage.resolvedToVariant === 120 && r.coverage.unresolved === 40 && r.coverage.linesPct === 75 && r.reliable === true);
  check("cor: preto 60 un., azul 40, branco 20, ordenado por unidades", r.color.values.map((x: any) => x.value).join() === "preto,azul,branco" && col("preto").units === 60 && col("azul").units === 40 && col("branco").units === 20);
  check("participação das saídas soma 100%", Math.abs(r.color.values.reduce((a: number, x: any) => a + x.unitsSharePct, 0) - 100) < 0.2);
  check("tamanho: M (preto M + branco M) = 60 un., G 20, P 40", (() => { const m = Object.fromEntries(r.size.values.map((x: any) => [x.value, x.units])); return m.m === 60 && m.g === 20 && m.p === 40; })());
  check("variação vs período anterior só com amostra nos 2 períodos (preto +100%; azul/branco null)", col("preto").changeUnitsPct === 100 && col("azul").changeUnitsPct === null && col("branco").changeUnitsPct === null);
  check("valor com poucas linhas (< 30) marcado insufficient_data, sem variação", col("branco").status === "insufficient_data" && col("preto").status === "ok");
  check("estoque negativo fora da soma e contado", col("azul").stockUnits === 40 && r.negativeStockRowsIgnored === 1);
  check("dicas são hipótese, máx. 3, preto primeiro (60% das saídas × 4% do estoque)", r.hints.length >= 1 && r.hints.length <= 3 && r.hints[0].value === "preto" && r.hints[0].kind === "demand_above_stock" && r.hints[0].basis === "hypothesis" && /vale conferir/.test(r.hints[0].text));
  check("branco (poucas linhas) NÃO gera dica mesmo com muito estoque", !r.hints.some((h: any) => h.value === "branco"));
  check("sem includeMoney: nenhum R$ no resultado", !JSON.stringify(r).includes("revenue"));
  const rm = PA.performance(o, { asOf: ASOF, days: 90, includeMoney: true });
  check("com includeMoney: receita por cor (preto 6000)", rm.color.values.find((x: any) => x.value === "preto").revenue === 6000);
  const oLow = mkOrg(); const pl = prod(oLow); const vl = variant(oLow, pl, "Preto", "M");
  lines(oLow, "2026-06-10", vl, 40); lines(oLow, "2026-06-11", null, 160); stock(oLow, pl, vl, 1);
  const rl = PA.performance(oLow, { asOf: ASOF });
  check("cobertura baixa (20%): números aparecem, dicas NÃO, e o aviso diz isso", rl.reliable === false && rl.hints.length === 0 && rl.color.values.length === 1 && rl.notes.some((n: string) => /Cobertura baixa/.test(n)));
  const oE = mkOrg(); const re = PA.performance(oE, { asOf: ASOF });
  check("sem vendas: cobertura null (não 0), nada inventado", re.coverage.lines === 0 && re.coverage.linesPct === null && re.coverage.valuePct === null && re.color.values.length === 0 && re.hints.length === 0 && re.reliable === false);
  check("isolamento: outra empresa não vê as vendas", PA.performance(oE, { asOf: ASOF }).coverage.lines === 0 && PA.performance(o, { asOf: ASOF }).coverage.lines === 160);
  const oS = mkOrg(); const ps = prod(oS); const vs1 = variant(oS, ps, "Preto", "M"), vs2 = variant(oS, ps, "Branco", "M");
  lines(oS, "2026-06-10", vs1, 40); lines(oS, "2026-06-11", vs2, 40); stock(oS, ps, vs1, 50); stock(oS, ps, vs2, 50);
  check("procura e estoque equilibrados → nenhuma dica", PA.performance(oS, { asOf: ASOF }).hints.length === 0);
  check("janela inválida cai nos limites (days ≥ 7) e asOf inválido não quebra", PA.performance(o, { days: 1, asOf: "lixo" }).window.days === 7);

  // ── C) NBA ──
  const sig = (org: string, domain: string, type: string, amount: number, severity = "attention") => BusinessSignalService.publish(org, { domain, signalType: type, severity, basis: "fact", confidence: 0.8, impactAmount: amount, impactUnit: "BRL", sourceService: "t", dedupeKey: `${domain}:${type}:${randomUUID()}`, evidence: {} }).id;
  const n1 = mkOrg();
  sig(n1, "finance", "receivable_overdue", 1000, "risk"); sig(n1, "sales", "retail_seller_below_quota", 900); sig(n1, "inventory", "consumo_cobertura_baixa", 800); sig(n1, "procurement", "fornecedor_atraso_recorrente", 700); sig(n1, "tasks", "data_quality_low", 100);
  const empty = N.top(mkOrg());
  check("sem sinais: lista vazia, mensagem honesta, sem enchimento", empty.empty === true && empty.actions.length === 0 && /Nada pede atenção/.test(empty.message));
  const nba = N.top(n1, { includeMoney: true });
  check("no máximo 3 ações, ranqueadas 1..3", nba.actions.length === 3 && nba.limit === 3 && nba.actions.map((a: any) => a.rank).join() === "1,2,3");
  const pri = I.prioritize(n1, { globalLimit: 12 }).global.map((x: any) => x.signalId);
  check("a ordem é a da priorização (sem ranking paralelo)", nba.actions.map((a: any) => a.signalId).join() === pri.slice(0, 3).join());
  const a0 = nba.actions[0];
  check("cada ação traz porquê, evidência, aprovação/dono/prazo e como se mede", a0.whyNow && a0.evidence.basis && a0.evidence.impactLevel && a0.suggestedOwner && a0.due && a0.howMeasured && "approval" in a0);
  check("sem includeMoney: valor em R$ oculto (flag hidden)", (() => { const x = N.top(n1); return x.actions.every((a: any) => !a.evidence.impact || a.evidence.impact.hidden === true) && !JSON.stringify(x).includes('"amount":1000'); })());
  check("com includeMoney: valor aparece", nba.actions.some((a: any) => a.evidence.impact && a.evidence.impact.amount === 1000));
  SP.set(n1, { weights: { sales: 100, cash: 0 } }, "owner-1");
  const nbaPol = N.top(n1, { includeMoney: true });
  check("política estratégica aparece no porquê e na ordem (vendas passam à frente de caixa)", nbaPol.actions.find((a: any) => a.domain === "sales") && nbaPol.actions.find((a: any) => a.domain === "sales").policy?.objective === "sales" && /política estratégica/.test(nbaPol.actions.find((a: any) => a.domain === "sales").whyNow) && (nbaPol.actions.findIndex((a: any) => a.domain === "sales") < nbaPol.actions.findIndex((a: any) => a.domain === "finance") || !nbaPol.actions.some((a: any) => a.domain === "finance")));
  const n2 = mkOrg(); const secId = sig(n2, "security", "anomalous_behavior", 10, "critical"); sig(n2, "finance", "receivable_overdue", 5000, "risk");
  check("override crítico de segurança vem primeiro e é dito", (() => { const x = N.top(n2); return x.actions[0].signalId === secId && /segurança/.test(x.actions[0].whyNow); })());
  check("mesma ação genérica no mesmo domínio (2 tipos sem ação própria) ocupa 1 vaga só", (() => { const o3 = mkOrg(); sig(o3, "finance", "tipo_sem_acao_a", 1000); sig(o3, "finance", "tipo_sem_acao_b", 900); sig(o3, "sales", "retail_seller_below_quota", 100); const acts = N.top(o3).actions; return acts.filter((a: any) => a.domain === "finance").length === 1 && acts.length === 2; })());
  const nOrgWithRetail = N.top(o, { asOf: ASOF });
  check("dicas de produto vêm SEPARADAS em 'toInvestigate' (máx. 3) e fora das ações", nOrgWithRetail.toInvestigate.length >= 1 && nOrgWithRetail.toInvestigate.length <= 3 && nOrgWithRetail.toInvestigate.every((h: any) => h.basis === "hypothesis") && nOrgWithRetail.actions.every((a: any) => !("kind" in a)));
  const cntSig = () => (db.prepare("SELECT COUNT(*) n FROM business_signals").get() as any).n, cntAct = () => (db.prepare("SELECT COUNT(*) n FROM decision_actions").get() as any).n;
  const b = [cntSig(), cntAct()]; N.top(n1, { includeMoney: true }); PA.performance(o, { asOf: ASOF });
  check("read-only: não cria sinal nem ação", cntSig() === b[0] && cntAct() === b[1]);
  check("isolamento do NBA: empresa sem sinais não vê as ações de outra", N.top(mkOrg()).actions.length === 0 && N.top(n1).actions.length === 3);

  // ── D) fiação ──
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/decisionIntelligence.ts"), "utf8");
  check("rotas montadas; dinheiro só owner/admin", /"\/next-best-actions"[\s\S]{0,260}includeMoney: \["owner", "admin"\]/.test(route) && /"\/product-attributes"[\s\S]{0,400}includeMoney: \["owner", "admin"\]/.test(route));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("nenhuma tabela nova de NBA/atributo", !/CREATE TABLE IF NOT EXISTS (next_best_actions|nba_|product_attribute)/.test(dbsrc));
  const svc = (f: string) => fs.readFileSync(path.join(process.cwd(), "src/server", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("serviços sem LLM e sem escrita (nenhum INSERT/UPDATE/DELETE)", ["NextBestActionService.ts", "ProductAttributeIntelligenceService.ts"].every((f) => !/\b(chat\(|openai|anthropic|LlmService)\b/i.test(svc(f)) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(svc(f))));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : x.d ? "  → " + x.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
