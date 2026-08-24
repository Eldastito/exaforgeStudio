/**
 * TEST — Reverse Planning (ADR-189 F3, Mission OS). DB-backed, determinístico.
 * Prova: a cadeia reversa canônica (§11: R$100k ÷ ticket → vendas ÷ conv → oportunidades ÷ conv →
 * contatos − base → GAP), gargalo (caminho crítico), Último Momento Seguro (§15), derivação de
 * ticket/base do dado real, HONESTIDADE (premissa faltante → estágio unknown, cadeia para, nunca
 * inventa), não-receita → não-aplicável, read-only, isolamento.
 *
 * Uso: npm run test:mission-reverse-plan
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-revplan-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-revplan-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionReversePlanner: RP } = await import("../src/server/MissionReversePlanner.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const A = mkOrg();
  const stage = (p: any, name: string) => p.chain.find((s: any) => s.stage === name);

  // Missão de receita: R$100.000, prazo definido.
  const m = M.create(A, { title: "Bater R$100k", targetMetric: "revenue", targetValue: 100000, targetUnit: "BRL", deadline: "2026-09-30" });

  // 1. Cadeia canônica §11 com premissas informadas (ticket 500, conv 25%, conv 40%, base 1450).
  const p = RP.plan(A, m.id, { avgTicket: 500, saleConversionRate: 0.25, contactConversionRate: 0.40, baseAvailable: 1450 });
  check("1.1 vendas = ceil(100000/500) = 200", stage(p, "sales").value === 200);
  check("1.2 oportunidades = ceil(200/0.25) = 800", stage(p, "opportunities").value === 800);
  check("1.3 contatos = ceil(800/0.40) = 2000", stage(p, "contacts").value === 2000);
  check("1.4 GAP = 2000 − 1450 = 550", p.gap && p.gap.missing === 550);
  check("1.5 gargalo = contacts (base não sustenta)", p.criticalStage === "contacts");
  check("1.6 nota explica o gap", /faltam ~550/i.test(p.note));

  // 2. Último Momento Seguro (§15): prazo − leadTime.
  const p2 = RP.plan(A, m.id, { avgTicket: 500, saleConversionRate: 0.25, contactConversionRate: 0.40, baseAvailable: 1450, leadTimeDays: 10 });
  check("2.1 LSM = 2026-09-30 − 10 dias = 2026-09-20", p2.lastSafeMoment?.date === "2026-09-20");

  // 3. HONESTO: sem taxa de conversão → estágio unknown, cadeia para, gargalo aponta o unknown.
  const p3 = RP.plan(A, m.id, { avgTicket: 500, baseAvailable: 1450 });
  check("3.1 vendas ok, oportunidades unknown (sem taxa)", stage(p3, "sales").value === 200 && stage(p3, "opportunities").value === null && stage(p3, "opportunities").basis === "unknown");
  check("3.2 não inventa: sem contatos, sem gap, gargalo = opportunities", p3.gap === null && p3.criticalStage === "opportunities");

  // 4. Derivação do dado real: ticket médio de orders + base de contacts.
  const B = mkOrg();
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 250, '2026-06-10 10:00:00')`).run(oid, B);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 250, 1, 250, 100)`).run(randomUUID(), oid, B);
  for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), B, `id${i}`);
  const mB = M.create(B, { title: "meta", targetMetric: "revenue", targetValue: 1000, targetUnit: "BRL" });
  const pB = RP.plan(B, mB.id, {}); // sem opts → deriva tudo
  check("4.1 ticket médio derivado de orders (250) → vendas ceil(1000/250)=4", stage(pB, "sales").value === 4 && pB.assumptions.avgTicketSource === "orders");
  check("4.2 base derivada de contacts (3)", pB.base.available === 3 && pB.base.source === "contacts");

  // 5. Não-receita / sem alvo → não aplicável (honesto).
  const mQ = M.create(A, { title: "reduzir tempo de resposta" });
  const pQ = RP.plan(A, mQ.id, {});
  check("5.1 missão qualitativa → applicable false", pQ.applicable === false && pQ.chain.length === 0);

  // 6. Read-only: planejar não grava nada.
  const before = (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n;
  RP.plan(A, m.id, {}); RP.plan(A, m.id, {});
  check("6.1 read-only (nº de missões intacto)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n === before);

  // 7. Isolamento: planejar missão de outra org → erro.
  let isolated = false; try { RP.plan(B, m.id, {}); } catch { isolated = true; }
  check("7.1 cross-org → missão não encontrada", isolated);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-reverse-plan: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
