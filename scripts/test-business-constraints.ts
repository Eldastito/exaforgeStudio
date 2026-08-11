/**
 * TEST — PRD 3 F4 (§14/§15): BusinessGoal RICO + BusinessConstraint. DB-backed,
 * isolado por tmpDir. Prova, determinístico:
 *
 *   Goals ricos (§14):
 *     - set() grava title/baseline/deadline/priority/owner/status; update PARCIAL
 *       preserva os campos não informados; valida priority/status/baseline;
 *     - list() devolve os metadados ricos (todas as metas, qualquer status);
 *     - progress() só conta ATIVAS por padrão (pausada/abandonada some), ordena por
 *       prioridade, e deriva attainmentFromBaselinePct quando há baseline;
 *     - retrocompat: set() antigo (só metric+target) segue funcionando.
 *
 *   Constraints (§15):
 *     - create valida kind/operator/valor; list/applicable (global + escopo);
 *     - update/setActive/remove; isolamento multi-tenant; audit não quebra.
 *
 *   Resolver (F3): o ContextPacket ganha `constraints` (aplicáveis à âncora) e as
 *   metas ricas fluem pro pacote.
 *
 * Uso: npm run test:business-constraints
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-constraints-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-constraints-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessGoalService: GOALS } = await import("../src/server/BusinessGoalService.js");
  const { BusinessConstraintService: CONS } = await import("../src/server/BusinessConstraintService.js");
  const { ContextResolverService: R } = await import("../src/server/ContextResolverService.js");

  const mkOrg = (name = "X") => {
    const id = uid("org");
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name);
    return id;
  };
  const seedAppointments = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, created_at) VALUES (?, ?, ?, 'A', 'confirmed', CURRENT_TIMESTAMP)`).run(randomUUID(), orgId, randomUUID());
  };

  // ═══════════════ GOALS RICOS (§14) ═══════════════
  const orgA = mkOrg("Empresa A");

  // set com campos ricos
  const g1 = GOALS.set(orgA, { metric: "revenue", targetAmount: 100000, title: "Receita agosto", baseline: 20000, deadline: "2026-08-31", priority: "high", owner: "u-boss", status: "active" });
  check("1.1 set grava campos ricos", g1.title === "Receita agosto" && g1.baseline === 20000 && g1.deadline === "2026-08-31" && g1.priority === "high" && g1.owner === "u-boss" && g1.status === "active");

  // update PARCIAL: muda só o target, preserva os ricos
  const g2 = GOALS.set(orgA, { metric: "revenue", targetAmount: 120000 });
  check("1.2 update parcial preserva os campos ricos", g2.target === 120000 && g2.title === "Receita agosto" && g2.priority === "high" && g2.baseline === 20000);

  // update explícito de um campo rico
  const g3 = GOALS.set(orgA, { metric: "revenue", targetAmount: 120000, priority: "critical" });
  check("1.3 update explícito muda só o campo informado", g3.priority === "critical" && g3.title === "Receita agosto");

  // null explícito limpa
  const g4 = GOALS.set(orgA, { metric: "revenue", targetAmount: 120000, owner: null });
  check("1.4 null explícito limpa o campo", g4.owner === null && g4.title === "Receita agosto");

  // validações
  let badPrio = false; try { GOALS.set(orgA, { metric: "revenue", targetAmount: 1, priority: "urgentíssimo" as any }); } catch { badPrio = true; }
  check("1.5 priority inválida rejeitada", badPrio);
  let badStatus = false; try { GOALS.set(orgA, { metric: "revenue", targetAmount: 1, status: "sei_la" as any }); } catch { badStatus = true; }
  check("1.6 status inválido rejeitado", badStatus);

  // retrocompat: set antigo
  const gc = GOALS.set(orgA, { metric: "appointments", targetAmount: 10 });
  check("1.7 retrocompat: set só metric+target funciona (status default active)", gc.status === "active" && gc.priority === null);

  // list traz ricos
  const listed = GOALS.list(orgA).find((g: any) => g.metric === "revenue")!;
  check("1.8 list expõe os campos ricos", listed.title === "Receita agosto" && listed.priority === "critical" && listed.status === "active");

  // progress: status filter — pausar a meta de revenue some do progress
  GOALS.set(orgA, { metric: "revenue", targetAmount: 120000, status: "paused" });
  seedAppointments(orgA, 4);
  const prog = GOALS.progress(orgA, { asOf: "2026-06-15T12:00:00Z" });
  check("2.1 progress só conta ATIVAS (revenue pausada sumiu)", !prog.goals.some((g: any) => g.metric === "revenue") && prog.goals.some((g: any) => g.metric === "appointments"));
  const progAll = GOALS.progress(orgA, { asOf: "2026-06-15T12:00:00Z", includeInactive: true });
  check("2.2 includeInactive traz a pausada de volta", progAll.goals.some((g: any) => g.metric === "revenue"));

  // baseline attainment: reativa revenue, semeia nada de receita → current 0
  GOALS.set(orgA, { metric: "revenue", targetAmount: 120000, status: "active", baseline: 20000 });
  const progB = GOALS.progress(orgA, { asOf: "2026-06-15T12:00:00Z", includeInactive: true });
  const gRev = progB.goals.find((g: any) => g.metric === "revenue")!;
  // current 0 (sem receita), baseline 20000, target 120000 → (0-20000)/(120000-20000) = -20%
  check("2.3 attainmentFromBaselinePct derivado do baseline", gRev.attainmentFromBaselinePct === -20 && gRev.attainmentPct === 0);

  // ordenação por prioridade
  GOALS.set(orgA, { metric: "revenue", targetAmount: 120000, status: "active", priority: "critical" });
  GOALS.set(orgA, { metric: "appointments", targetAmount: 10, priority: "low" });
  const progOrder = GOALS.progress(orgA, { asOf: "2026-06-15T12:00:00Z" });
  check("2.4 progress ordena por prioridade (critical antes de low)", progOrder.goals[0].metric === "revenue" && progOrder.goals[1].metric === "appointments");

  // ═══════════════ CONSTRAINTS (§15) ═══════════════
  // criar
  const c1 = CONS.create(orgA, { kind: "discount_ceiling", name: "Teto de desconto", operator: "lte", valueNum: 15, valueUnit: "percent" }, "u-boss");
  check("3.1 create grava restrição numérica", c1.kind === "discount_ceiling" && c1.value_num === 15 && c1.operator === "lte" && c1.source === "owner_declared" && c1.active === 1);
  const c2 = CONS.create(orgA, { kind: "policy", name: "Sem venda a prazo p/ inadimplente", valueText: "bloquear fiado se score < 30" }, "u-boss");
  check("3.2 create aceita restrição textual (policy)", c2.value_text?.includes("bloquear") && c2.value_num === null);

  // validações
  let badKind = false; try { CONS.create(orgA, { kind: "meia_boca" as any, name: "x", valueNum: 1 }); } catch { badKind = true; }
  check("3.3 kind inválido rejeitado", badKind);
  let noValue = false; try { CONS.create(orgA, { kind: "custom", name: "sem valor" }); } catch { noValue = true; }
  check("3.4 restrição sem valueNum nem valueText rejeitada", noValue);

  // escopada a um produto
  const prod = uid("prod");
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES (?, ?, 'product', 'Café', 1)`).run(prod, orgA);
  CONS.create(orgA, { kind: "margin_floor", name: "Margem mínima do Café", operator: "gte", valueNum: 30, valueUnit: "percent", scopeType: "product", scopeRef: prod }, "u-boss");

  // list + applicable
  check("3.5 list traz as ativas", CONS.list(orgA).length === 3);
  const appGlobal = CONS.applicable(orgA, {});
  check("3.6 applicable() sem escopo → só globais (as 2 sem scope)", appGlobal.length === 2 && appGlobal.every((c: any) => !c.scope_type));
  const appProd = CONS.applicable(orgA, { scopeType: "product", scopeRef: prod });
  check("3.7 applicable(product) → globais + a do produto (3)", appProd.length === 3 && appProd.some((c: any) => c.scope_ref === prod));
  const appOther = CONS.applicable(orgA, { scopeType: "product", scopeRef: "outro-produto" });
  check("3.8 applicable(outro produto) → só globais (a do Café não casa)", appOther.length === 2);

  // update + setActive
  const c1u = CONS.update(orgA, c1.id, { kind: "discount_ceiling", name: "Teto de desconto", operator: "lte", valueNum: 10, valueUnit: "percent" }, "u-boss");
  check("3.9 update muda o valor", c1u.value_num === 10);
  CONS.setActive(orgA, c1.id, false, "u-boss");
  check("3.10 setActive(false) tira das ativas/applicable", CONS.list(orgA).length === 2 && !CONS.applicable(orgA, {}).some((c: any) => c.id === c1.id));

  // ═══════════════ ISOLAMENTO ═══════════════
  const orgB = mkOrg("Empresa B");
  CONS.create(orgB, { kind: "budget_limit", name: "Orçamento B", valueNum: 5000, valueUnit: "BRL" });
  check("4.1 restrição de B não aparece em A", !CONS.list(orgA).some((c: any) => c.name === "Orçamento B") && CONS.list(orgB).length === 1);
  check("4.2 get cross-tenant → null", CONS.get(orgA, CONS.list(orgB)[0].id) === null);
  check("4.3 remove cross-tenant não afeta (changes 0)", CONS.remove(orgA, CONS.list(orgB)[0].id).removed === 0 && CONS.list(orgB).length === 1);

  // ═══════════════ RESOLVER (F3): pacote ganha constraints + metas ricas ═══════
  const pkt = R.resolve(orgA, { intent: "precificar_cafe", focus: `product:${prod}` });
  check("5.1 pacote tem constraints aplicáveis à âncora (product): globais + a do produto", pkt.constraints.length >= 1 && pkt.constraints.some((c: any) => c.scopeRef === prod && c.kind === "margin_floor"));
  check("5.2 constraint traduzida (ContextConstraint: value/unit/source)", pkt.constraints.every((c: any) => typeof c.kind === "string" && "value" in c && c.source.type === "APPROVED_CONFIG"));
  const pktOrg = R.resolve(orgA, { intent: "panorama" });
  check("5.3 sem âncora → só constraints globais", pktOrg.constraints.every((c: any) => !c.scopeType) && pktOrg.constraints.length >= 1);
  check("5.4 metas ricas fluem pro pacote (priority/status presentes)", pktOrg.goals.some((g: any) => g.priority === "critical" && g.status === "active"));

  console.log("\n=== TEST: BusinessGoal rico + BusinessConstraint (PRD 3 F4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ BusinessGoal rico + BusinessConstraint (F4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
