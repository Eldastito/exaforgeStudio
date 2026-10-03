/**
 * TESTE — Fase 2 / F2.5 (ADR-203): "Resultados" do todo ao detalhe (ResultsStoryService + /api/ux/results-story[/store/:id/understand]).
 * Prova: (1) org sem lojas → honesto, sem conclusão inventada; (2) a CONCLUSÃO vem primeiro e é derivada (mês % da meta + nº de lojas
 * abaixo); (3) lojas ordenadas com quem precisa de atenção no topo (abaixo › sem dado › bateu); loja sem fechamento/cota vai a
 * "sem dado" — NUNCA a "abaixo"; (4) sem fechamento nenhum = "—", nunca "vendeu 0"; (5) "Entender": fato × hipótese, quem mais caiu,
 * sem culpa; (6) dinheiro role-gated (vendedor: restricted, sem números); (7) escopo de loja (gerente preso não vê outra loja,
 * nem a rede inteira); (8) isolamento por org; (9) Dashboard rebatizado "Atendimento Digital"; (10) rota/tela ligadas. Sem LLM.
 * Uso:  npm run test:results-story
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f25-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-results-story-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

const NOW = new Date("2026-10-01T15:00:00Z");   // "ontem" (SP) = 2026-09-30
const REF = "2026-09-30";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ResultsStoryService: R } = await import("../src/server/ResultsStoryService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { RetailMonthlyGoalService: G } = await import("../src/server/RetailMonthlyGoalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); P.seedSystemProfiles(id); return id; };
  const A = mkOrg(), EMPTY = mkOrg(), OTHER = mkOrg();
  const userFor = (org: string, key: string) => ({ userId: randomUUID(), id: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor(A, "owner"), vendedor = userFor(A, "vendedor");

  // ── (1) sem lojas ──
  const e = R.build(EMPTY, userFor(EMPTY, "owner"), { now: NOW });
  check("org sem lojas: sem conclusão inventada, diz o motivo", e.hasRetail === false && e.headline === null && !!e.headlineReason && e.stores.length === 0);

  // ── varejo ──
  const mkStore = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?,?,?,?)`).run(id, A, name, code); return id; };
  const grande = mkStore("Grande Rio", "2001"), bangu = mkStore("Bangu", "2003"), carioca = mkStore("Carioca", "2002");
  const cl = (st: string, d: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?,?,?,?, 'received', ?, 0)`).run(randomUUID(), A, st, d, v);
  const quota = (st: string, d: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?,?,?,?,?)`).run(randomUUID(), A, st, d, v);

  // ── (4) sem nenhum fechamento: "—" ──
  let s = R.build(A, owner, { now: NOW });
  check("sem fechamento nenhum: venda é '—' (nunca 'vendeu 0') e todas as lojas 'sem dado'", s.stores.length === 3 && s.stores.every(x => x.status === "no_data" && x.day.venda.text === "—"), JSON.stringify(s.stores[0]?.day));
  check("sem fechamento: sem conclusão, com motivo", s.headline === null && !!s.headlineReason);

  // ── (2)(3) com dados ──
  G.set(A, { storeId: grande, month: "2026-09", goalAmount: 100000 }); G.set(A, { storeId: bangu, month: "2026-09", goalAmount: 80000 }); G.set(A, { storeId: carioca, month: "2026-09", goalAmount: 60000 });
  quota(grande, REF, 4000); quota(bangu, REF, 3000);                    // Carioca: sem cota do dia
  cl(grande, REF, 5000);                                                 // bateu (5000 ≥ 4000)
  cl(bangu, REF, 1500);                                                  // abaixo (1500 < 3000)
  cl(carioca, REF, 2000);                                                // venda conhecida, SEM cota → sem dado, nunca "abaixo"
  s = R.build(A, owner, { now: NOW });
  const by = Object.fromEntries(s.stores.map(x => [x.name, x.status]));
  check("Grande Rio bateu · Bangu abaixo · Carioca sem cota do dia = 'sem dado' (nunca 'abaixo')", by["Grande Rio"] === "hit" && by["Bangu"] === "below" && by["Carioca"] === "no_data", JSON.stringify(by));
  check("ordem: quem precisa de atenção primeiro (abaixo › sem dado › bateu)", s.stores.map(x => x.status).join(",") === "below,no_data,hit", s.stores.map(x => x.status).join(","));
  check("conclusão vem primeiro e é derivada: mês % da meta + lojas abaixo", !!s.headline && /No mês, a rede está em/.test(s.headline) && /1 loja ficou abaixo/.test(s.headline), s.headline || s.headlineReason || "");
  check("a base diz 'só fechamentos já enviados' (parcial do PDV é do Hoje)", /fechamentos já enviados/.test(s.basis));
  check("rede: dia/semana/mês presentes e a rede conta lojas sem dado", !!s.network && s.network.storesNoData === 1 && s.network.storesBelow === 1 && s.network.storesHit === 1, JSON.stringify(s.network && { h: s.network.storesHit, b: s.network.storesBelow, n: s.network.storesNoData }));

  // ── (5) Entender ──
  const sel = (mat: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?,?,?,?)`).run(id, A, mat, name); return id; };
  const sale = (mat: string, name: string, date: string, valor: number) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?,?,?,?,?,?,1,'manual')`).run(randomUUID(), A, date, name, mat, valor);
  const maria = sel("101", "Maria Souza"), joana = sel("102", "Joana Prado");
  for (const sid of [maria, joana]) db.prepare(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active, effective_from, source) VALUES (?,?,?,?,1,1,'2026-01-01','manual')`).run(randomUUID(), A, sid, bangu);
  for (let i = 1; i <= 5; i++) sale("101", "Maria Souza", `2026-09-${String(i * 2).padStart(2, "0")}`, 100);          // atual 500
  for (let i = 1; i <= 10; i++) sale("101", "Maria Souza", `2026-08-${String(i * 2 + 1).padStart(2, "0")}`, 100);    // anterior 1000
  for (let i = 1; i <= 5; i++) sale("102", "Joana Prado", `2026-09-${String(i * 2).padStart(2, "0")}`, 200);         // cresceu (1000 vs 0)
  const u = R.understand(A, owner, bangu, { now: NOW })!;
  check("Entender: períodos da loja + quem mais caiu (só quem caiu; quem cresceu não aparece)", !!u.periods && u.team.length === 1 && u.team[0].name === "Maria Souza" && u.team[0].salesDeltaPct === -50, JSON.stringify(u.team.map(t => [t.name, t.salesDeltaPct])));
  check("Entender separa FATO de HIPÓTESE e a hipótese nunca vira causa", u.team[0].findings.some(f => f.kind === "fact") && u.team[0].findings.filter(f => f.kind === "hypothesis").every(f => !/culpa|causa comprovada/i.test(f.text)) && u.notes.some(n => /não causa comprovada/.test(n)));
  const uc = R.understand(A, owner, carioca, { now: NOW })!;
  check("Entender sem equipe medível: lista vazia + nota honesta (não inventa)", uc.team.length === 0 && uc.notes.some(n => /Nenhuma pessoa/.test(n)));
  check("Entender de loja inexistente / de outra org: null", R.understand(A, owner, "nao-existe", { now: NOW }) === null && R.understand(OTHER, userFor(OTHER, "owner"), bangu, { now: NOW }) === null);

  // ── (6) dinheiro role-gated ──
  const sv = R.build(A, vendedor, { now: NOW });
  check("vendedor: restricted, sem rede nem lojas, sem números do varejo", sv.restricted === true && sv.network === null && sv.stores.length === 0 && sv.headline === null);
  const uv = R.understand(A, vendedor, bangu, { now: NOW })!;
  check("vendedor no Entender: restricted, sem períodos nem equipe", uv.restricted === true && uv.periods === null && uv.team.length === 0);

  // ── (7) escopo de loja ──
  const gerente = userFor(A, "gerente");
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?,?,?)`).run(A, gerente.userId, bangu);
  const gv = R.build(A, gerente, { now: NOW });
  check("gerente preso à Bangu: só a loja dele e NÃO recebe a leitura da rede inteira", gv.restricted === false && gv.stores.length === 1 && gv.stores[0].name === "Bangu" && gv.network === null && gv.headline === null && /parte das lojas/.test(gv.headlineReason || ""), JSON.stringify({ n: gv.stores.length, h: gv.headline, r: gv.headlineReason }));
  check("gerente preso à Bangu não entende a Grande Rio", R.understand(A, gerente, grande, { now: NOW }) === null && R.understand(A, gerente, bangu, { now: NOW }) !== null);

  // ── (8) isolamento ──
  const ot = R.build(OTHER, userFor(OTHER, "owner"), { now: NOW });
  check("isolamento: outra org não vê as lojas da org A", ot.stores.length === 0 && ot.hasRetail === false);

  // ── (9)(10) rótulo + fiação ──
  const nav = fs.readFileSync("src/lib/navCatalog.ts", "utf8");
  check("Dashboard rebatizado 'Atendimento Digital' (menu simplificado, menu legado, título e cabeçalho)", /viewMode: 'dashboard', label: 'Atendimento Digital'/.test(nav) && /label="Atendimento Digital" active=\{viewMode === 'dashboard'\}/.test(fs.readFileSync("src/features/Sidebar.tsx", "utf8")) && /Atendimento Digital<\/h2>/.test(fs.readFileSync("src/features/DashboardPanel.tsx", "utf8")) && /dashboard' && 'Atendimento Digital'/.test(fs.readFileSync("src/App.tsx", "utf8")));
  const ux = fs.readFileSync("src/server/routes/ux.ts", "utf8");
  check("rotas /results-story e /results-story/store/:storeId/understand montadas", /router\.get\("\/results-story"/.test(ux) && /\/results-story\/store\/:storeId\/understand/.test(ux));
  check("App renderiza ResultsView no viewMode 'resultados'; nav aponta 'Resultados' para a tela própria", /viewMode === 'resultados' && <ResultsView \/>/.test(fs.readFileSync("src/App.tsx", "utf8")) && /viewMode: 'resultados'/.test(nav));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
