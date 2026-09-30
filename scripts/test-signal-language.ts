/**
 * TESTE — PRD Fase 1, F1.7a: sinais em linguagem empresarial + ação específica + Central de Saúde coerente
 * Prova: nenhum texto do catálogo tem jargão técnico (retail_*, inventory, runtime, dead_letter…); os exemplos do PRD
 * (estoque negativo → "Produtos com divergência de estoque identificados"); sinal desconhecido cai em texto genérico
 * SEM vazar o identificador; botões específicos (nunca "Agir") com "o que vai acontecer"; runtime/técnico traduzido com
 * "operação afetada?" honesto; `presentation` anexada à priorização sem mudar signal_type/ranking; Central de Saúde:
 * "Sem alertas" só sem assunto aberto (mesma fonte da lista), técnico só se risco/crítico, info não grita; UI sem "Agir".
 * Uso:  npm run test:signal-language
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-lang-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-signal-language-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const JARGON = /retail_|inventory|runtime|dead_letter|stockout|signal_type|business_signals|decision_action|_ledger|payload|webhook|\bcron\b|\bjob\b|sqlite|\bpdv_/i;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const L = await import("../src/server/SignalLanguage.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");
  const { BusinessHealthService } = await import("../src/server/BusinessHealthService.js");
  const { BusinessTutorService } = await import("../src/server/BusinessTutorService.js");

  // ── catálogo limpo de jargão ──
  const { CATALOG, RUNTIME_BY_CATEGORY, FALLBACK_BY_ACTION, FALLBACK_DEFAULT } = L._catalog;
  const texts: string[] = [];
  for (const e of [...Object.values(CATALOG), ...Object.values(RUNTIME_BY_CATEGORY)] as any[]) {
    texts.push(typeof e.title === "function" ? e.title({ store: "Loja X", allBusyMinutes: 30, streak: 3, seller: "Ana" }) : e.title, e.meaning, e.actionLabel, e.actionWillDo);
  }
  for (const f of [...Object.values(FALLBACK_BY_ACTION), FALLBACK_DEFAULT] as any[]) texts.push(f.actionLabel, f.actionWillDo);
  for (const v of Object.values(L.DOMAIN_LABEL)) texts.push(v as string);
  const leaks = texts.filter((t) => JARGON.test(t) || /[a-z]+_[a-z]+/.test(t));
  check(`nenhum texto do catálogo (${texts.length}) tem jargão técnico ou identificador com _`, leaks.length === 0, leaks.slice(0, 3).join(" | "));
  const allEntries = [...Object.values(CATALOG), ...Object.values(RUNTIME_BY_CATEGORY), ...Object.values(FALLBACK_BY_ACTION), FALLBACK_DEFAULT] as any[];
  check('nenhum rótulo de ação é o genérico "Agir"', allEntries.every((e) => !/^agir$/i.test(e.actionLabel)) && allEntries.every((e) => e.actionLabel.length >= 8));
  check("toda ação diz o que acontece ANTES de clicar (actionWillDo não vazio)", allEntries.every((e) => String(e.actionWillDo || "").length > 15));

  // ── exemplos do PRD ──
  const so = L.presentSignal({ signalType: "retail_store_stockout", domain: "inventory", evidence: { store: "Bangu" }, actionType: "create_task" });
  check('PRD: retail_store_stockout/inventory → "Produtos com divergência de estoque identificados" (+ loja)', so.title === "Produtos com divergência de estoque identificados — Bangu" && so.actionLabel === "Investigar divergência" && so.known);
  const q = L.presentSignal({ signalType: "retail_floor_queue_delay", domain: "retail_floor", evidence: { store: "Carioca", allBusyMinutes: 45 } });
  check("PRD: fila → texto de negócio com os minutos DA EVIDÊNCIA (não inventa)", /todos os vendedores estavam ocupados por 45 min/.test(q.title) && /Carioca/.test(q.title) && q.actionLabel === "Revisar escala");
  const q0 = L.presentSignal({ signalType: "retail_floor_queue_delay", domain: "retail_floor", evidence: {} });
  check("sem o número na evidência, o texto não inventa minutos", !/\d+ min/.test(q0.title));
  const tr = L.presentSignal({ signalType: "retail_transfer_suggested", domain: "retail_ops" });
  check('ação "Preparar transferência" para redistribuição (não "recomprar")', tr.actionLabel === "Preparar transferência" && !/recompr|comprar/i.test(tr.title + tr.meaning));
  const sg = L.presentSignal({ signalType: "seller_goal_streak", domain: "retail_ops", evidence: { seller: "Kleyton Cunha", streak: 3 } });
  check("meta por pessoa: 'Kleyton Cunha — 3º mês seguido abaixo da meta' + Analisar desempenho", sg.title === "Kleyton Cunha — 3º mês seguido abaixo da meta" && sg.actionLabel === "Analisar desempenho");
  const cu = L.presentSignal({ signalType: "retail_floor_code_unresolved", domain: "retail_floor", evidence: { store: "Loja 1" } });
  check("etiqueta não reconhecida (F1.2) tem ação 'Vincular código ao produto'", cu.actionLabel === "Vincular código ao produto");

  // ── runtime / técnico traduzido ──
  const rt = L.presentSignal({ signalType: "dead_letter", domain: "runtime", evidence: { category: "integration_failed", subject: "job 123" } });
  check("automação que falhou: texto humano, técnico, e NÃO afirma se a operação foi afetada (unknown)", rt.title === "Uma integração falhou" && rt.audience === "technical" && rt.operationAffected === "unknown" && !JARGON.test(rt.title + rt.meaning));
  const alt = L.presentSignal({ signalType: "alterdata_auth_falha", domain: "integration" });
  check('Alterdata sem acesso: "Não conseguimos acessar a Alterdata" e AFETA a operação (dados do dia desatualizados)', alt.title === "Não conseguimos acessar a Alterdata" && alt.operationAffected === "yes");
  const apv = L.presentSignal({ signalType: "qualquer", domain: "runtime", evidence: { category: "approval_needed" } });
  check('espera de aprovação: "não afeta" a operação e é do dono', apv.operationAffected === "no" && apv.audience === "owner");

  // ── desconhecido nunca vaza o identificador ──
  const unk = L.presentSignal({ signalType: "sinal_novo_que_ninguem_mapeou", domain: "estoque_xyz", actionType: "collection" });
  check("sinal desconhecido: título genérico, known=false, identificador NUNCA aparece, ação por tipo (Preparar cobrança)", !unk.known && !/sinal_novo|estoque_xyz/.test(JSON.stringify(unk)) && unk.actionLabel === "Preparar cobrança" && unk.operationAffected === "unknown");
  const unk2 = L.presentSignal({ signalType: null, domain: null });
  check("entrada vazia/nula não lança e cai no genérico", !unk2.known && unk2.actionLabel === "Ver detalhes e decidir" && unk2.title.length > 5);
  const weird = L.presentSignal({ signalType: "retail_floor_queue_delay", domain: "retail_floor", evidence: "texto solto" as any });
  check("evidência malformada não quebra", weird.known && weird.title.length > 5);

  // ── anexado à priorização sem mudar o ledger ──
  const O = `org_A_${randomUUID().slice(0, 6)}`, P = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [O, P]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const pub = (org: string, domain: string, signalType: string, severity: string, evidence: any = {}, key = signalType) =>
    BusinessSignalService.publish(org, { domain, signalType, severity, basis: "fact", confidence: 0.9, sourceService: "test", evidence, dedupeKey: key });
  pub(O, "inventory", "retail_store_stockout", "risk", { store: "Bangu" });
  pub(O, "retail_floor", "retail_floor_queue_delay", "info", { allBusyMinutes: 20 }, "q1");
  const pr = ImpactPrioritizationService.prioritize(O, { globalLimit: 10 });
  const byType = (t: string) => pr.global.find((x: any) => x.signalType === t);
  check("priorização anexa `presentation` e mantém signalType/domain crus (ledger intacto)", byType("retail_store_stockout").presentation.title === "Produtos com divergência de estoque identificados — Bangu" && byType("retail_store_stockout").signalType === "retail_store_stockout" && byType("retail_store_stockout").domain === "inventory" && byType("retail_store_stockout").severity === "risk");
  check("fact/interpretation antigos seguem presentes (compat) e recommendedAction também", typeof byType("retail_store_stockout").interpretation === "string" && !!byType("retail_store_stockout").recommendedAction);
  const row: any = db.prepare(`SELECT signal_type, domain, dedupe_key FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_store_stockout'`).get(O);
  check("business_signals NÃO foi alterado (dedupe/consumidores dependem do tipo técnico)", row.signal_type === "retail_store_stockout" && row.domain === "inventory");

  // ── Central de Saúde: síntese lê a MESMA fonte da lista de atenção ──
  const ov = BusinessHealthService.overview(O) as any;
  check('Central: caixa saudável + assunto aberto (risco) NÃO diz "Sem alertas" — diz "1 assunto precisa de atenção"', ov.status === "saudavel" && ov.attention.count === 1 && /1 assunto precisa de atenção/.test(ov.synthesis) && !/Sem alertas/i.test(ov.synthesis), ov.synthesis);
  check("Central: a lista de atenção usa o texto empresarial e a ação específica", ov.attention.items[0].title === "Produtos com divergência de estoque identificados — Bangu" && ov.attention.items[0].actionLabel === "Investigar divergência" && ov.attention.items[0].domainLabel === "Estoque");
  check("Central: sinal 'info' (acompanhamento) não conta como atenção", ov.attention.items.length === 1);
  pub(O, "retail_ops", "retail_store_no_closing", "attention", { store: "Carioca" }, "nc1");
  pub(O, "runtime", "stuck", "attention", { category: "integration_failed" }, "rt1");
  const ov2 = BusinessHealthService.overview(O) as any;
  check("Central: 2 assuntos → 'assuntos precisam' (plural); técnico em atenção fica de fora e é contado à parte", ov2.attention.count === 2 && /2 assuntos precisam de atenção/.test(ov2.synthesis) && ov2.attention.technicalHidden === 1);
  pub(O, "runtime", "stuck2", "risk", { category: "integration_failed" }, "rt2");
  check("Central: técnico em RISCO entra (pede o dono)", (BusinessHealthService.overview(O) as any).attention.count === 3);
  // org sem nada → mensagem positiva
  const ovB = BusinessHealthService.overview(P) as any;
  check('Central: sem nenhum assunto → "Nenhuma ação humana necessária. Operação sob controle."', ovB.status === "saudavel" && ovB.attention.count === 0 && ovB.synthesis === "Nenhuma ação humana necessária. Operação sob controle.");
  check("isolamento: assuntos da org A não aparecem na B", ovB.attention.items.length === 0);
  // resolver o sinal → some da Central (self-heal)
  BusinessSignalService.resolveByDedupe(O, "nc1"); BusinessSignalService.resolveByDedupe(O, "rt1"); BusinessSignalService.resolveByDedupe(O, "rt2");
  const ov3 = BusinessHealthService.overview(O) as any;
  check("Central: sinal resolvido sai da contagem (automação corrigida não vira problema do dono)", ov3.attention.count === 1);
  // Regressão: metas → Snapshot V2 → overview → attention → prioritize → metas fechava um ciclo (recursão exponencial).
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  BusinessGoalService.set(O, { metric: "revenue", targetAmount: 100000 });
  const t0 = Date.now(); BusinessGoalService.progress(O); BusinessHealthService.overview(O);
  check("sem ciclo: metas + Central de Saúde terminam rápido (attention não relê metas)", Date.now() - t0 < 5000);

  // ── resumo da manhã no WhatsApp (o "Receber este resumo toda manhã" da Central) ──
  const brief = BusinessTutorService.morningBrief(O).text;
  check("resumo da manhã: usa a linguagem empresarial (sem \"Sinal '...' no domínio ...\", sem tipo técnico)", /Produtos com divergência de estoque identificados/.test(brief) && !/Sinal '/.test(brief) && !/retail_store_stockout|no domínio inventory/.test(brief), brief.slice(0, 500));
  check("resumo da manhã: a síntese não se contradiz (assunto aberto ≠ 'Sem alertas' nem 'Nenhuma urgência hoje')", !/Sem alertas/i.test(brief) && !/Nenhuma urgência hoje/.test(brief) && /assunto precisa de atenção/.test(brief), brief.slice(0, 400));
  check("resumo da manhã: cada sinal da operação traz a ação específica (→ ...) e nunca 'Agir'", /→ /.test(brief) && !/\bAgir\b/.test(brief));

  // ── UI: sem "Agir" nem jargão cru nas telas trocadas ──
  const feat = (f: string) => fs.readFileSync(path.resolve(process.cwd(), "src/features", f), "utf8");
  for (const f of ["InsightsView.tsx", "RetailOpsView.tsx"]) {
    const src = feat(f);
    check(`${f}: sem botão "Agir", usa presentation.actionLabel/actionWillDo/title`, !/>\s*Agir\s*</.test(src) && !/“Agir”/.test(src) && /presentation\?\.actionLabel/.test(src) && /presentation\?\.actionWillDo/.test(src) && /presentation\?\.title/.test(src));
  }
  check("RetailOpsView: o domínio deixa de aparecer cru (usa domainLabel)", !/text-zinc-400">\{p\.domain\}<\/span>/.test(feat("RetailOpsView.tsx")));
  const hc = feat("HealthCenterView.tsx");
  check("HealthCenterView: selo e lista leem d.attention (sem 'saudável' verde com assunto aberto)", /d\?\.attention\?\.count/.test(hc) && /attention\.items\.map/.test(hc));

  console.log("\n=== PRD Fase 1 · F1.7a: linguagem empresarial, ações específicas e Central coerente ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
