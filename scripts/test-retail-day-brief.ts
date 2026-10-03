/**
 * TESTE — PRD Fase 1, F1.6a + F1.6c: cota da MANHÃ e fechamento da NOITE por loja.
 * Prova: a manhã traz "quanto cada loja tem que vender hoje" (cota por loja + rede) DENTRO do resumo da manhã
 * existente, e só quando há cota cadastrada (0-regressão); a noite traz por loja venda (folha), cota,
 * atingimento, dinheiro e o acumulado da SEMANA (seg–dom) e do MÊS; honestidade F1.0 — loja sem cota "—",
 * fechamento não lançado = "aguardando fechamento" (nunca vendeu R$ 0), dinheiro sem detalhe "—", acumulado
 * com dia faltando vira PARCIAL rotulado (sem atingimento), rede com loja sem dado = "Não calculado";
 * fonte oficial da org (folha × caixa); entrega só p/ owner/admin com telefone, horário padrão 22:30 SP (F1.6d: por loja — ver test-retail-night-slots), opt-in,
 * dedupe, retry se o envio falhar; isolamento multi-tenant.
 * Uso:  npm run test:retail-day-brief
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-daybrief-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-daybrief-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/RetailDayBriefService.js");
  const B = S.RetailDayBriefService;
  const { BusinessTutorService } = await import("../src/server/BusinessTutorService.js");
  const { FalaTuBriefingDigestService } = await import("../src/server/FalaTuBriefingDigestService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_B_${randomUUID().slice(0, 6)}`, N = `org_N_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O, N]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'folha' WHERE organization_id = ?`).run(A);
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  const closing = (org: string, st: string, date: string, informed: number, opts: { status?: string; system?: number; details?: any } = {}) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, st, date, opts.status || "received", informed, opts.system ?? 0, opts.details ? JSON.stringify(opts.details) : null);

  const D = "2026-09-24"; // quinta · semana seg 21/09 → dom 27/09
  const grande = store(A, "Grande Rio"), carioca = store(A, "Carioca"), bangu = store(A, "Bangu");
  // Grande Rio: cota todo dia da semana; fechamentos completos + um dia antigo do mês
  for (const [d, q, v] of [["2026-09-10", 800, 850], ["2026-09-21", 1000, 900], ["2026-09-22", 1000, 1100], ["2026-09-23", 1000, 1000], [D, 2500, 2650]] as const) { quota(A, grande, d, q); closing(A, grande, d, v, { details: d === D ? { dinheiro: 300, pix: 400 } : undefined }); }
  // Carioca: cota todos os dias, mas fechamentos só de 21 e 24 (22 ausente; 23 'pending' sem valor); hoje SEM detalhe de dinheiro
  for (const d of ["2026-09-21", "2026-09-22", "2026-09-23", D]) quota(A, carioca, d, 500);
  closing(A, carioca, "2026-09-21", 480); closing(A, carioca, "2026-09-23", 0, { status: "pending" }); closing(A, carioca, D, 520);
  // Bangu: sem cota; fechamento de hoje ainda não lançado (pending, valor 0)
  closing(A, bangu, D, 0, { status: "pending" });

  const snap = B.nightSnapshot(A, D);
  const st = (n: string) => snap.stores.find((x: any) => x.storeName === n)!;
  const g = st("Grande Rio"), c = st("Carioca"), b = st("Bangu");

  // ── F1.6c: por loja ──
  check("semana começa na segunda (dom 27/09 e seg 21/09 → 21/09)", S.weekStartOf("2026-09-27") === "2026-09-21" && S.weekStartOf("2026-09-21") === "2026-09-21" && snap.weekStart === "2026-09-21");
  check("Grande Rio hoje: venda 2.650, cota 2.500, atingimento 106%, dinheiro 300", g.venda.value === 2650 && g.cota.value === 2500 && g.atingimento.value === 106 && g.dinheiro.value === 300, JSON.stringify([g.venda.value, g.cota.value, g.atingimento.value, g.dinheiro.value]));
  check("Grande Rio semana: 5.650 de 5.500 (todos os dias fechados → TOTAL)", g.week.venda.state === "value" && g.week.venda.value === 5650 && g.week.cota.value === 5500 && g.week.missingDays === 0);
  check("Grande Rio mês: soma o dia 10 também (6.500 de 6.300)", g.month.venda.value === 6500 && g.month.cota.value === 6300);
  check("fonte oficial da org = folha (informed_total manda)", snap.source === "folha");
  check("Carioca hoje: venda 520 (folha), dinheiro '—' porque o fechamento não detalhou (nunca R$ 0)", c.venda.value === 520 && c.dinheiro.state === "unknown");
  check("Carioca semana: faltam 2 dias (22 e 23; 'pending' sem valor não conta) → PARCIAL 1.000, sem total e sem atingimento", c.week.venda.state === "not_computed" && c.week.partial === 1000 && c.week.missingDays === 2 && c.week.atingimento.state !== "value");
  check("Bangu: fechamento não lançado = 'aguardando' (unknown), NÃO vendeu 0; cota '—'", b.venda.state === "unknown" && b.cota.state === "unknown" && b.dinheiro.state === "unknown");
  check("rede: com loja sem fechamento a venda NÃO é total ('não calculado') e o parcial vai à parte (3.170)", snap.network.venda.state === "not_computed" && snap.network.partialVenda === 3170);

  const txt = B.nightText(snap);
  check("texto: exemplo por loja (Venda/Cota/Atingimento/Dinheiro/Semana/Mês) no vocabulário do gestor", /Fechamento do dia — 24\/09/.test(txt) && /Grande Rio\nVenda: R\$ 2\.650/.test(txt) && /Semana: R\$ 5\.650 de R\$ 5\.500/.test(txt) && /Mês: R\$ 6\.500 de R\$ 6\.300/.test(txt));
  check("texto: Bangu mostra 'aguardando fechamento' (nunca R$ 0,00)", /Bangu\nVenda: aguardando fechamento/.test(txt) && !/R\$ 0,00/.test(txt));
  check("texto: Carioca semana rotulada como parcial", /Semana: R\$ 1\.000 — parcial, faltam fechamentos de 2 dia\(s\)/.test(txt), txt);
  check("texto: origem rotulada (folha)", /Origem: fechamento \(folha\)/.test(txt));

  // política 'system' da org (caixa manda): usa system_total
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'system' WHERE organization_id = ?`).run(A);
  const gsys = st("Grande Rio");
  const snapSys = B.nightSnapshot(A, D);
  check("política 'system': sem system_total cai pra folha (fallback) e a origem muda no rótulo", snapSys.source === "system" && snapSys.stores.find((x: any) => x.storeName === "Grande Rio")!.venda.value === 2650 && /Origem: fechamento de cada loja/.test(B.nightText(snapSys)));
  void gsys;
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'folha' WHERE organization_id = ?`).run(A);

  // ── F1.6a: manhã ──
  const m = B.morningQuotas(A, D)!;
  check("manhã: cota por loja (Grande Rio 2.500, Carioca 500) e Bangu sem cota", m.stores.find((s: any) => s.storeName === "Grande Rio")!.meta.value === 2500 && m.stores.find((s: any) => s.storeName === "Carioca")!.meta.value === 500 && m.withoutQuota.join() === "Bangu");
  check("manhã: rede NÃO soma como total quando falta cota de alguma loja (parcial 3.000 à parte)", m.network.meta.state === "not_computed" && m.network.partialMeta === 3000);
  const ml = B.morningLines(A, D).join("\n");
  check("manhã: linhas no vocabulário do gestor e avisa quem está sem cota", /Meta de hoje por loja/.test(ml) && /• Grande Rio: R\$ 2\.500/.test(ml) && /Sem meta do dia cadastrada: Bangu/.test(ml) && !/Rede: R\$/.test(ml));
  quota(A, bangu, D, 1000);
  const ml2 = B.morningLines(A, D).join("\n");
  check("manhã: com TODAS as lojas com cota, a rede aparece como total (4.000)", /• Rede: R\$ 4\.000/.test(ml2));
  check("manhã: org sem NENHUMA cota → null/sem linhas (0-regressão)", B.morningQuotas(N, D) === null && B.morningLines(N, D).length === 0);

  // dentro do resumo da manhã do Tutor (data = hoje SP)
  const today = FalaTuBriefingDigestService.spParts(new Date()).dateSP;
  const cT = store(O, "Loja Hoje"); quota(O, cT, today, 1234);
  const brief = BusinessTutorService.morningBrief(O).text;
  check("resumo da manhã do Tutor inclui a cota de hoje por loja", /Meta de hoje por loja/.test(brief) && /Loja Hoje: R\$ 1\.234/.test(brief), brief.slice(0, 400));
  check("resumo da manhã de org sem cota não muda (sem bloco de cota)", !/Meta de hoje por loja/.test(BusinessTutorService.morningBrief(N).text));

  // ── entrega da noite ──
  check("dia sem cota e sem fechamento em nenhuma loja → sem conteúdo", !B.hasContent(B.nightSnapshot(N, D)) && B.hasContent(snap));
  const user = (org: string, role: string, phone: string | null, status = "active") => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, org, role, `${id}@x.com`, phone, role, status); return id; };
  user(A, "owner", "5521999990001"); user(A, "admin", "5521999990002"); user(A, "agent", "5521999990003"); user(A, "owner", null); user(A, "admin", "5521999990004", "inactive");
  const sent: Array<[string, string]> = [];
  const send = async (phone: string, text: string) => { sent.push([phone, text]); };
  const at = (h: number) => new Date(Date.UTC(2026, 8, 24, h + 3, 30)); // SP = UTC-3 (h+3 pode passar de 24 → vira o dia seguinte em UTC)
  const off = await B.runPass(A, { now: at(22), send });
  check("opt-in: desligado por padrão não envia nada", off.sent === 0 && sent.length === 0 && B.enabled(A) === false);
  B.setEnabled(A, true);
  const early = await B.runPass(A, { now: at(21), send });
  check("antes do horário padrão (22:30 SP) não envia", early.sent === 0 && sent.length === 0);
  const r1 = await B.runPass(A, { now: at(22), send });
  check("na janela: envia só p/ owner/admin ativo COM telefone (agent, sem telefone e inativo ficam de fora)", r1.sent === 2 && sent.map(([p]) => p).sort().join() === "5521999990001,5521999990002");
  const r2 = await B.runPass(A, { now: at(23), send });
  check("dedupe: no mesmo dia não reenvia", r2.sent === 0 && r2.skipped >= 1 && sent.length === 2);
  check("a mensagem entregue é o fechamento por loja", /Fechamento do dia — 24\/09/.test(sent[0][1]) && /Grande Rio/.test(sent[0][1]));
  const forced = await B.runPass(A, { now: at(15), send, force: true });
  check("force (preview/manual) ignora janela e dedupe", forced.sent === 2);

  const O2 = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), O2);
  const cs = store(O2, "Loja C"); quota(O2, cs, D, 1000); user(O2, "owner", "5521988880001"); B.setEnabled(O2, true);
  let failNext = true, attempts = 0;
  const flaky = async (_p: string, _t: string) => { attempts++; if (failNext) { failNext = false; throw new Error("gateway down"); } };
  let threw = false; try { await B.runPass(O2, { now: at(22), send: flaky }); } catch { threw = true; }
  const retry = await B.runPass(O2, { now: at(23), send: flaky });
  check("falha de envio não marca como entregue: o próximo tick retenta e entrega", threw && retry.sent === 1 && attempts === 2);
  check("isolamento: nada da org C na mensagem da A (e vice-versa)", !sent.some(([, t]) => /Loja C/.test(t)) && B.nightSnapshot(O2, D).stores.length === 1 && B.nightSnapshot(O2, D).stores[0].storeName === "Loja C" && !B.nightText(B.nightSnapshot(O2, D)).includes("Grande Rio"));

  // ── cota PARCIAL não infla o atingimento (achado nos prints da Fase 2: "Semana 188,6%") ──
  const Q = `org_Q_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), Q);
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'folha' WHERE organization_id = ?`).run(Q);
  const lojaQ = store(Q, "Loja Q");
  quota(Q, lojaQ, "2026-09-21", 1000); closing(Q, lojaQ, "2026-09-21", 1000);
  closing(Q, lojaQ, "2026-09-22", 1000);                 // vendeu, mas SEM cota cadastrada nesse dia
  closing(Q, lojaQ, "2026-09-23", 1000);
  const lq = B.nightSnapshot(Q, "2026-09-23").stores.find((x: any) => x.storeName === "Loja Q")!;
  check("dia vendido sem cota: a cota da semana vira 'não calculada' (nunca soma venda de 3 dias contra cota de 1)", lq.week.cota.state === "not_computed" && /2 dia/.test(String(lq.week.cota.reason)), JSON.stringify(lq.week.cota));
  check("…e o atingimento da semana NÃO é calculado (antes saía 300%)", lq.week.atingimento.state !== "value", JSON.stringify(lq.week.atingimento));
  check("a venda da semana segue como fato (3.000) — só a cota é que não fecha", lq.week.venda.state === "value" && lq.week.venda.value === 3000);

  console.log("\n=== PRD Fase 1 · F1.6a/c: cota da manhã e fechamento da noite ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
