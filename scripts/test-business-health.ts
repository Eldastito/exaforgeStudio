/**
 * TEST — Central de Saúde e Decisão, síntese (ADR-126 Fatia 1).
 *
 * Status por regra determinística (gatilhos) + top-3 prioridades com impacto em
 * R$, marcação fato×estimativa e ação. Só leitura, isolado por org. Sem IA.
 *
 * Uso: npm run test:business-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-health-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-health-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function fmt(dt: Date) { return dt.toISOString().slice(0, 10); }
function mondayOf(d: Date) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; }
function addDays(dt: Date, n: number) { const x = new Date(dt); x.setUTCDate(x.getUTCDate() + n); return x; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { LossMarginService: L } = await import("../src/server/LossMarginService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { OwnerDrawService: O } = await import("../src/server/OwnerDrawService.js");

  const week0 = mondayOf(new Date());
  const inWeek = (w: number) => fmt(addDays(week0, w * 7 + 2));
  const mkOrg = (name: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name); return id; };

  // ===== 1. CRÍTICO: ruptura em ≤2 semanas + perda acima da meta =====
  const orgId = mkOrg("Crit");
  F.recordEvent(orgId, { direction: "in", amount: 1000 });         // caixa 1000
  F.addPayable(orgId, { description: "Fornecedor", amount: 3000, dueDate: inWeek(1) }); // fura na semana 1
  // faturamento + perda acima da meta
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(randomUUID(), orgId);
  L.setConfig(orgId, 3, "faturamento");
  L.recordLoss(orgId, { driver: "merma", amount: 100 }); // 100/1000 = 10% > 3%

  const ov = H.overview(orgId, 0);
  check("status CRÍTICO com ruptura ≤2 semanas", ov.status === "critico");
  check("gatilho de ruptura aparece", ov.triggers.some((t: any) => t.code === "ruptura_2sem"));
  check("frase-síntese preenchida", typeof ov.synthesis === "string" && ov.synthesis.length > 10);
  check("no máximo 3 prioridades", ov.priorities.length <= 3 && ov.priorities.length >= 2);
  check("prioridades ordenadas por impacto (maior primeiro)", ov.priorities[0].impact >= ov.priorities[1].impact);
  check("prioridade de caixa presente com ação e fato", ov.priorities.some((p: any) => p.source === "caixa" && p.action?.view === "caixa" && p.basis === "fato"));
  check("prioridade de perdas presente (acima da meta)", ov.priorities.some((p: any) => p.source === "perdas" && p.basis === "fato"));
  check("toda prioridade tem impacto, ação e base (fato/estimativa)", ov.priorities.every((p: any) => typeof p.impact === "number" && p.action?.label && ["fato", "estimativa"].includes(p.basis)));

  // ===== 2. RISCO: ruptura no horizonte (>2 semanas), sem crítico =====
  const orgR = mkOrg("Risco");
  F.recordEvent(orgR, { direction: "in", amount: 1000 });
  F.addPayable(orgR, { description: "Conta", amount: 1500, dueDate: inWeek(5) }); // fura na semana 5
  const ovR = H.status(orgR, 0);
  check("status RISCO quando a ruptura é além de 2 semanas", ovR.status === "risco");
  check("não marca crítico sem gatilho crítico", ovR.triggers.every((t: any) => t.level !== "critico"));

  // ===== 3. Recebível vira prioridade de cobrança =====
  const orgC = mkOrg("Receber");
  F.recordEvent(orgC, { direction: "in", amount: 5000 });
  F.addReceivable(orgC, { description: "Cliente", amount: 400, dueDate: inWeek(1), probability: 1 });
  const ovC = H.overview(orgC, 0);
  check("recebível gera prioridade de cobrança", ovC.priorities.some((p: any) => p.source === "recebiveis" && p.impact >= 400));

  // Recebíveis VENCIDOS (ADR-132 Fatia 1) — recorte de due_date < hoje.
  const orgV = mkOrg("Vencidos");
  F.addReceivable(orgV, { description: "Cliente atrasado", amount: 700, dueDate: inWeek(-1), probability: 1 });
  F.addReceivable(orgV, { description: "Cliente em dia", amount: 300, dueDate: inWeek(2), probability: 1 });
  const ovV = H.overview(orgV);
  check("KPI 'a receber vencido' reflete só o que passou do vencimento", Math.abs(ovV.kpis.aReceberVencido - 700) < 0.01);
  check("gatilho de recebível vencido aparece", ovV.triggers.some((t: any) => t.code === "receber_vencido"));
  const recV = ovV.priorities.find((p: any) => p.source === "recebiveis");
  check("prioridade de cobrança destaca o vencido", !!recV && /vencido/i.test(recV.title) && /vencido/i.test(recV.fato));

  // Conversão de orçamentos caindo (ADR-132 Fatia 2).
  const orgConv = mkOrg("Conversao");
  const insQ = (status: string, daysAgo: number) => db.prepare("INSERT INTO quotes (id, organization_id, status, total_amount, sent_at) VALUES (?, ?, ?, 100, datetime('now', ?))").run(randomUUID(), orgConv, status, `-${daysAgo} days`);
  insQ("accepted", 5); for (let i = 0; i < 4; i++) insQ("declined", 5);
  for (let i = 0; i < 3; i++) insQ("accepted", 45); for (let i = 0; i < 2; i++) insQ("declined", 45);
  const ovConv = H.overview(orgConv);
  check("conversão em queda vira gatilho na Central", ovConv.triggers.some((t: any) => t.code === "conversao_caiu"));
  check("overview expõe a conversão (atual e anterior)", ovConv.conversao?.ratePct === 20 && ovConv.conversao?.prevRatePct === 60);

  // Concentração no maior cliente (ADR-132 Fatia 3).
  const orgConc = mkOrg("Concentracao");
  const mkContact = (name: string) => { const id = randomUUID(); db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)").run(id, orgConc, name, randomUUID().slice(0, 10)); return id; };
  const cBig = mkContact("Big Corp"); const cSmall = mkContact("Cliente Pequeno");
  const mkOrder = (contactId: string, total: number) => db.prepare("INSERT INTO comigo_orders (id, organization_id, contact_id, status, total) VALUES (?, ?, ?, 'paid', ?)").run(randomUUID(), orgConc, contactId, total);
  mkOrder(cBig, 800); mkOrder(cSmall, 200); // maior cliente = 80% de 1000
  const conc = H.customerConcentration(orgConc);
  check("concentração: maior cliente representa 80% da receita", conc?.topPct === 80 && conc?.topName === "Big Corp");
  const ovConc = H.overview(orgConc);
  check("concentração alta vira gatilho na Central", ovConc.triggers.some((t: any) => t.code === "concentracao_cliente"));
  check("overview expõe a concentração", ovConc.concentracao?.topPct === 80);
  // Receita pulverizada não dispara o alerta.
  const orgSpread = mkOrg("Pulverizada");
  for (let i = 0; i < 6; i++) { const cid = randomUUID(); db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)").run(cid, orgSpread, `C${i}`, randomUUID().slice(0, 10)); db.prepare("INSERT INTO comigo_orders (id, organization_id, contact_id, status, total) VALUES (?, ?, ?, 'paid', 100)").run(randomUUID(), orgSpread, cid); }
  check("receita distribuída não gera alerta de concentração", !H.overview(orgSpread).triggers.some((t: any) => t.code === "concentracao_cliente"));

  // Estoque parado sem giro (ADR-132 Fatia 4).
  const orgStock = mkOrg("EstoqueParado");
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount) VALUES (?, ?, 'pago', 1000)`).run(randomUUID(), orgStock);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, 'pDead', 50, 40)`).run(randomUUID(), orgStock); // 2000 parado, sem saída
  const ovStock = H.overview(orgStock);
  check("estoque parado sem giro vira gatilho na Central", ovStock.triggers.some((t: any) => t.code === "estoque_parado"));
  check("overview expõe o estoque sem giro", ovStock.estoque?.slowMoverCapital === 2000);

  // ===== 4. SAUDÁVEL: sem gatilhos =====
  const orgOk = mkOrg("Ok");
  F.recordEvent(orgOk, { direction: "in", amount: 8000 });
  const ovOk = H.overview(orgOk, 0);
  check("status SAUDÁVEL sem gatilhos", ovOk.status === "saudavel");
  check("saudável sem prioridades de risco", ovOk.priorities.length === 0);

  // ===== 4b. Aplicar recomendação → Impact Ledger unificado (Fatia 2) =====
  const p0 = ov.priorities[0];
  check("prioridade começa fora do plano (inPlan false)", p0.inPlan === false);
  const ap = H.apply(orgId, { source: p0.source, title: p0.title, impact: p0.impact, rationale: p0.interpretacao }) as any;
  check("aplicar registra a ação (ok)", ap.ok === true && !ap.deduped);
  check("aplicar de novo é idempotente (não duplica)", (H.apply(orgId, { source: p0.source, title: p0.title, impact: p0.impact }) as any).deduped === true);
  const ov2 = H.overview(orgId, 0);
  check("prioridade aplicada aparece como 'no plano'", ov2.priorities.find((p: any) => p.title === p0.title)?.inPlan === true);
  check("histórico/Impact Ledger reflete a ação aplicada", ov2.ledger.items.some((it: any) => it.title === p0.title) && ov2.ledger.expected >= p0.impact - 0.01);
  check("histórico é o Impact Ledger unificado (mesma origem da ADR-125)", typeof ov2.ledger.expected === "number" && typeof ov2.ledger.realized === "number");

  // ===== 4c. Qualidade dos dados + howTo + narrativa (Fatia 3) =====
  check("toda prioridade traz o 'como fazer' (Tutor)", ov2.priorities.every((p: any) => typeof p.howTo === "string" && p.howTo.length > 10));
  check("checklist de qualidade dos dados presente", Array.isArray(ov2.dataQuality?.items) && ov2.dataQuality.items.length >= 4);
  check("qualidade alta com caixa+pagar+meta+vendas informados", ov2.dataQuality.pct >= 80 && ov2.dataQuality.level === "alta");
  check("narrativa do Diretor preenchida", typeof ov2.narrative === "string" && ov2.narrative.length > 20 && /negócio está/i.test(ov2.narrative));

  // ===== 4d. Retiradas em excesso viram gatilho + prioridade (ADR-129 → Central) =====
  const ret = mkOrg("Retiradas");
  F.recordEvent(ret, { direction: "in", amount: 2000 });
  O.record(ret, { kind: "pro_labore", amount: 500, date: fmt(new Date()) }); // sem faturamento → resultado 0 → excesso
  const ovRet = H.overview(ret, 0);
  check("retirada em excesso vira gatilho de risco na Central", ovRet.triggers.some((t: any) => t.code === "retiradas_excesso"));
  check("retirada em excesso vira prioridade do dia", ovRet.priorities.some((p: any) => p.source === "retiradas" && p.impact >= 500));
  check("prioridade de retiradas leva ao Empresa × Proprietário", ovRet.priorities.find((p: any) => p.source === "retiradas")?.action.view === "reports");

  // ===== 5. Org vazia: sem falso alarme + isolamento =====
  const empty = mkOrg("Vazia");
  const ovE = H.overview(empty, 0);
  check("org vazia → saudável, sem prioridades", ovE.status === "saudavel" && ovE.priorities.length === 0);
  check("isolamento: KPIs da org vazia zerados", ovE.kpis.caixaAtual === 0 && ovE.kpis.aReceber === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Central de Saúde e Decisão (ADR-126 Fatia 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Central de Saúde OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
