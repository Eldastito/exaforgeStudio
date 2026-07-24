/**
 * TESTE — Detectores de AGENDA e VENDAS sobre o motor genérico
 * (PatternMemoryService, ADR-142 generalizada). Sétimo e oitavo domínios.
 *
 *   Agenda (appointments):
 *     - cliente_no_show_recorrente: cliente que falta com frequência;
 *     - horario_no_show_recorrente: faixa de dia/hora com muito no-show.
 *   Vendas (order_items × orders):
 *     - produto_queda_giro_recorrente: produto com giro (un/mês) caindo;
 *     - categoria_queda_giro_recorrente: o mesmo por categoria.
 *   Validados viram sinais dos seus domínios e entram no Pareto com ação.
 *
 * Hypothesizer injetado (zero-token). Uso:  npm run test:agenda-sales-patterns
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-agenda-sales-patterns-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-agenda-sales-patterns-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const noLLM = async () => ({});

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function monthsAgo(n: number, day = 15) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); d.setUTCDate(day); return ymd(d); }
// Data da última ocorrência do dia-da-semana `dow` (0=Dom..6=Sáb), `weeksBack` semanas atrás.
function lastWeekday(dow: number, weeksBack: number) { const d = new Date(); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1); d.setUTCDate(d.getUTCDate() - weeksBack * 7); return ymd(d); }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService } = await import("../src/server/PatternMemoryService.js");
  const { AgendaPatternMemory } = await import("../src/server/AgendaPatternMemory.js");
  const { SalesPatternMemory } = await import("../src/server/SalesPatternMemory.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  PatternMemoryService.setEnabled(A, true);
  const today = ymd(new Date());

  const mkContact = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', ?, ?)`).run(id, A, name, `id_${id.slice(0, 6)}`); return id; };
  const appt = (contact: string, date: string, hour: number, status: string) =>
    db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status) VALUES (?, ?, ?, 'Serviço', ?, ?)`)
      .run(randomUUID(), A, contact, `${date} ${String(hour).padStart(2, "0")}:00:00`, status);

  // ===== AGENDA =====
  // (a) Cliente que falta: 4 no-shows em slots DIFERENTES (não dispara o detector de horário) + 1 comparecido.
  const faltoso = mkContact("Cliente Faltoso");
  [[3, 9], [10, 11], [20, 14], [31, 16]].forEach(([d, h]) => { const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - d); appt(faltoso, ymd(dt), h, "no_show"); });
  { const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - 40); appt(faltoso, ymd(dt), 10, "completed"); }

  // (b) Horário ruim: 4 no-shows na MESMA faixa (sexta 18h), clientes diferentes (não dispara o detector de cliente).
  for (let w = 0; w < 4; w++) appt(mkContact(`C${w}`), lastWeekday(5, w), 18, "no_show");

  const ra = await AgendaPatternMemory.learnPass(A, { asOf: today, hypothesizer: noLLM });
  check("agenda aprende 2 padrões (cliente + horário)", ra.enabled === true && ra.detected === 2 && ra.validated === 2 && ra.published === 2, JSON.stringify(ra));
  const agTypes = new Set(PatternMemoryService.list(A, { domain: "agenda" }).map((p: any) => p.pattern_type));
  check("no-show por cliente aprendido", agTypes.has("cliente_no_show_recorrente"));
  check("no-show por horário aprendido", agTypes.has("horario_no_show_recorrente"));
  const agSigs = db.prepare(`SELECT signal_type FROM business_signals WHERE organization_id=? AND domain='agenda' AND status='open' AND source_service='AgendaPatternMemory'`).all(A) as any[];
  check("2 sinais de agenda publicados", agSigs.length === 2, JSON.stringify(agSigs.map((s) => s.signal_type)));

  // ===== VENDAS =====
  // Produto com giro em queda (5 meses: 50→10). Categoria "Vestuário" herda a mesma série.
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, category) VALUES (?, ?, 'product', 'Camiseta', 40, 1, 'Vestuário')`).run(prod, A);
  const units = [50, 40, 30, 20, 10];
  units.forEach((u, idx) => {
    const n = units.length - 1 - idx; // idx0 = mais antigo
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'concluido', ?, ?)`).run(oid, A, u * 40, `${monthsAgo(n, 15)} 12:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, ?, 'Camiseta', 40, ?, ?)`).run(randomUUID(), oid, A, prod, u, u * 40);
  });

  const rs = await SalesPatternMemory.learnPass(A, { asOf: today, windowWeeks: 40, hypothesizer: noLLM });
  check("vendas aprende 2 padrões (produto + categoria)", rs.enabled === true && rs.detected === 2 && rs.validated === 2 && rs.published === 2, JSON.stringify(rs));
  const salesTypes = new Set(PatternMemoryService.list(A, { domain: "sales" }).map((p: any) => p.pattern_type));
  check("queda de giro do produto aprendida", salesTypes.has("produto_queda_giro_recorrente"));
  check("queda de giro da categoria aprendida", salesTypes.has("categoria_queda_giro_recorrente"));
  const salesSigs = db.prepare(`SELECT signal_type FROM business_signals WHERE organization_id=? AND domain='sales' AND status='open' AND source_service='SalesPatternMemory'`).all(A) as any[];
  check("2 sinais de vendas publicados", salesSigs.length === 2, JSON.stringify(salesSigs.map((s) => s.signal_type)));

  // ===== Pareto com as ações recomendadas =====
  const pareto = ImpactPrioritizationService.prioritize(A, { globalLimit: 30 }).global;
  const find = (t: string) => pareto.find((p: any) => p.signalType === t);
  check("cliente faltoso no Pareto (ação de sinal/presença)", /presença|sinal/i.test(find("cliente_no_show_recorrente")?.recommendedAction || ""), find("cliente_no_show_recorrente")?.recommendedAction);
  check("horário ruim no Pareto (ação de lembrete/encaixe)", /lembrete|encaixe/i.test(find("horario_no_show_recorrente")?.recommendedAction || ""), find("horario_no_show_recorrente")?.recommendedAction);
  check("produto em queda no Pareto (ação de giro)", /giro|preço|vitrine/i.test(find("produto_queda_giro_recorrente")?.recommendedAction || ""), find("produto_queda_giro_recorrente")?.recommendedAction);
  check("categoria em queda no Pareto (ação de mix)", /mix|categoria/i.test(find("categoria_queda_giro_recorrente")?.recommendedAction || ""), find("categoria_queda_giro_recorrente")?.recommendedAction);

  // ===== Fecha o loop =====
  const anyPattern = PatternMemoryService.list(A, { domain: "sales" })[0];
  const rec = PatternMemoryService.recordOutcome(A, anyPattern.id, { outcome: "worked" });
  check("recordOutcome fecha o loop", rec.ok === true && rec.effectiveness === 1, JSON.stringify(rec));

  // ===== Opt-in + isolamento =====
  const rbA = await AgendaPatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  const rbS = await SalesPatternMemory.learnPass(B, { asOf: today, hypothesizer: noLLM });
  check("org B (desligada) não aprende", rbA.enabled === false && rbS.enabled === false);
  check("isolamento: org B sem padrões", PatternMemoryService.list(B).length === 0);

  console.log("\n=== Detectores de agenda e vendas (motor genérico) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
