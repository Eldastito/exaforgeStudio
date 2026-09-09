/**
 * TEST — F3.1a (CA-04 / INV-11): projeção por usuário no Diretor.
 * (PRD WhatsApp Unificado — RF-04 §10 "contexto filtrado por usuário".)
 *
 * Prova, offline e DETERMINÍSTICO (buildPanorama não chama LLM):
 *  - buildPanorama default e {canSeeMoney:true} carregam o financeiro (0-regressão).
 *  - buildPanorama {canSeeMoney:false} REDIGE: some pilar Financeiro, indicador
 *    em R$, meta em R$, impacto R$ dos sinais, comissão e recomendações de plano;
 *    metas de CONTAGEM e fatos não-monetários seguem visíveis.
 *  - Blocos redigidos individualmente (executiveBlock/goalsBlock/businessSignalsBlock).
 *  - canSeeMoney: owner→vê; agent→NÃO vê; gerente (role_profile)→vê.
 *  - isolamento entre orgs.
 *
 * Uso: npm run test:executive-money-projection
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-exec-money-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-exec-money-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveAdvisorService: A } = await import("../src/server/ExecutiveAdvisorService.js");
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");

  const O = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), O);

  // Semeia FINANCEIRO: sinal crítico em R$ (aparece no pilar Financeiro, no
  // indicador de receita e no Pareto de sinais) + meta de receita (BRL) +
  // meta de atendimentos (count, NÃO-monetária).
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "test", evidence: { n: 4 }, dedupeKey: "fin-crit-1",
  });
  BusinessGoalService.set(O, { metric: "revenue", targetAmount: 100000 });
  BusinessGoalService.set(O, { metric: "appointments", targetAmount: 200 });

  // ── 1. Default e canSeeMoney:true = financeiro presente (0-regressão) ──
  const full = A.buildPanorama(O);
  const fullTrue = A.buildPanorama(O, { canSeeMoney: true });
  check("1.1 default carrega VISÃO EXECUTIVA", full.includes("VISÃO EXECUTIVA"));
  check("1.2 default mostra pilar Financeiro", /Financeiro: saúde/.test(full));
  check("1.3 default mostra impacto R$ nos sinais", full.includes("impacto R$"));
  check("1.4 default mostra meta de receita em R$", /Receita do mês: meta R\$/.test(full));
  check("1.5 canSeeMoney:true == default (0-regressão)", fullTrue === full);

  // ── 2. canSeeMoney:false REDIGE o financeiro ──
  const red = A.buildPanorama(O, { canSeeMoney: false });
  check("2.1 sem pilar Financeiro", !/Financeiro: saúde/.test(red));
  check("2.2 sem impacto R$ nos sinais", !red.includes("impacto R$"));
  check("2.3 sem meta de receita em R$", !/Receita do mês: meta R\$/.test(red));
  check("2.4 sem 'Receita do mês R$' (indicador financeiro)", !/Receita do mês R\$/.test(red));
  check("2.5 sem seção de comissão (VENDAS POR VENDEDOR)", !red.includes("VENDAS POR VENDEDOR"));
  check("2.6 sem seção de recomendações de plano", !red.includes("PLANO E RECOMENDAÇÕES"));
  // Não-monetário permanece: meta de atendimentos (count) segue visível.
  check("2.7 meta de CONTAGEM (Atendimentos) permanece", /Atendimentos do mês: meta 200/.test(red));

  // ── 3. Blocos individuais redigem ──
  check("3.1 executiveBlock sem Financeiro quando !money", !/Financeiro: saúde/.test(A.executiveBlock(O, { canSeeMoney: false })));
  check("3.2 executiveBlock COM Financeiro quando money", /Financeiro: saúde/.test(A.executiveBlock(O, { canSeeMoney: true })));
  check("3.3 businessSignalsBlock sem impacto R$ quando !money", !A.businessSignalsBlock(O, { canSeeMoney: false }).includes("impacto R$"));
  check("3.4 goalsBlock filtra meta BRL quando !money", !/Receita do mês: meta R\$/.test(A.goalsBlock(O, { canSeeMoney: false })));
  check("3.5 goalsBlock mantém meta count quando !money", /Atendimentos do mês: meta 200/.test(A.goalsBlock(O, { canSeeMoney: false })));

  // ── 4. canSeeMoney — a régua de projeção ──
  check("4.1 owner vê dinheiro", FalaTuAskService.canSeeMoney(O, { role: "owner" }) === true);
  check("4.2 admin vê dinheiro", FalaTuAskService.canSeeMoney(O, { role: "admin" }) === true);
  check("4.3 agent NÃO vê dinheiro", FalaTuAskService.canSeeMoney(O, { role: "agent" }) === false);
  // gerente reconhecido por role_profile (system_key='gerente').
  const rpGer = randomUUID();
  db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Gerente', 'gerente', 1)`).run(rpGer, O);
  check("4.4 gerente (role_profile) vê dinheiro", FalaTuAskService.canSeeMoney(O, { role: "agent", role_profile_id: rpGer }) === true);
  check("4.5 role_profile de OUTRA org não vale (isolamento)", FalaTuAskService.canSeeMoney(`org_${randomUUID().slice(0, 8)}`, { role: "agent", role_profile_id: rpGer }) === false);

  // ── 5. Isolamento: org P sem sinais/metas não vaza nada de O ──
  const P = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), P);
  const pano = A.buildPanorama(P);
  check("5.1 org P não vê o impacto R$ de O", !pano.includes("impacto R$ 5000"));
  check("5.2 org P não vê a meta de O", !/Receita do mês: meta R\$ 100000/.test(pano));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-money-projection: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
