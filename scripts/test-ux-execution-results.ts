/**
 * TEST — "Executando" + "Resultados" (PRD 6 / ADR-163 F8). DB-backed, det., isolado.
 * Prova (§45-49):
 *   - executing: processos ATIVOS agrupados por OBJETIVO (correlation_id →
 *     decision_action.title), estados humanos (F4), dinheiro role-gated (§73),
 *     domínio invisível ao papel oculto (RN-UX-2);
 *   - results: Impact Ledger por categoria (NUNCA somadas entre si), dinheiro
 *     role-gated, metas só pra gestor; nunca custo/tokens (§48/§50); multi-tenant.
 *
 * Uso: npm run test:ux-execution-results
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-uxer-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-uxer-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutionResultsService: ER } = await import("../src/server/ExecutionResultsService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mkOrg = (org: string) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), org);
  mkOrg(A); mkOrg(B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(A, "atendente"), organizationId: A };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // Processo ativo com objetivo (correlation_id da decisão), R$8.400, domínio operacional (visível a todos).
  const aVis = DA.propose(A, { domain: "operations", actionType: "prepare_campaign", title: "Recuperar carrinho", expectedImpact: 8400, impactUnit: "BRL" });
  // Processo ativo em domínio financeiro (invisível ao atendente).
  const aFin = DA.propose(A, { domain: "finance", actionType: "prepare_campaign", title: "Renegociar fornecedor", expectedImpact: 3000, impactUnit: "BRL" });
  const mkProc = (org: string, cid: string, type: string, status: string, ev: number) =>
    db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, expected_value, correlation_id, started_at) VALUES (?, ?, 'def', ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(randomUUID(), org, type, status, ev, cid);
  mkProc(A, aVis.correlation_id, "recuperacao_carrinho", "executing", 8400);
  mkProc(A, aVis.correlation_id, "recuperacao_carrinho", "queued", 8400);   // 2º processo do MESMO objetivo
  mkProc(A, aFin.correlation_id, "renegociacao", "executing", 3000);

  // ═══════════════ 1. Executando (gestor) ═══════════════
  const exOwner = ER.executing(A, owner);
  check("1.1 total = 3 processos ativos", exOwner.total === 3);
  const grpVis = exOwner.groups.find((g: any) => g.correlationId === aVis.correlation_id);
  check("1.2 agrupou por OBJETIVO (2 processos no mesmo fio)", !!grpVis && grpVis.count === 2);
  check("1.3 objetivo nomeado pela decisão", grpVis!.objective === "Recuperar carrinho");
  check("1.4 estados humanos (F4): Em andamento + Em preparação", grpVis!.states.some((s: any) => s.tone === "in_progress") && grpVis!.states.some((s: any) => s.tone === "ready"));
  check("1.5 impacto R$ visível pro gestor", grpVis!.impact.amount === 8400 && grpVis!.impact.restricted === false);
  check("1.6 drill-down pela thread", grpVis!.drillDown === `/api/falatu/thread/${aVis.correlation_id}`);

  // ═══════════════ 2. Executando (atendente) — role-scope + money-gate ═══════════════
  const exAt = ER.executing(A, atendente);
  const grpVisAt = exAt.groups.find((g: any) => g.correlationId === aVis.correlation_id);
  const grpFinAt = exAt.groups.find((g: any) => g.correlationId === aFin.correlation_id);
  check("2.1 atendente NÃO vê o processo financeiro", !grpFinAt);
  check("2.2 atendente vê o operacional, total 2 (financeiro oculto)", exAt.total === 2 && !!grpVisAt);
  check("2.3 atendente vê que HÁ impacto, não o valor (§73)", grpVisAt!.impact.amount === null && grpVisAt!.impact.restricted === true);

  // ═══════════════ 3. Resultados — ledger por categoria + role-gate ═══════════════
  const done = DA.propose(A, { domain: "operations", actionType: "create_task", title: "Resolvido" }); // policy none → approved
  DA.complete(A, done.id, { resultAmount: 500, categoryOutcomes: { revenueRecovered: 500 } });
  const resOwner = ER.results(A, owner);
  check("3.1 categoria revenueRecovered presente (BRL) pro gestor", !!resOwner.impact.categories.revenueRecovered && resOwner.impact.categories.revenueRecovered.total === 500);
  check("3.2 disclaimer 'nunca somadas entre si'", /nunca somadas/i.test(resOwner.impact.disclaimer));
  check("3.3 fullVisibility true pro gestor", resOwner.fullVisibility === true);

  // ═══════════════ 4. Resultados — role-gating (§73) ═══════════════
  const resAt = ER.results(A, atendente);
  check("4.1 atendente: categoria em R$ com total reservado (restricted)", resAt.impact.categories.revenueRecovered.restricted === true && resAt.impact.categories.revenueRecovered.total === null);
  check("4.2 atendente NÃO vê metas (não-gestor)", resAt.goals === null);
  check("4.3 gestor vê bloco de metas (mesmo vazio)", resOwner.goals !== null);

  // ═══════════════ 5. multi-tenant ═══════════════
  const exB = ER.executing(B, ownerB);
  const resB = ER.results(B, ownerB);
  check("5.1 org B sem execução de A", exB.total === 0 && exB.groups.length === 0);
  check("5.2 org B sem resultados de A", Object.keys(resB.impact.categories).length === 0);

  // ═══════════════ 6. F9 (ADR-165) — garantia nas superfícies (garantido × só executado) ═══════════════
  // Objetivo só PROPOSTO (aVis) → assurance planned; fato sempre visível (não é dinheiro).
  check("6.1 objetivo só proposto → assurance planned", !!grpVis!.assurance && grpVis!.assurance.state === "planned");
  // Objetivo com efeito confirmado E impacto medido → assured.
  const aOk = DA.propose(A, { domain: "operations", actionType: "prepare_campaign", title: "Objetivo garantido", expectedImpact: 100, impactUnit: "BRL" });
  db.prepare("UPDATE decision_actions SET status='done' WHERE id=?").run(aOk.id);
  db.prepare("INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status) VALUES (?,?,?,?,?)").run(randomUUID(), A, aOk.id, "manual", "confirmed");
  db.prepare("INSERT INTO action_outcomes (id, organization_id, action_id, measurement_method, basis, realized_value, correlation_id) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), A, aOk.id, "derived", "fact", 100, aOk.correlation_id);
  mkProc(A, aOk.correlation_id, "recuperacao_carrinho", "executing", 100);
  const exF9 = ER.executing(A, owner);
  const grpOk = exF9.groups.find((g: any) => g.correlationId === aOk.correlation_id);
  check("6.2 objetivo confirmado+medido → assured, sem gaps", !!grpOk && grpOk.assurance!.state === "assured" && grpOk.assurance!.hasGaps === false);
  // A garantia (fato) é visível pro atendente também; só o R$ fica restrito (§73).
  const grpOkAt = ER.executing(A, atendente).groups.find((g: any) => g.correlationId === aOk.correlation_id);
  check("6.3 assurance visível pro atendente (fato), R$ restrito", !!grpOkAt && grpOkAt.assurance!.state === "assured" && grpOkAt.impact.restricted === true);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ux-execution-results: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
