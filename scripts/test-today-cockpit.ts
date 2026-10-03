/**
 * TESTE — Fase 2 / F2.3 (ADR-203): "Hoje" como cockpit por exceção (TodayCockpitService + GET /api/ux/today).
 * Prova: (1) org calma → tela calma, 0 prioridades; (2) no MÁXIMO 3 prioridades, cada uma com causa + verbo específico,
 * o excedente vira só contagem; (3) decisão pendente que o usuário PODE aprovar sobe ao topo; quem não pode não a recebe;
 * (4) exceção "sem escala" nomeia a loja no verbo; (5) rede: meta do mês + parcial do PDV com carimbo de frescor
 * ("último dado às HH:MM") e ATRASADO quando passa de 90 min; sem fechamento → "—" (nunca "vendeu 0"); (6) dinheiro
 * role-gated (vendedor: network null); (7) escopo de loja (gerente preso à loja não vê a exceção de outra); (8) isolamento
 * por org; (9) rota montada e tela ligada ao app. Determinístico, sem LLM.
 * Uso:  npm run test:today-cockpit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f23-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-today-cockpit-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

const NOW = new Date("2026-10-15T15:00:00Z"); // 12h SP, quinta

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TodayCockpitService: T, MAX_PRIORITIES } = await import("../src/server/TodayCockpitService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { RetailMonthlyGoalService: G } = await import("../src/server/RetailMonthlyGoalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); P.seedSystemProfiles(id); return id; };
  const A = mkOrg(), CALM = mkOrg(), OTHER = mkOrg();
  const userFor = (org: string, key: string) => ({ userId: randomUUID(), id: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor(A, "owner"), vendedor = userFor(A, "vendedor");

  // ── (1) org calma ──
  const calm = T.build(CALM, userFor(CALM, "owner"), { now: NOW });
  check("org sem exceção: tela calma, 0 prioridades, sem rede", calm.calm === true && calm.priorities.length === 0 && calm.moreCount === 0 && calm.network === null, JSON.stringify(calm).slice(0, 200));
  check("saudação pela hora (12h SP → Boa tarde)", calm.greeting === "Boa tarde");

  // ── varejo da org A ──
  const mkStore = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?,?,?,?)`).run(id, A, name, code); return id; };
  const grande = mkStore("Grande Rio", "2001"), bangu = mkStore("Bangu", "2003");
  G.set(A, { storeId: grande, month: "2026-10", goalAmount: 100000 }); G.set(A, { storeId: bangu, month: "2026-10", goalAmount: 80000 });
  const cl = (st: string, d: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?,?,?,?, 'received', ?, 0)`).run(randomUUID(), A, st, d, v);

  // ── (5) rede: sem fechamento → "—", nunca "vendeu 0" ──
  let t = T.build(A, owner, { now: NOW });
  check("rede: meta do mês soma as metas cadastradas", t.network?.monthGoal.text.replace(/\s/g, "").includes("180.000") === true, t.network?.monthGoal.text);
  check("sem NENHUM fechamento: 'já fechado' é desconhecido (—), não R$ 0", t.network?.monthClosed.state === "unknown" && t.network?.monthClosed.text === "—" && t.network?.monthRemaining.state === "not_computed");
  check("sem PDV sincronizado: parcial do dia desconhecido + frescor 'nunca sincronizou'", t.network?.todayPartial.state === "unknown" && t.network?.freshness.hhmm === null);
  cl(grande, "2026-10-01", 20000);
  t = T.build(A, owner, { now: NOW });
  check("fechamento de só UMA das lojas com meta: continua desconhecido (não soma parcial disfarçada)", t.network?.monthClosed.state === "unknown" && /1 loja/.test(t.network?.monthClosed.reason || ""), t.network?.monthClosed.reason || "");
  cl(bangu, "2026-10-01", 10000);
  t = T.build(A, owner, { now: NOW });
  check("todas fechadas: já fechado = 30.000 e falta = 150.000", /30\.000/.test(t.network!.monthClosed.text) && /150\.000/.test(t.network!.monthRemaining.text), `${t.network!.monthClosed.text} | ${t.network!.monthRemaining.text}`);

  // PDV fresco (10 min) e atrasado (3h)
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?,?,?,?,?,?,?,?, 'N', NULL)`).run(randomUUID(), A, "2001", "b1", "2026-10-15", "10:00", 1500, 1);
  const cur = (iso: string) => { db.prepare(`DELETE FROM alterdata_sync_cursors WHERE organization_id = ?`).run(A); db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, last_synced_at) VALUES (?,?,?,?,?)`).run(randomUUID(), A, "sales", "VendaMalote", iso); };
  cur("2026-10-15T14:50:00Z");
  t = T.build(A, owner, { now: NOW });
  check("PDV fresco: 'último dado às 11:50' e não atrasado", t.network?.freshness.hhmm === "11:50" && t.network?.freshness.stale === false, JSON.stringify(t.network?.freshness));
  check("parcial do dia aparece (só uma loja vendeu → marcado como parcial, não total)", /1\.500/.test(t.network!.todayPartial.text) && /parcial/.test(t.network!.todayPartial.text), t.network!.todayPartial.text);
  cur("2026-10-15T12:00:00Z");
  check("PDV com 3h de atraso: stale = true (a UI avisa)", T.build(A, owner, { now: NOW }).network?.freshness.stale === true);

  // ── (6) dinheiro role-gated ──
  const sellerView = T.build(A, vendedor, { now: NOW });
  check("vendedor: sem 'network' (dinheiro role-gated) e sem valor recuperado", sellerView.network === null && sellerView.resolved.valueRecovered === null);

  // ── (3) decisão pendente ──
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, expected_impact, impact_unit) VALUES (?,?, 'sales', 'refund', 'Aprovar reembolso de R$ 800', 'awaiting_approval', 'single', 'rule', 10, 800, 'BRL')`).run(randomUUID(), A);
  t = T.build(A, owner, { now: NOW });
  check("decisão que o dono pode aprovar vira prioridade #1, com verbo 'Aprovar ou recusar'", t.priorities[0]?.kind === "decision" && /Aprovar ou recusar/.test(t.priorities[0].verb) && t.priorities[0].title.includes("reembolso") && t.priorities[0].cause.length > 0, JSON.stringify(t.priorities[0]));

  // ── (4)(2) exceções + teto de 3 ──
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?,?,?,?,?,?, 'work')`).run(randomUUID(), A, grande, "2026-10-14", "ana", "Ana");
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?,?,?,?,?,?, 'work')`).run(randomUUID(), A, bangu, "2026-10-14", "bia", "Bia");
  for (const k of ["a", "b", "c"]) BS.publish(A, { domain: "finance", signalType: "cash_low", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", dedupeKey: `r-${k}`, impactAmount: 9000, impactUnit: "BRL", evidence: {} });
  t = T.build(A, owner, { now: NOW });
  check(`no máximo ${MAX_PRIORITIES} prioridades; o excedente vira só contagem`, t.priorities.length === MAX_PRIORITIES && t.moreCount >= 1, `${t.priorities.length}/${t.moreCount}`);
  check("toda prioridade tem título, causa e verbo específicos", t.priorities.every(p => p.title && p.cause && p.verb && p.viewMode), JSON.stringify(t.priorities.map(p => p.verb)));
  check("ordem: decisão antes de risco", t.priorities[0].kind === "decision" && t.priorities[1]?.kind === "risk" && t.priorities.map(p => p.weight).every((w, i, a) => i === 0 || a[i - 1] >= w), JSON.stringify(t.priorities.map(p => p.kind)));

  // exceção sem escala (escala existe nos últimos 31 dias, mas não hoje) — nomeia a loja no verbo
  const ex = T.build(A, owner, { now: NOW });
  const exAll = (ex.priorities.length + ex.moreCount);
  check("exceção 'sem escala' é candidata (entra no total de assuntos)", exAll >= 4, String(exAll));
  const onlyEx = (() => { db.prepare(`UPDATE business_signals SET status='dismissed' WHERE organization_id = ?`).run(A); db.prepare(`UPDATE decision_actions SET status='rejected' WHERE organization_id = ?`).run(A); return T.build(A, owner, { now: NOW }); })();
  check("sem decisão/risco: a exceção sobe e o verbo nomeia a loja", onlyEx.priorities.some(p => p.kind === "exception" && /Cadastrar a escala de (Grande Rio|Bangu)/.test(p.verb)), JSON.stringify(onlyEx.priorities.map(p => p.verb)));

  // ── (7) escopo de loja ──
  const gerente = userFor(A, "gerente");
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?,?,?)`).run(A, gerente.userId, grande);
  const gv = T.build(A, gerente, { now: NOW });
  check("gerente preso à Grande Rio NÃO vê a exceção de Bangu", !gv.priorities.some(p => /Bangu/.test(p.verb)), JSON.stringify(gv.priorities.map(p => p.verb)));
  check("bloco de rede do gerente é marcado como escopo parcial (UI diz 'Suas lojas', não 'Rede'); dono não", gv.network?.scoped === true && T.build(A, owner, { now: NOW }).network?.scoped === false, String(gv.network?.scoped));
  check("valor recuperado nunca é R$ 0: sem valor > 0 vira null (null≠zero)", T.build(A, owner, { now: NOW }).resolved.valueRecovered === null || /[1-9]/.test(T.build(A, owner, { now: NOW }).resolved.valueRecovered!.text));

  // sinais IGUAIS viram 1 prioridade com contagem (não ocupam as 3 vagas) + as telas novas têm barra de rolagem própria (main é overflow-hidden)
  const GRP = `org_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), GRP);
  for (const k of ["a", "b", "c"]) BS.publish(GRP, { domain: "finance", signalType: "cash_low", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", dedupeKey: `g-${k}`, impactAmount: 9000, impactUnit: "BRL", evidence: {} });
  const gt = T.build(GRP, userFor(GRP, "owner"), { now: NOW });
  check("3 sinais idênticos → 1 prioridade com '(3 ocorrências)'", gt.priorities.length === 1 && /3 ocorrências/.test(gt.priorities[0].title), JSON.stringify(gt.priorities.map(p => p.title)));
  const appSrc = fs.readFileSync("src/App.tsx", "utf8");
  check("Hoje/Executando/Resultados/Empresa renderizam dentro de contêiner com rolagem (overflow-y-auto)", ["hoje:TodayView", "executando:ExecutingView", "resultados:ResultsView", "empresa:CompanyView"].every(x => { const [v, c] = x.split(":"); return new RegExp(`viewMode === '${v}' && <div className="flex-1 min-w-0 overflow-y-auto"><${c} />`).test(appSrc); }));

  // ── (8) isolamento ──
  const ot = T.build(OTHER, userFor(OTHER, "owner"), { now: NOW });
  check("isolamento: outra org não vê nada da org A", ot.priorities.length === 0 && ot.network === null);

  // ── (9) fiação ──
  const ux = fs.readFileSync("src/server/routes/ux.ts", "utf8");
  check("rota GET /api/ux/today montada", /router\.get\("\/today"/.test(ux));
  const app = fs.readFileSync("src/App.tsx", "utf8");
  check("App renderiza TodayView no viewMode 'hoje'", /viewMode === 'hoje' && <div className="flex-1 min-w-0 overflow-y-auto"><TodayView \/><\/div>/.test(app));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
