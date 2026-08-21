/**
 * TEST — Advisor Simples híbrido DAS × regime regular (ADR-181 F5). DB-backed, determinístico.
 * Prova: só Simples (mei/presumido → not_applicable); NUNCA recomenda um lado (só fatos +
 * disclaimer — RN-FISCAL-9); reflete a escolha atual; sinal de insumo é ATERRADO (payables) e
 * honesto sobre o que não sabe (mix de clientes); setChoice só persiste (não decide) e exige
 * Simples; isolamento.
 *
 * Uso: npm run test:simples-hybrid-advisor
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-simhyb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-simhyb-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");
  const { SimplesHybridAdvisorService: ADV } = await import("../src/server/SimplesHybridAdvisorService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'moda')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'B', 'active', 'moda')`).run(randomUUID(), B);

  // 1. Sem regime → não aplicável (a escolha só existe pro Simples).
  const a0 = ADV.advise(A);
  check("1.1 sem regime → not applicable", a0.applicable === false && a0.reason === "not_simples");
  check("1.2 disclaimer sempre presente", a0.disclaimer.length > 0);

  // 2. MEI e Presumido também não têm a escolha.
  FP.save(A, { regime: "mei" }, "u");
  check("2.1 MEI → not applicable", ADV.advise(A).applicable === false);
  FP.save(A, { regime: "presumido" }, "u");
  check("2.2 Presumido → not applicable", ADV.advise(A).applicable === false);

  // 3. Simples → aplicável; fatos dos DOIS lados; NUNCA recomenda (sem campo "recommended").
  FP.save(A, { regime: "simples" }, "u");
  const a1 = ADV.advise(A);
  check("3.1 Simples → aplicável", a1.applicable === true);
  check("3.2 escolha atual = DAS (default)", a1.currentChoice === "das");
  check("3.3 traz fatores dos 2 caminhos", a1.factors.some((f) => f.path === "das") && a1.factors.some((f) => f.path === "regime_regular"));
  check("3.4 NÃO recomenda um lado (sem 'recommended')", !("recommended" in (a1 as any)) && !a1.factors.some((f: any) => "recommended" in f));
  check("3.5 crédito citado no lado regime_regular", a1.factors.some((f) => f.path === "regime_regular" && /crédito/i.test(f.text)));

  // 4. HONESTO: mix de clientes NÃO é conhecido; sinal de insumo aterrado em payables.
  check("4.1 clientMixKnown = false (não chuta)", a1.signals.clientMixKnown === false);
  check("4.2 sem payables → hasCreditableInputs false", a1.signals.hasCreditableInputs === false);
  db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fornecedor', 500.0, '2026-09-01', 'open')`).run(randomUUID(), A);
  check("4.3 com payables → hasCreditableInputs true (aterrado)", ADV.advise(A).signals.hasCreditableInputs === true);

  // 5. setChoice só PERSISTE a decisão do dono (não decide) e reflete no advise.
  const p1 = ADV.setChoice(A, true, "u");
  check("5.1 setChoice(true) grava opt-in no perfil", p1.regimeRegularOptin === true);
  check("5.2 advise reflete regime_regular", ADV.advise(A).currentChoice === "regime_regular");
  const p2 = ADV.setChoice(A, false, "u");
  check("5.3 setChoice(false) volta pro DAS", p2.regimeRegularOptin === false && ADV.advise(A).currentChoice === "das");

  // 6. setChoice fora do Simples lança (a escolha não existe).
  FP.save(A, { regime: "real" }, "u");
  let e6 = false; try { ADV.setChoice(A, true, "u"); } catch (e: any) { e6 = e.message === "not_simples"; }
  check("6.1 setChoice fora do Simples lança", e6);

  // 7. Isolamento: payables de A não afeta B.
  FP.save(B, { regime: "simples" }, "u");
  check("7.1 B sem payables → hasCreditableInputs false (isolado)", ADV.advise(B).signals.hasCreditableInputs === false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} simples-hybrid-advisor: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
