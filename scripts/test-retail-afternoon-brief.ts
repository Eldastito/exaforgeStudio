/**
 * TESTE — PRD Fase 1, F1.6b: parcial das 16h (meta/vendido/atingimento/falta/dinheiro por loja e rede)
 * Prova: o exemplo do PRD (Grande Rio: meta 2.500, vendido 1.050, 42%, falta 1.450, dinheiro 280); vendas depois
 * das 16h não entram; loja sem dado mostra "—" (nunca R$ 0,00) e a rede vira "Não calculado" (total com parcela
 * faltando não é total); dinheiro só com forma de pagamento em TODAS as vendas; "abaixo do ritmo habitual" só com
 * histórico suficiente e hora confiável; frescor do PDV; entrega só p/ owner/admin com telefone, janela 16h–18h SP,
 * opt-in, dedupe, retry se o envio falhar; isolamento multi-tenant.
 * Uso:  npm run test:retail-afternoon-brief
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-afternoon-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-afternoon-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/RetailAfternoonBriefService.js");
  const B = S.RetailAfternoonBriefService;

  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  let n = 0;
  const sale = (org: string, filial: string, date: string, time: string | null, valor: number, cash: number | null, status = "N") =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(randomUUID(), org, filial, `b${++n}`, date, time, valor, status, cash === null ? null : JSON.stringify({ dinheiro: cash, cartao: valor - cash }));

  const D = "2026-09-24"; // quinta
  const grande = store(A, "Grande Rio", "2001"), carioca = store(A, "Carioca", "2002"), bangu = store(A, "Bangu", "2003"), nova = store(A, "Nova Iguaçu", "2004");
  // Grande Rio: exemplo do PRD
  quota(A, grande, D, 2500);
  sale(A, "2001", D, "10:30", 500, 100); sale(A, "2001", D, "14:15", 550, 180); sale(A, "2001", D, "17:00", 300, 50); sale(A, "2001", D, "15:00", 999, 0, "C");
  for (const [d, v] of [["2026-09-17", 1500], ["2026-09-10", 1600], ["2026-09-03", 1400], ["2026-08-27", 1500]] as const) { sale(A, "2001", d, "11:00", v, 0); sale(A, "2001", d, "18:30", 700, 0); }
  // Carioca: bateu, pagamento faltando em parte, histórico curto
  quota(A, carioca, D, 1100);
  sale(A, "2002", D, "09:00", 700, 200); sale(A, "2002", D, "13:00", 720, null);
  sale(A, "2002", "2026-09-17", "12:00", 900, 0); sale(A, "2002", "2026-09-10", "12:00", 950, 0);
  // Bangu: sem meta e sem venda
  // Nova Iguaçu: meta 0 (loja fechada?), vendas SEM hora confiável
  quota(A, nova, D, 0); sale(A, "2004", D, null, 400, 400); sale(A, "2004", D, "??", 100, 100);

  const snap = B.snapshot(A, D, { now: new Date(`${D}T19:30:00Z`) });
  const st = (name: string) => snap.stores.find((x: any) => x.storeName === name)!;
  const g = st("Grande Rio");
  check("EXEMPLO DO PRD: Grande Rio meta 2.500, vendido 1.050, atingimento 42%, falta 1.450, dinheiro 280", g.meta.value === 2500 && g.vendido.value === 1050 && g.atingimento.value === 42 && g.falta.value === 1450 && g.dinheiro.value === 280, JSON.stringify([g.meta.value, g.vendido.value, g.atingimento.value, g.falta.value, g.dinheiro.value]));
  check("vendas DEPOIS das 16h e canceladas ('C') não entram no parcial", g.vendido.value === 1050 && g.salesCount === 3);
  check("origem rotulada: caixa (PDV) parcial", snap.source === "pdv" && /pdv/.test(String(g.vendido.source)));

  check("ritmo: histórico suficiente (4 quintas) e hoje abaixo de 85% da média (1.050 < 1.275) → 'below' com mensagem", g.pace.status === "below" && g.pace.historyDays === 4 && /Grande Rio está abaixo do ritmo habitual deste horário/.test(g.pace.message || ""));
  check("ritmo é ESTIMATIVA (hipótese) com confiança, não fato: média 1.500 acumulada até 16h", g.pace.expected.state === "estimate" && g.pace.expected.value === 1500 && (g.pace.expected.confidence as number) > 0 && (g.pace.expected.confidence as number) <= 0.8);

  const c = st("Carioca");
  check("Carioca: atingimento 129% e falta 0 (meta batida, não negativo)", c.vendido.value === 1420 && Math.round(c.atingimento.value as number) === 129 && c.falta.value === 0 && c.falta.state === "value");
  check("Carioca: dinheiro NÃO calculado (forma de pagamento ausente em 1 de 2 vendas) — não soma parcial como total", c.dinheiro.state === "not_computed" && /1 de 2/.test(c.dinheiro.reason || ""));
  check("Carioca: só 2 dias de histórico → NÃO afirma ritmo (insufficient_history, sem mensagem)", c.pace.status === "insufficient_history" && c.pace.message === null && c.pace.historyDays === 2);

  const b = st("Bangu");
  check("Bangu sem meta e sem venda: meta '—', vendido '—' (NUNCA R$ 0,00), atingimento/falta 'Não calculado'", b.meta.state === "unknown" && b.vendido.state === "unknown" && b.atingimento.state === "not_computed" && b.falta.state === "not_computed" && b.dinheiro.state === "unknown");

  const nv = st("Nova Iguaçu");
  check("meta 0 → atingimento N/A (não 0%/Infinity); vendas sem hora confiável → sem afirmação de ritmo", nv.meta.value === 0 && nv.atingimento.state === "not_applicable" && nv.pace.status === "insufficient_history");
  check("sem hora confiável: usa o total do dia (não corta) e avisa via ritmo indisponível", nv.vendido.value === 500);

  check("REDE: total com loja sem dado NÃO é total (meta/vendido 'Não calculado'); parcial das lojas com dado à parte", snap.network.meta.state === "not_computed" && snap.network.vendido.state === "not_computed" && snap.network.partialVendido === 2970);
  check("REDE: atingimento e falta não calculados (nunca inventa)", snap.network.atingimento.state === "not_computed" && snap.network.falta.state === "not_computed");

  const txt = B.text(snap);
  check("texto no formato do PRD (Grande Rio — 16h / Meta / Vendido / Atingimento / Falta / Dinheiro)", /Grande Rio — 16h\nMeta: R\$ 2\.500\nVendido: R\$ 1\.050\nAtingimento: 42%\nFalta: R\$ 1\.450\nDinheiro: R\$ 280/.test(txt), txt.slice(0, 400));
  check("texto: Bangu mostra '—' e a rede 'Não calculado'; nunca 'R$ 0,00' por falta de dado", /Bangu — 16h\nMeta: —\nVendido: —/.test(txt) && /Rede\nMeta: Não calculado/.test(txt) && !/R\$ 0,00/.test(txt.split("Carioca")[0]) );
  check("texto: linha da IA só com o ritmo comprovado (Grande Rio), rotulada", /IA\nGrande Rio está abaixo do ritmo habitual/.test(txt) && !/Carioca está abaixo/.test(txt));
  check("texto: parcial das lojas com dado e origem 'não é o fechamento'; sem jargão técnico", /Vendido nas lojas com dado: R\$ 2\.970/.test(txt) && /Origem: caixa \(PDV\) — parcial, não é o fechamento/.test(txt) && !/retail_|pdv_sales|stockout|dead_letter/.test(txt));
  check("frescor: sem sync registrado → avisa que os dados podem estar desatualizados", snap.stale === true && /desatualizados/.test(txt));
  db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, 'sales', 'VendaMalote', '2001', '1', datetime('now'))`).run(randomUUID(), A);
  const fresh = B.snapshot(A, D, { now: new Date() });
  check("frescor: sync recente → sem aviso", fresh.stale === false && !/desatualizados/.test(B.text(fresh)));

  // ── parseSaleMinutes ──
  const p = S.parseSaleMinutes;
  check("hora da venda: HH:MM, HHMM, HH:MM:SS e ISO; lixo/24h+ → null", p("14:15") === 855 && p("1415") === 855 && p("14:15:30") === 855 && p("2026-09-24T14:15:00") === 855 && p("2026-09-24 14:15:00") === 855 && p("??") === null && p("") === null && p(null) === null && p("25:00") === null);

  // ── conteúdo ──
  check("dia sem meta e sem venda em nenhuma loja → sem conteúdo (não manda mensagem vazia)", !B.hasContent(B.snapshot(O, D)) && B.hasContent(snap));

  // ── entrega ──
  const user = (org: string, role: string, phone: string | null, status = "active") => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, org, role, `${id}@x.com`, phone, role, status); return id; };
  const bruno = user(A, "owner", "5521999990001"), admin = user(A, "admin", "5521999990002"), agent = user(A, "agent", "5521999990003"), noPhone = user(A, "owner", null), inactive = user(A, "admin", "5521999990004", "inactive");
  void agent; void noPhone; void inactive;
  const sent: Array<[string, string]> = [];
  const send = async (phone: string, text: string) => { sent.push([phone, text]); };
  const at = (h: number) => new Date(`${D}T${String(h + 3).padStart(2, "0")}:30:00Z`); // SP = UTC-3
  const off = await B.runPass(A, { now: at(16), send });
  check("opt-in: flag desligada não envia nada", off.sent === 0 && sent.length === 0 && B.enabled(A) === false);
  B.setEnabled(A, true);
  const early = await B.runPass(A, { now: at(15), send });
  const late = await B.runPass(A, { now: at(18), send });
  check("fora da janela 16h–18h (SP) não envia (15:30 e 18:30)", early.sent === 0 && late.sent === 0 && sent.length === 0);
  const r1 = await B.runPass(A, { now: at(16), send });
  check("16:30 SP: envia SÓ p/ owner/admin ativos com telefone (agent, sem telefone e inativo ficam de fora)", r1.sent === 2 && sent.map((s) => s[0]).sort().join() === "5521999990001,5521999990002" && /Parcial das 16h — 24\/09/.test(sent[0][1]));
  const r2 = await B.runPass(A, { now: at(17), send });
  check("dedupe por dia: 2ª passada não reenvia", r2.sent === 0 && r2.skipped === 2 && sent.length === 2);
  const forced = await B.runPass(A, { now: at(15), send, force: true });
  check("force ignora janela e dedupe (envio manual)", forced.sent === 2 && sent.length === 4);
  // falha de envio NÃO marca a entrega → retenta
  const O2 = `org_C_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), O2);
  const cs = store(O2, "Loja C", "3001"); quota(O2, cs, D, 1000); user(O2, "owner", "5521988880001"); B.setEnabled(O2, true);
  let attempts = 0; let failNext = true;
  const flaky = async (_p: string, _t: string) => { attempts++; if (failNext) { failNext = false; throw new Error("gateway down"); } };
  let threw = false; try { await B.runPass(O2, { now: at(16), send: flaky }); } catch { threw = true; }
  const retry = await B.runPass(O2, { now: at(17), send: flaky });
  check("falha de envio não marca como entregue: o próximo tick retenta e entrega", threw && retry.sent === 1 && attempts === 2);
  check("isolamento: mensagem da org A não vaza dados da C (e vice-versa)", !sent.some(([, t]) => /Loja C/.test(t)) && B.snapshot(O2, D).stores.length === 1 && B.snapshot(O2, D).stores[0].storeName === "Loja C");

  console.log("\n=== PRD Fase 1 · F1.6b: parcial das 16h ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
