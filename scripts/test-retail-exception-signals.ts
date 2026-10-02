/**
 * TESTE — PRD Fase 1 §9/§26 (S4c-2): "Bangu está sem escala" e "N vendedores ainda precisam ser identificados" como ASSUNTOS da
 * Central de Saúde (sinais em business_signals, publicados/auto-resolvidos pelo publicador do varejo), com UMA fonte de verdade.
 * Prova: regra honesta de "sem escala" (org que não usa escala não é cobrada; loja que nunca usou não é cobrada; FOLGA GERAL não é
 * sem escala; loja que não abre no dia não conta); publica e é idempotente; auto-resolve quando a escala é lançada e quando o dia
 * vira; NASCE LIGADO e desligar fecha o que estava aberto; linguagem do gestor (ação "Identificar vendedores"); a Central mostra
 * "N assuntos precisam de atenção" (não "sob controle"); o panorama não repete o que já está na lista; isolamento por org.
 * Uso:  npm run test:retail-exception-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-excsig-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-excsig-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const X = (await import("../src/server/RetailExceptionSignalService.js")).RetailExceptionSignalService;
  const { RetailOpsSignalPublisher: Pub } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { RetailDayBriefService: Day } = await import("../src/server/RetailDayBriefService.js");
  const { ExecutiveDecisionTools: Dec } = await import("../src/server/ExecutiveDecisionTools.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { ImpactPrioritizationService: Imp } = await import("../src/server/ImpactPrioritizationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const day = (k: number) => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
  const D = day(0);
  const entry = (org: string, st: string, date: string, status = "work") => db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, 'mat:1', 'Ana', ?)`).run(randomUUID(), org, st, date, status);
  const open = (org: string, type: string) => db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = ? AND status = 'open'`).all(org, type) as any[];

  // ── regra honesta de "sem escala" ──
  const N = mkOrg(); const n1 = store(N, "Bangu");
  check("org que NÃO usa escala (nenhuma entrada): ninguém é cobrado", X.storesWithoutSchedule(N, D).length === 0);

  const A = mkOrg();
  const bangu = store(A, "Bangu"), carioca = store(A, "Carioca"), grande = store(A, "Grande Rio"), nova = store(A, "Nova Iguaçu"), fechada = store(A, "Loja de Rua");
  entry(A, carioca, D);                                  // Carioca: tem escala hoje
  entry(A, bangu, day(-5));                              // Bangu: usa escala, mas NADA lançado hoje → sem escala
  entry(A, nova, D, "off"); entry(A, nova, day(-3));     // Nova Iguaçu: folga geral hoje (todas 'off') → NÃO é sem escala
  // Grande Rio: nunca usou escala → não é cobrada
  const dow = new Date(`${D}T12:00:00Z`).getUTCDay();
  db.prepare(`UPDATE retail_stores SET closed_weekdays = ? WHERE id = ?`).run(JSON.stringify([dow]), fechada); entry(A, fechada, day(-4));   // não abre hoje → não conta
  const sem = X.storesWithoutSchedule(A, D).map((s) => s.name);
  check("sem escala = só quem PARTICIPA da escala, ABRE hoje e não tem nenhuma entrada (Bangu)", sem.length === 1 && sem[0] === "Bangu", JSON.stringify(sem));
  check("folga geral (todas 'off') NÃO é 'sem escala'; loja que nunca usou e loja que não abre não são cobradas", !sem.includes("Nova Iguaçu") && !sem.includes("Grande Rio") && !sem.includes("Loja de Rua"));
  const old = mkOrg(); const os1 = store(old, "Velha"); entry(old, os1, day(-90));
  check("escala antiga (> 31 dias) não conta como 'usa escala'", X.storesWithoutSchedule(old, D).length === 0);

  // ── vendedores a identificar ──
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo) VALUES (?, ?, '1', 'B1', ?, '7777', '7777')`).run(randomUUID(), A, D);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo) VALUES (?, ?, '1', 'B2', ?, '8888', '8888')`).run(randomUUID(), A, D);
  const items = X.items(A, D);
  check("as exceções do dia: Bangu sem escala + 2 vendedores a identificar (texto do gestor)", items.some((i) => i.text === "Bangu está sem escala.") && items.some((i) => i.text === "2 vendedores ainda precisam ser identificados."), JSON.stringify(items));
  check("o resumo da manhã usa a MESMA fonte (nada de regra duplicada)", JSON.stringify(Day.morningExceptions(A, D)) === JSON.stringify(items.map((i) => i.text)));

  // ── nasce LIGADO ──
  check("NASCE LIGADO (org nova)", X.enabled(A) === true && (db.prepare(`SELECT retail_exception_signals_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(A) as any).e === 1);

  // ── publica, idempotente, linguagem ──
  Pub.run(A, { asOf: D });
  const ns = open(A, "retail_store_no_schedule"), su = open(A, "retail_sellers_unidentified");
  check("publica 1 sinal 'sem escala' (Bangu) e 1 'vendedores a identificar' (domínio varejo, atenção)", ns.length === 1 && su.length === 1 && ns[0].severity === "attention" && ns[0].domain === "retail_ops", `${ns.length}/${su.length}`);
  Pub.run(A, { asOf: D });
  check("idempotente: rodar de novo não duplica", open(A, "retail_store_no_schedule").length === 1 && open(A, "retail_sellers_unidentified").length === 1);
  const pr = (Imp.prioritize(A, { globalLimit: 50 }) as any).global as any[];
  const pNs = pr.find((p) => p.signalType === "retail_store_no_schedule"), pSu = pr.find((p) => p.signalType === "retail_sellers_unidentified");
  check("linguagem do gestor: 'Bangu está sem escala hoje' · ação 'Montar a escala'", pNs?.presentation?.title === "Bangu está sem escala hoje" && pNs?.presentation?.actionLabel === "Montar a escala" && !/retail_|signal/.test(JSON.stringify(pNs?.presentation)), JSON.stringify(pNs?.presentation));
  check("'2 vendedores ainda precisam ser identificados' · ação 'Identificar vendedores' (rótulo do PRD §23)", pSu?.presentation?.title === "2 vendedores ainda precisam ser identificados" && pSu?.presentation?.actionLabel === "Identificar vendedores", JSON.stringify(pSu?.presentation));

  // ── Central: assuntos, não 'sob controle' ──
  const ov = H.overview(A) as any;
  check("a Central mostra 'N assuntos precisam de atenção' (nunca 'sob controle' junto de assuntos abertos)", ov.attention.count >= 2 && !/Nenhuma ação humana necessária/.test(ov.synthesis) && ov.statusLabel !== "Saudável", `${ov.synthesis} | ${ov.statusLabel}`);

  // ── panorama não repete ──
  const pan = Dec.panoramaOperacao(A, D).summary || "";
  check("panorama: o que já está na lista de atenção não é repetido numa linha 'Exceções'", /precisam de atenção/.test(pan) && !/Exceções:/.test(pan), pan);

  // ── auto-resolve: escala lançada ──
  entry(A, bangu, D);
  Pub.run(A, { asOf: D });
  check("lançou a escala do Bangu → o sinal 'sem escala' se resolve sozinho", open(A, "retail_store_no_schedule").length === 0 && open(A, "retail_sellers_unidentified").length === 1);
  // identifica os vendedores → resolve
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, '7777', 'Marcos')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, '8888', 'Lúcia')`).run(randomUUID(), A);
  Pub.run(A, { asOf: D });
  check("deu nome às matrículas → o sinal de 'vendedores a identificar' se resolve", open(A, "retail_sellers_unidentified").length === 0);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo) VALUES (?, ?, '1', 'B3', ?, '9999', '9999')`).run(randomUUID(), A, D);
  Pub.run(A, { asOf: D });
  check("RECORRÊNCIA: apareceu outra matrícula sem nome → o sinal (que já tinha sido resolvido) REABRE (não some pra sempre)", open(A, "retail_sellers_unidentified").length === 1 && /1 vendedor ainda precisa/.test(JSON.stringify((Imp.prioritize(A, { globalLimit: 50 }) as any).global.find((p: any) => p.signalType === "retail_sellers_unidentified")?.presentation || {})));

  // ── o dia vira: sinal de ontem se resolve ──
  const R = mkOrg(); const rb = store(R, "Bangu"); entry(R, rb, day(-2));
  Pub.run(R, { asOf: D });
  check("hoje sem escala → sinal aberto", open(R, "retail_store_no_schedule").length === 1);
  entry(R, rb, day(1));
  Pub.run(R, { asOf: day(1) });
  check("virou o dia e o novo dia TEM escala → o sinal de ontem se resolve (não fica velho na Central)", open(R, "retail_store_no_schedule").length === 0);

  // ── desligar ──
  const Z = mkOrg(); const zb = store(Z, "Bangu"); entry(Z, zb, day(-2));
  Pub.run(Z, { asOf: D });
  check("(Z) publica enquanto ligado", open(Z, "retail_store_no_schedule").length === 1);
  X.setEnabled(Z, false);
  Pub.run(Z, { asOf: D });
  check("desligado: o publicador FECHA o que estava aberto e não publica de novo", X.enabled(Z) === false && open(Z, "retail_store_no_schedule").length === 0);
  X.setEnabled(Z, true); Pub.run(Z, { asOf: D });
  check("religou: volta a publicar (reversível)", open(Z, "retail_store_no_schedule").length === 1);

  // ── isolamento ──
  check("isolamento: a org N (sem escala/sem vendas) não recebe nada da A", open(N, "retail_store_no_schedule").length === 0 && open(N, "retail_sellers_unidentified").length === 0 && X.items(N, D).length === 0);

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
