/**
 * TESTE — PRD Fase 1, F1.4a: status de política de comissão ("regra pendente nunca vira pagamento")
 * Prova: proposta NÃO sobrescreve o plano vigente; comissão consolidada e run de pagamento só leem
 * política active/confirmed (mesmo que uma linha viva seja marcada pendente por fora); prévia
 * (preview) enxerga a pendente e vem rotulada; confirmar (humano) promove com confirmed_by; transições
 * inválidas recusadas; arquivar política viva cai na próxima precedência; linhas legadas seguem active
 * (0-regressão); isolamento multi-tenant.
 * Uso:  npm run test:retail-commission-policy-status
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-policy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-comm-policy-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService: R, DEFAULT_RACE_PLAN } = await import("../src/server/RetailCommissionRaceService.js");
  const { RetailCommissionPolicyService: P } = await import("../src/server/RetailCommissionPolicyService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const bangu = store(A, "Bangu", "1003");
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'S1', 'Ana')`).run(randomUUID(), A);
  // Ana vende 1200 em setembro contra cota semanal 1000 → atingimento 120% na semana do dia 10
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status, vendedor_codigo) VALUES (?, ?, '1003', 'b1', '2026-09-10', 1200, 3, 'N', 'S1')`).run(randomUUID(), A);
  R.setSellerQuotas(A, bangu, "2026-09-06", [{ sellerKey: "mat:S1", sellerName: "Ana", amount: 1000 }], "u-owner");

  const planWith = (firstPct: number, name: string): any => {
    const p = JSON.parse(JSON.stringify(DEFAULT_RACE_PLAN));
    p.name = name; p.seller.weeklyFirstTiers = [{ min: 1.0, percent: firstPct }];
    return p;
  };
  const anaWeek = (race: any) => race.stores.find((s: any) => s.storeName === "Bangu").weeks.find((w: any) => w.start === "2026-09-06").sellers.find((s: any) => s.sellerName === "Ana");

  // ── plano vigente do mês (humano decidiu): 1% ──
  const live = R.savePlan(A, bangu, planWith(1, "vigente 1%"), "u-owner", "2026-09");
  check("savePlan direto (owner/admin decide) nasce ACTIVE com confirmed_by", live.status === "active" && live.confirmedBy === "u-owner");
  const raceBase = R.raceMonth(A, "2026-09");
  const basePct = anaWeek(raceBase).prize.percent;
  check("baseline: Ana ganha a faixa de 1% (plano vigente)", basePct === 1, `pct=${basePct}`);
  check("corrida rotula a política de cada loja (active, sem preview)", raceBase.stores[0].policy.status === "active" && raceBase.stores[0].policy.preview === false && raceBase.preview === false);

  // ── proposta pendente (ex.: IA leu a planilha): 3% — NÃO pode virar pagamento ──
  const prop = P.propose(A, { storeId: bangu, month: "2026-09", config: planWith(3, "proposta 3%"), source: "ai_import", sourceRef: "planilha-set.xlsx", submit: true }, "u-bruno");
  check("proposta nasce pending_confirmation e não altera o plano vigente", prop.status === "pending_confirmation" && R.getPlan(A, bangu, "2026-09").plan.name === "vigente 1%");
  const live2: any = db.prepare(`SELECT config_json, policy_status FROM retail_commission_plan_months WHERE organization_id = ? AND store_id = ? AND year_month = '2026-09'`).get(A, bangu);
  check("a proposta NÃO sobrescreveu a linha viva (chave loja+mês única preservada)", JSON.parse(live2.config_json).name === "vigente 1%" && live2.policy_status === "active");
  const racePay = R.raceMonth(A, "2026-09");
  check("MODO PAGAMENTO (default): corrida segue com 1% — pendente nunca entra", anaWeek(racePay).prize.percent === 1 && racePay.stores[0].policy.status === "active");
  const reportPay: any = R.reportView(A, "2026-09");
  const runPending = R.createRaceRun(A, "2026-09", "u-owner");
  const anaItemPay = (runPending.items || []).find((i: any) => /Ana/.test(i.seller_name || i.sellerName || ""));
  check("run de PAGAMENTO com proposta pendente usa a regra VIGENTE e avisa (pending_policy)", Array.isArray(runPending.warnings) && runPending.warnings[0].code === "pending_policy" && runPending.warnings[0].proposals[0].id === prop.id);
  const detPay = JSON.parse(anaItemPay?.calculation_details_json || anaItemPay?.detail || "{}");
  check("item do run carrega a política sob a qual foi calculado (auditável)", detPay.policy?.status === "active" && detPay.policy?.source === "store", JSON.stringify(detPay.policy));
  check("relatório consolidado (reportView) também ignora a pendente", reportPay.bySeller.length >= 0 && reportPay.totals.totalCommission === racePay.totals.grand);

  // ── PRÉVIA enxerga a pendente, rotulada, sem gravar ──
  const racePrev = R.raceMonth(A, "2026-09", { preview: true });
  check("PRÉVIA: corrida simula com a proposta (3%) e vem rotulada como preview/pending", anaWeek(racePrev).prize.percent === 3 && racePrev.preview === true && racePrev.stores[0].policy.preview === true && racePrev.stores[0].policy.status === "pending_confirmation");
  check("PRÉVIA não grava nada: pagamento continua 1%", anaWeek(R.raceMonth(A, "2026-09")).prize.percent === 1 && R.getPlan(A, bangu, "2026-09").plan.name === "vigente 1%");
  check("prévia rende MAIS que o vigente (a diferença é o que o dono vai avaliar antes de confirmar)", racePrev.totals.grand > racePay.totals.grand);

  // ── defesa em profundidade: linha VIVA marcada pendente por fora também não paga ──
  db.prepare(`UPDATE retail_commission_plan_months SET policy_status = 'pending_confirmation' WHERE organization_id = ? AND store_id = ? AND year_month = '2026-09'`).run(A, bangu);
  const gp = R.getPlan(A, bangu, "2026-09");
  check("linha viva com status pendente é IGNORADA no pagamento (cai no default, não paga regra não confirmada)", gp.source === "default" && gp.plan.name === DEFAULT_RACE_PLAN.name && gp.status === "default");
  db.prepare(`UPDATE retail_commission_plan_months SET policy_status = 'active' WHERE organization_id = ? AND store_id = ? AND year_month = '2026-09'`).run(A, bangu);

  // ── transições inválidas ──
  const draft = P.propose(A, { storeId: bangu, month: "2026-10", config: planWith(2, "rascunho") }, "u-bruno");
  check("rascunho não pode ser confirmado sem enviar (draft → confirmed é inválido)", draft.status === "draft" && throws(() => P.confirm(A, draft.id, "u-owner"), /invalid_transition/));
  check("confirmar exige usuário identificado", throws(() => P.confirm(A, prop.id, null), /usuário identificado/));
  check("config inválida recusada (precisa seller+manager)", throws(() => P.propose(A, { storeId: bangu, month: "2026-10", config: { name: "x" } }), /config inválida/));
  check("loja de outra org / mês inválido / source inválido recusados", throws(() => P.propose(A, { storeId: randomUUID(), month: "2026-10", config: planWith(1, "x") }), /Loja não encontrada/) && throws(() => P.propose(A, { month: "10/2026", config: planWith(1, "x") }), /YYYY-MM/) && throws(() => P.propose(A, { month: "2026-10", config: planWith(1, "x"), source: "x" }), /source inválido/));
  const sub = P.submit(A, draft.id, "u-bruno");
  check("draft → pending_confirmation (submit) e não repete", sub.status === "pending_confirmation" && throws(() => P.submit(A, draft.id), /invalid_transition/));

  // ── confirmar promove (humano) ──
  const conf = P.confirm(A, prop.id, "u-bruno");
  check("confirmar (humano): proposta vira confirmed com confirmed_by/at", conf.status === "confirmed" && conf.confirmedBy === "u-bruno" && !!conf.confirmedAt);
  const gp2 = R.getPlan(A, bangu, "2026-09");
  check("confirmar promove ao plano VIVO (3%) como active com quem confirmou", gp2.plan.name === "proposta 3%" && gp2.status === "active" && gp2.confirmedBy === "u-bruno");
  check("agora o PAGAMENTO usa 3% (só depois da confirmação humana)", anaWeek(R.raceMonth(A, "2026-09")).prize.percent === 3);
  check("não confirma duas vezes nem arquiva proposta já confirmada", throws(() => P.confirm(A, prop.id, "u-bruno"), /invalid_transition/) && throws(() => P.archiveProposal(A, prop.id, "u-bruno"), /invalid_transition/));
  const runAfter = R.createRaceRun(A, "2026-09", "u-owner");
  check("run depois de confirmar: sem aviso de pendente pra 2026-09", !(runAfter.warnings || []).some((w: any) => w.proposals?.some((p: any) => p.id === prop.id)));

  // ── arquivar proposta e política viva ──
  const arch = P.archiveProposal(A, draft.id, "u-owner", "planilha errada");
  check("arquivar proposta pendente registra motivo e tira da prévia", arch.status === "archived" && arch.archiveReason === "planilha errada" && R.getPlan(A, bangu, "2026-10", { preview: true }).source === "default");
  const al = P.archiveLive(A, { storeId: bangu, month: "2026-09" }, "u-owner");
  const gp3 = R.getPlan(A, bangu, "2026-09");
  check("arquivar política viva: deixa de pagar e cai na próxima precedência (default)", al.archived === true && gp3.source === "default");
  check("arquivar de novo é no-op; salvar de novo (humano) reativa", P.archiveLive(A, { storeId: bangu, month: "2026-09" }).archived === false && R.savePlan(A, bangu, planWith(1, "vigente 1% v2"), "u-owner", "2026-09").status === "active");

  // ── legado: linhas existentes seguem active (0-regressão) ──
  db.prepare(`INSERT INTO retail_commission_plans (id, organization_id, store_id, config_json, active) VALUES (?, ?, '*', ?, 1)`).run(randomUUID(), A, JSON.stringify(planWith(2, "rede legada 2%")));
  const legacy = R.getPlan(A, null);
  check("plano legado (sem policy_status explícito) segue valendo como active", legacy.plan.name === "rede legada 2%" && legacy.status === "active");
  const nullStatus = db.prepare(`SELECT policy_status FROM retail_commission_plans WHERE organization_id = ? AND store_id = '*'`).get(A) as any;
  check("coluna nova nasce 'active' por DEFAULT (dado antigo não vira pendente)", nullStatus.policy_status === "active");

  // ── listagem e isolamento ──
  const listing = P.list(A, { month: "2026-09" });
  check("list traz propostas e políticas vivas com status", listing.proposals.some((p: any) => p.id === prop.id && p.status === "confirmed") && listing.live.some((l: any) => l.month === "2026-09" && l.status === "active"));
  check("isolamento: org B não enxerga nem confirma proposta da A", P.list(B).proposals.length === 0 && throws(() => P.confirm(B, sub.id, "u-x"), /não encontrada/) && throws(() => P.archiveProposal(B, sub.id), /não encontrada/));
  const bStore = store(B, "B1", "9001");
  P.propose(B, { storeId: bStore, month: "2026-09", config: planWith(5, "B pendente"), submit: true }, "u-b");
  check("isolamento: proposta pendente da B não vira plano/prévia da A", R.getPlan(A, bangu, "2026-09", { preview: true }).plan.name !== "B pendente" && R.getPlan(B, bStore, "2026-09").source === "default");

  console.log("\n=== PRD Fase 1 · F1.4a: status de política de comissão ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
