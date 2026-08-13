/**
 * TEST — Campaign Objective Contract (PRD 11 / ADR-168 F2). DB-backed, determinístico.
 * Prova: objetivo LIGADO a métrica de negócio via correlation_id; ENGAGEMENT≠BUSINESS VALUE
 * (objetivos de vaidade → sem métrica, RN-CG-01); progresso = distância-à-meta reusando
 * BusinessGoalService; GROUNDED (nunca inventa meta, RN-CG-09); isolamento multi-tenant.
 *
 * Uso: npm run test:campaign-objective
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-campobj-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-campobj-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CampaignObjectiveContractService: SVC } = await import("../src/server/CampaignObjectiveContractService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");

  const orgA = `org_co_${randomUUID().slice(0, 8)}`;
  const orgB = `org_co_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }

  // ── 1. Schema ──
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_objective_contracts'`).get();
  check("1.1 tabela campaign_objective_contracts existe", !!tbl);

  // ── 2. Catálogo enriquecido: objetivo de negócio vs vaidade (RN-CG-01) ──
  const objs = SVC.objectives();
  const vendas = objs.find((o: any) => o.id === "vendas");
  const engaj = objs.find((o: any) => o.id === "engajamento");
  const agend = objs.find((o: any) => o.id === "agendamento");
  check("2.1 vendas → métrica revenue (negócio)", vendas?.suggestedMetric === "revenue" && vendas?.hasBusinessMetric === true);
  check("2.2 agendamento → appointments", agend?.suggestedMetric === "appointments" && agend?.hasBusinessMetric === true);
  check("2.3 engajamento → VAIDADE (sem métrica de negócio)", engaj?.suggestedMetric === null && engaj?.hasBusinessMetric === false);
  check("2.4 métrica traz label do catálogo de metas", !!vendas?.metricLabel && vendas?.metricLabel.length > 0);

  // ── 3. Create com métrica default + correlation_id ──
  const c1 = SVC.create(orgA, "user-1", { objectiveId: "vendas", title: "Coleção linho" });
  check("3.1 contrato criado active", c1.status === "active");
  check("3.2 objetivo vendas → goalMetric revenue", c1.goalMetric === "revenue" && c1.hasBusinessMetric === true);
  check("3.3 correlationId com fio campaign:", c1.correlationId === `campaign:${c1.id}`);
  check("3.4 createdBy registrado", c1.createdBy === "user-1");

  // ── 4. Objetivo de vaidade → contrato honesto sem métrica ──
  const c2 = SVC.create(orgA, "user-1", { objectiveId: "engajamento" });
  check("4.1 vaidade → goalMetric null", c2.goalMetric === null && c2.hasBusinessMetric === false);

  // ── 5. Override explícito de métrica + validações (nunca inventa) ──
  const c3 = SVC.create(orgA, "user-1", { objectiveId: "educativo", goalMetric: "appointments" });
  check("5.1 override liga métrica válida", c3.goalMetric === "appointments");
  let threwObj = false, threwMetric = false;
  try { SVC.create(orgA, "u", { objectiveId: "inexistente" }); } catch { threwObj = true; }
  try { SVC.create(orgA, "u", { objectiveId: "vendas", goalMetric: "cliques" }); } catch { threwMetric = true; }
  check("5.2 objetivo desconhecido rejeitado", threwObj);
  check("5.3 métrica desconhecida rejeitada (não inventa)", threwMetric);

  // ── 6. get/list ──
  check("6.1 get devolve o contrato", SVC.get(orgA, c1.id)?.id === c1.id);
  check("6.2 list tem 3 contratos", SVC.list(orgA).length === 3);

  // ── 7. Progress: vaidade × sem-alvo × com-alvo (GROUNDED, não inventa meta) ──
  const pVanity = SVC.progress(orgA, c2.id)!;
  check("7.1 progresso de vaidade: sem métrica de negócio", pVanity.hasBusinessMetric === false && pVanity.goalDefined === false);

  const pNoTarget = SVC.progress(orgA, c1.id)!;
  check("7.2 métrica ligada mas SEM alvo → goalDefined false (não inventa)", pNoTarget.hasBusinessMetric === true && pNoTarget.goalDefined === false && pNoTarget.goal === null);

  BusinessGoalService.set(orgA, { metric: "revenue", targetAmount: 10000, actor: "owner" });
  const pTarget = SVC.progress(orgA, c1.id)!;
  check("7.3 com alvo definido → goalDefined true + distância-à-meta", pTarget.goalDefined === true && pTarget.goal?.target === 10000 && typeof pTarget.goal?.remaining === "number");

  // ── 8. Cancel ──
  check("8.1 cancel muda status", SVC.cancel(orgA, c3.id) === true);
  check("8.2 recancel é no-op", SVC.cancel(orgA, c3.id) === false);
  check("8.3 list(active) exclui cancelado", SVC.list(orgA, { status: "active" }).every((c: any) => c.id !== c3.id));

  // ── 9. Isolamento multi-tenant ──
  check("9.1 org B não vê contratos de A", SVC.list(orgB).length === 0);
  check("9.2 get cruzado retorna null", SVC.get(orgB, c1.id) === null);
  const c4 = SVC.create(orgB, "user-b", { objectiveId: "vendas" });
  check("9.3 org B isolado", SVC.list(orgB).length === 1 && SVC.list(orgB)[0].id === c4.id);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} campaign-objective: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
