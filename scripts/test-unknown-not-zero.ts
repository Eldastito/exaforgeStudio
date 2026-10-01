/**
 * TESTE — PRD Fase 1, homologação (produção TOULON, 30/09/2026): desconhecido NÃO vira R$ 0,00 nas telas antigas.
 * Achados reais: Insights mostrava "Cota R$ 0,00 · Desvio −74,9% · Grande Rio −100%" (fechamento de valor 0 = folha ainda
 * não chegou); Informe diário mostrava "Bateu R$ 0,00" em verde; o "Fim do dia" genérico mandava "Vendas R$ 0,00 · Nada em
 * aberto" com 12 assuntos abertos; o resumo da manhã dizia "Saudável" com assunto aberto; comissão sem regra saía R$ 0,00.
 * Prova (servidor): `daily` ignora fechamento de valor 0 no acima/abaixo e dá desvio só entre lojas que fecharam (null sem
 * nenhuma — nunca R$ 0); `dailyInforme` marca `awaiting` e `desvioComparable` null; o texto do informe diz "Aguardando
 * fechamento" (nunca "Bateu R$ 0,00"); o "Fim do dia" de varejo mostra "—" e não afirma "Nada em aberto" com assunto aberto;
 * "Saudável" não aparece com assunto aberto; org sem varejo e payload antigo = comportamento de sempre (0-regressão).
 * Uso:  npm run test:unknown-not-zero
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-unknownzero-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-unknownzero-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailDashboardService: Dash } = await import("../src/server/RetailDashboardService.js");
  const { RetailStoreService: Stores } = await import("../src/server/RetailStoreService.js");
  const { BusinessTutorService: Tutor } = await import("../src/server/BusinessTutorService.js");
  const { BusinessHealthService: Health } = await import("../src/server/BusinessHealthService.js");
  const { BusinessSignalService: Signals } = await import("../src/server/BusinessSignalService.js");
  const { buildDailyInformeText } = await import("../src/features/retailInformeText.js");

  const T = `org_T_${randomUUID().slice(0, 6)}`, N = `org_N_${randomUUID().slice(0, 6)}`;
  for (const o of [T, N]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, 'X', 'active', 'folha')`).run(randomUUID(), o);
  const store = (org: string, name: string) => Stores.create(org, { name, code: name.slice(0, 4) + randomUUID().slice(0, 3) } as any).id;
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  const closing = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'pending', ?)`).run(randomUUID(), org, st, date, v);

  const D = "2026-09-30";
  const carioca = store(T, "Carioca"), avb = store(T, "Avenida Brasil"), grande = store(T, "Grande Rio"), ni = store(T, "Nova Iguacu");
  for (const [st, q] of [[carioca, 1300], [avb, 5700], [grande, 2500], [ni, 2300]] as const) quota(T, st, D, q);

  // ── Cenário real das 20:47: 2 lojas com valor, 2 com fechamento de valor 0 (folha ainda não chegou) ──
  closing(T, carioca, D, 1358.7); closing(T, avb, D, 1599.2); closing(T, grande, D, 0); closing(T, ni, D, 0);
  const d = Dash.daily(T, D, null);
  check("fechamento de valor 0 não conta como 'loja fechada': 2 de 4", d.closedStores === 2, JSON.stringify(d));
  check("acima/abaixo ignora o de valor 0 (1 acima, 1 abaixo — antes 1 acima, 3 abaixo)", d.storesAbove === 1 && d.storesBelow === 1);
  check("desvio comparável só das 2 lojas que fecharam: 2957,90 − 7000 (e não − 11800)", Math.abs(d.comparableVariance - (2957.9 - 7000)) < 0.01 && d.comparableStores === 2);
  check("variância legada preservada no payload (compat) — a UI é que passa a usar a comparável", Math.abs(d.variance - (2957.9 - 11800)) < 0.01);
  check("percentual comparável sobre a cota das lojas fechadas (não da rede inteira)", Math.abs(d.comparableVariancePercent - ((2957.9 - 7000) / 7000) * 100) < 0.01);

  // ── Nenhuma loja fechou: nada a comparar → null (a UI mostra "—"), nunca R$ 0 ──
  const D2 = "2026-10-01";
  for (const st of [carioca, avb]) quota(T, st, D2, 1000);
  closing(T, carioca, D2, 0);
  const d2 = Dash.daily(T, D2, null);
  check("sem nenhum fechamento com valor: closedStores 0, desvio comparável null (não R$ 0)", d2.closedStores === 0 && d2.comparableVariance === null && d2.comparableVariancePercent === null && d2.storesBelow === 0);
  const d3 = Dash.daily(T, "2026-10-05", null);
  check("dia sem nada: closedStores 0 e desvio comparável null", d3.closedStores === 0 && d3.comparableVariance === null);
  check("fechamento com valor mas SEM cota: conta como fechado, mas não entra no desvio (null)", (() => { closing(T, ni, "2026-10-06", 500); const x = Dash.daily(T, "2026-10-06", null); return x.closedStores === 1 && x.comparableVariance === null; })());

  // ── Informe diário ──
  const inf = Dash.dailyInforme(T, D);
  const byName = (n: string) => inf.stores.find((s: any) => s.storeName === n);
  check("informe: loja de valor 0 = awaiting; loja com valor = não", byName("Grande Rio").awaiting === true && byName("Nova Iguacu").awaiting === true && byName("Carioca").awaiting === false);
  check("informe: resultado do total só das lojas fechadas com cota (−4042,10), 2 fechadas", Math.abs(inf.total.desvioComparable - (2957.9 - 7000)) < 0.01 && inf.total.closedStores === 2);
  const inf2 = Dash.dailyInforme(T, "2026-10-05");
  check("informe de dia sem fechamento: todas awaiting e resultado do total null", inf2.stores.every((s: any) => s.awaiting) && inf2.total.desvioComparable === null && inf2.total.closedStores === 0);
  const txt = buildDailyInformeText(inf2);
  check("texto do informe sem fechamento: 'Aguardando fechamento' e NUNCA 'Bateu R$ 0,00'", /Aguardando fechamento/.test(txt) && !/Bateu\s+R\$\s?0,00/.test(txt), txt);
  const txt2 = buildDailyInformeText(inf);
  check("texto do informe misto: loja de valor 0 aguardando; loja com valor mantém Bateu/Faltou", /Grande Rio\n—\nVenda —/.test(txt2) && /Carioca[\s\S]*Bateu/.test(txt2) && /Avenida Brasil[\s\S]*Faltou/.test(txt2), txt2);
  const legacy = buildDailyInformeText({ date: D, nextDate: D2, stores: [{ storeName: "Velha", dinheiro: 0, venda: 0, cota: 100, desvio: -100, cotaNext: 0 }], total: { dinheiro: 0, venda: 0, cota: 100, desvio: -100, cotaNext: 0 } } as any);
  check("payload antigo (sem awaiting/desvioComparable): texto idêntico ao de sempre (0-regressão)", /Faltou R\$\s?100,00/.test(legacy) && !/Aguardando/.test(legacy));

  // ── Dinheiro: fechamento sem detalhe de pagamento = desconhecido, não "R$ 0,00 em dinheiro" ──
  check("informe: loja fechada SEM detalhe de pagamento → dinheiroKnown false (dinheiro desconhecido)", byName("Carioca").dinheiroKnown === false && inf.total.dinheiroKnown === false);
  const D4 = "2026-10-07"; quota(T, carioca, D4, 1000);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, details_json) VALUES (?, ?, ?, ?, 'pending', 900, ?)`).run(randomUUID(), T, carioca, D4, JSON.stringify({ dinheiro: 0, pix: 100 }));
  const inf4 = Dash.dailyInforme(T, D4);
  check("com detalhe e dinheiro 0 REAL (informado): dinheiroKnown true — zero verdadeiro continua R$ 0,00", inf4.stores.find((x: any) => x.storeName === "Carioca").dinheiroKnown === true && inf4.total.dinheiroKnown === true);
  check("texto do informe: dinheiro desconhecido sai '—'; zero real sai R$ 0,00", /Carioca\n—\nVenda/.test(buildDailyInformeText(inf)) && /Carioca\nR\$\s?0,00\nVenda/.test(buildDailyInformeText(inf4)), buildDailyInformeText(inf4));

  // ── "Fim do dia" genérico de varejo ──
  const ev = Tutor.eveningBrief(T);
  check("fim do dia de varejo sem pedidos: Vendas e Margem '—' (não R$ 0,00)", /Vendas: —/.test(ev.text) && /Margem estimada: —/.test(ev.text) && !/Vendas: R\$\s?0,00/.test(ev.text), ev.text);
  const evN = Tutor.eveningBrief(N);
  check("org SEM lojas: o 'Fim do dia' segue como sempre (R$ nos números) — 0-regressão", /Vendas: R\$/.test(evN.text) && /Margem estimada: R\$/.test(evN.text), evN.text);

  // ── "Nada em aberto" / "Saudável" com assunto aberto ──
  Signals.publish(T, { domain: "retail", signalType: "stock_divergence", severity: "attention", basis: "fact", confidence: 0.9, impactAmount: 100, sourceService: "test", evidence: { note: "x" }, dedupeKey: `t:${randomUUID()}` } as any);
  const attn = Health.attention(T).count;
  const ov = Health.overview(T) as any;
  check("com assunto aberto, o rótulo NUNCA é 'Saudável' (mesmo com o caixa saudável)", ov.statusLabel !== "Saudável", JSON.stringify({ attn, label: ov.statusLabel, status: ov.status }));
  check("premissa do teste: o sinal publicado entra na atenção (senão os checks abaixo seriam vazios)", attn > 0 && ov.status === "saudavel", JSON.stringify({ attn, status: ov.status }));
  const ev2 = Tutor.eveningBrief(T);
  check("fim do dia com assunto aberto: não diz 'Nada em aberto'", !/Nada em aberto/.test(ev2.text) && /precisa|precisam/.test(ev2.text), ev2.text);
  // A org N USA o financeiro (teve uma conta a receber, já recebida): "nada em aberto" é fato dela. (Org que NUNCA lançou conta a receber
  // não pode afirmar isso — ver test-tutor-untracked-finance.)
  const { FinancialLedgerService: Ledger } = await import("../src/server/FinancialLedgerService.js");
  const rcv: any = Ledger.addReceivable(N, { description: "Venda a prazo", amount: 100, dueDate: "2026-09-01" });
  Ledger.receiveReceivable(N, rcv.id, { date: "2026-09-02" });
  const evN2 = Tutor.eveningBrief(N);
  check("org sem assunto aberto: segue 'Nada em aberto por hoje' (0-regressão)", /Nada em aberto por hoje/.test(evN2.text), evN2.text);
  const mb = Tutor.morningBrief(T);
  check("resumo da manhã com assunto aberto: não diz 'Situação: Saudável'", !/Situação:\* Saudável/.test(mb.text), mb.text.slice(0, 200));

  // ── Fiação: a UI usa os campos novos, o ranking filtra valor 0 e comissão sem regra é "não calculado" ──
  const root = process.cwd();
  const ui = fs.readFileSync(path.join(root, "src/features/RetailOpsView.tsx"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/server/routes/retailops.ts"), "utf8");
  check("UI do Insights usa comparableVariance/closedStores (não o desvio contra a cota da rede inteira)", /comparableVariance/.test(ui) && /closedStores/.test(ui));
  check("UI do informe usa awaiting/desvioComparable", /s\.awaiting/.test(ui) && /desvioComparable/.test(ui));
  check("ranking do dia exclui fechamento de valor 0 e não repete o Top no Bottom", /Number\(r\.realized\) > 0/.test(routes) && /Math\.max\(top3\.length/.test(routes));
  check("comissão sem nenhuma regra: UI mostra 'não calculada' (noRuleReport), não R$ 0,00", /noRuleReport/.test(ui) && /não foi calculada/.test(ui));
  check("informe: total deixa claro 'N de M lojas com fechamento' e a UI usa dinheiroKnown", /lojas com fechamento \(resultado só dessas\)/.test(ui) && /dinheiroKnown/.test(ui));
  check("isolamento: a org N não enxerga lojas/fechamentos da T", Dash.daily(N, D, null).closedStores === 0 && Dash.dailyInforme(N, D).stores.length === 0);

  console.log("\n=== PRD Fase 1 · homologação: desconhecido não vira R$ 0,00 ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
