/**
 * TESTE — Detectores de FINANÇAS e PESSOAS sobre o motor genérico
 * (PatternMemoryService, ADR-142 generalizada).
 *
 * Mais duas provas de que a extração pegou — dois domínios ganham memória de
 * padrões escrevendo só os seus detectores, sobre dados reais:
 *   Finanças (payables / receivables):
 *     - cliente_pagamento_atrasado_recorrente: cliente que paga fora do prazo;
 *     - categoria_despesa_estoura_recorrente: categoria de despesa em alta.
 *   Pessoas (orders por vendedor):
 *     - vendedor_queda_recorrente: vendedor com vendas caindo mês a mês.
 * Os validados viram sinais dos seus domínios e entram no Pareto com ação.
 *
 * Hypothesizer injetado (zero-token). Uso:  npm run test:finance-people-patterns
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fin-people-patterns-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-fin-people-patterns-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function monthsAgo(n: number, day = 15) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); d.setUTCDate(day); return ymd(d); }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { FinancePatternMemory } = await import("../src/server/FinancePatternMemory.js");
  const { PeoplePatternMemory } = await import("../src/server/PeoplePatternMemory.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  PatternMemoryService.setEnabled(A, true);
  const today = ymd(new Date());

  // ===== FINANÇAS =====
  // (a) Cliente que paga atrasado: 4 recebimentos tardios + 1 no prazo.
  const contactId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente Beta', ?)`).run(contactId, A, `id_${contactId.slice(0, 6)}`);
  for (let i = 1; i <= 4; i++) { // meses anteriores (evita datas futuras no mês corrente)
    db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status, received_at) VALUES (?, ?, ?, 'Fiado', 500, ?, 'received', ?)`)
      .run(randomUUID(), A, contactId, monthsAgo(i, 10), `${monthsAgo(i, 25)} 12:00:00`); // recebido dia 25 > vencimento dia 10
  }
  db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status, received_at) VALUES (?, ?, ?, 'Fiado', 500, ?, 'received', ?)`)
    .run(randomUUID(), A, contactId, monthsAgo(0, 10), `${monthsAgo(0, 5)} 12:00:00`); // no prazo (dia 5 < 10)

  // (b) Categoria de despesa que estoura: 4 meses altos + 2 baixos → 4 de 6 acima do normal.
  const catAmounts = [300, 300, 300, 300, 100, 100];
  catAmounts.forEach((amt, i) => db.prepare(`INSERT INTO payables (id, organization_id, description, category, amount, due_date, status) VALUES (?, ?, 'Anúncios', 'Marketing', ?, ?, 'open')`)
    .run(randomUUID(), A, amt, monthsAgo(i, 15)));

  const rf = await FinancePatternMemory.learnPass(A, { asOf: today, windowWeeks: 40, hypothesizer: noLLM });
  check("finanças aprende 2 padrões (validados)", rf.enabled === true && rf.detected === 2 && rf.validated === 2 && rf.published === 2, JSON.stringify(rf));
  const finTypes = new Set(PatternMemoryService.list(A, { domain: "finance" }).map((p: any) => p.pattern_type));
  check("cliente atrasa aprendido", finTypes.has("cliente_pagamento_atrasado_recorrente"));
  check("categoria de despesa estoura aprendida", finTypes.has("categoria_despesa_estoura_recorrente"));
  const finSigs = db.prepare(`SELECT signal_type FROM business_signals WHERE organization_id=? AND domain='finance' AND status='open' AND source_service='FinancePatternMemory'`).all(A) as any[];
  check("2 sinais de finanças publicados", finSigs.length === 2, JSON.stringify(finSigs.map((s) => s.signal_type)));

  // ===== PESSOAS =====
  // Vendedor com queda mês a mês: 5 meses descendentes (1000→200) = 4 quedas.
  const sellerId = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Carla', ?)`).run(sellerId, A, `c_${sellerId.slice(0, 6)}@x.com`);
  const totals = [1000, 800, 600, 400, 200];
  totals.forEach((amt, idx) => {
    const n = totals.length - 1 - idx; // idx0 = mais antigo
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, seller_user_id, created_at) VALUES (?, ?, 'concluido', ?, ?, ?)`)
      .run(randomUUID(), A, amt, sellerId, `${monthsAgo(n, 15)} 12:00:00`);
  });

  const rpp = await PeoplePatternMemory.learnPass(A, { asOf: today, windowWeeks: 40, hypothesizer: noLLM });
  check("pessoas aprende queda do vendedor (validado)", rpp.enabled === true && rpp.detected === 1 && rpp.validated === 1 && rpp.published === 1, JSON.stringify(rpp));
  const peopleSig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND domain='people' AND signal_type='vendedor_queda_recorrente' AND status='open'`).get(A) as any;
  check("vendedor em queda virou sinal 'people'", !!peopleSig && peopleSig.source_service === "PeoplePatternMemory", JSON.stringify({ has: !!peopleSig }));

  // ===== Pareto com as ações recomendadas =====
  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 20 }).global;
  const find = (t: string) => pareto.find((p: any) => p.signalType === t);
  check("cliente atrasa no Pareto (ação de prazo/limite)", /prazo|limite/i.test(find("cliente_pagamento_atrasado_recorrente")?.recommendedAction || ""), find("cliente_pagamento_atrasado_recorrente")?.recommendedAction);
  check("despesa em alta no Pareto (ação de cortar)", /cortar|revisar/i.test(find("categoria_despesa_estoura_recorrente")?.recommendedAction || ""), find("categoria_despesa_estoura_recorrente")?.recommendedAction);
  check("vendedor em queda no Pareto (ação de apoio)", /coaching|meta|apoiar/i.test(find("vendedor_queda_recorrente")?.recommendedAction || ""), find("vendedor_queda_recorrente")?.recommendedAction);

  // ===== Fecha o loop no domínio pessoas =====
  const peoplePattern = PatternMemoryService.list(A, { domain: "people" })[0];
  const rec = PatternMemoryService.recordOutcome(A, peoplePattern.id, { outcome: "worked" });
  check("recordOutcome no domínio pessoas", rec.ok === true && rec.effectiveness === 1, JSON.stringify(rec));

  // ===== Opt-in + isolamento =====
  const rbFin = await FinancePatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  const rbPeople = await PeoplePatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  check("org B (desligada) não aprende", rbFin.enabled === false && rbPeople.enabled === false);
  check("isolamento: org B sem padrões", PatternMemoryService.list(B).length === 0);

  console.log("\n=== Detectores de finanças e pessoas (motor genérico) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
