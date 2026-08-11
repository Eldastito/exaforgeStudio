/**
 * TEST — PRD 2 F9 (§45-46, §10, CA2): Human signals. Uma observação humana vira
 * um `business_signal` normalizado no ledger canônico, com ACÚMULO DE EVIDÊNCIA
 * (mesmo assunto sobe confiança/severidade), NUNCA como fato (§13), sem tabela
 * nova (CA1/§5).
 *
 * Prova (determinístico, sem IA):
 *   - opt-in: sem a flag, observe() é no-op ('disabled');
 *   - 1ª observação → info, basis=estimate (não fact), confiança baixa;
 *   - 2ª do MESMO assunto ACUMULA (mesmo sinal, count=2, attention, +conf);
 *   - 3ª → risk; evidências individuais preservadas (observations[]);
 *   - assunto DIFERENTE → sinal separado;
 *   - subjectId explícito acumula por chave estável mesmo com texto diferente;
 *   - hypothesis aceito; fact rejeitado (cai pra estimate);
 *   - sinal resolvido NÃO ressuscita gravidade (contagem recomeça);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:human-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-human-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-human-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { HumanSignalService: HS } = await import("../src/server/HumanSignalService.js");

  const mkOrg = (human = 1) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, radar_human_signals_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, human);
    return id;
  };
  const sigOf = (id: string) => db.prepare(`SELECT * FROM business_signals WHERE id = ?`).get(id) as any;
  const evOf = (id: string) => { try { return JSON.parse(sigOf(id).evidence_json || "{}"); } catch { return {}; } };

  // ===== 1. Opt-in =====
  const orgOff = mkOrg(0);
  const off = HS.observe(orgOff, { observation: "cliente procurando produto X", domain: "sales" });
  check("1.1 sem flag → disabled (no-op)", off.ok === false && off.reason === "disabled");
  check("1.2 sem flag não publica nada", BS.list(orgOff, {}).length === 0);

  const org = mkOrg(1);

  // ===== 2. Primeira observação =====
  const o1 = HS.observe(org, { observerId: "u1", observation: "Um cliente hoje perguntou pelo Produto X", domain: "sales", subjectType: "product", subjectId: "prod-x" });
  check("2.1 ok + count 1 + deduped false", o1.ok === true && o1.observationCount === 1 && o1.deduped === false);
  check("2.2 severidade info (uma percepção isolada)", o1.severity === "info");
  const s1 = sigOf(o1.signalId!);
  check("2.3 basis=estimate (NÃO fact §13); origem humana; source service", s1.basis === "estimate" && s1.source_service === "HumanSignalService");
  check("2.4 confiança baixa (0.30) — corroboração ainda zero", s1.confidence === 0.30);
  check("2.5 evidência guarda a observação verbatim", evOf(o1.signalId!).observations.length === 1 && evOf(o1.signalId!).observations[0].text.includes("Produto X"));

  // ===== 3. Acúmulo do MESMO assunto (§46) =====
  const o2 = HS.observe(org, { observerId: "u2", observation: "Outro cliente também pediu o Produto X", domain: "sales", subjectType: "product", subjectId: "prod-x" });
  check("3.1 acumula no MESMO sinal (deduped, mesmo id)", o2.deduped === true && o2.signalId === o1.signalId);
  check("3.2 count 2 → attention + confiança sobe (0.48)", o2.observationCount === 2 && o2.severity === "attention" && sigOf(o2.signalId!).confidence === 0.48);
  const o3 = HS.observe(org, { observerId: "u1", observation: "Terceiro cliente procurando Produto X", domain: "sales", subjectType: "product", subjectId: "prod-x" });
  check("3.3 count 3 → risk (padrão corroborado)", o3.observationCount === 3 && o3.severity === "risk");
  const ev3 = evOf(o3.signalId!);
  check("3.4 três evidências preservadas + observers distintos", ev3.observations.length === 3 && ev3.observers.sort().join(",") === "u1,u2");
  check("3.5 só UM sinal aberto pro assunto (acúmulo, não N alertas)", BS.list(org, { status: "open" }).filter((s: any) => s.subject_id === "prod-x").length === 1);

  // ===== 4. Assunto diferente → sinal separado =====
  const oY = HS.observe(org, { observation: "Cliente perguntou do Produto Y", domain: "sales", subjectType: "product", subjectId: "prod-y" });
  check("4.1 assunto diferente = sinal novo", oY.signalId !== o1.signalId && oY.observationCount === 1);

  // ===== 5. subjectId estabiliza a chave mesmo com texto diferente =====
  const t1 = HS.observe(org, { observation: "reclamação sobre a fila da manhã", domain: "retail_ops", subjectId: "fila-caixa" });
  const t2 = HS.observe(org, { observation: "de novo demora enorme no caixa", domain: "retail_ops", subjectId: "fila-caixa" });
  check("5.1 mesmo subjectId acumula apesar do texto diferente", t2.deduped === true && t2.signalId === t1.signalId && t2.observationCount === 2);

  // ===== 6. Texto sem subjectId: normalização agrupa parecidos =====
  const n1 = HS.observe(org, { observation: "Fornecedor Café atrasou", domain: "sales" });
  const n2 = HS.observe(org, { observation: "fornecedor cafe atrasou!", domain: "sales" });
  check("6.1 texto normalizado (acento/caixa/pontuação) acumula", n2.deduped === true && n2.signalId === n1.signalId && n2.observationCount === 2);

  // ===== 7. hypothesis aceito; fact recusado → estimate =====
  const h = HS.observe(org, { observation: "acho que perdemos venda pro concorrente", domain: "sales", subjectId: "concorrente", basis: "hypothesis" });
  check("7.1 basis=hypothesis persiste", sigOf(h.signalId!).basis === "hypothesis");
  const f = HS.observe(org, { observation: "produto Z em falta", domain: "sales", subjectId: "prod-z", basis: "fact" as any });
  check("7.2 basis=fact rejeitado → cai pra estimate (§13)", sigOf(f.signalId!).basis === "estimate");

  // ===== 8. Sinal resolvido não ressuscita gravidade =====
  BS.resolve(org, o1.signalId!); // fecha o prod-x (que estava em risk/3)
  const oR = HS.observe(org, { observation: "cliente perguntou Produto X de novo", domain: "sales", subjectType: "product", subjectId: "prod-x" });
  check("8.1 nova observação recomeça em count 1 / info (não herda risk)", oR.observationCount === 1 && oR.severity === "info");

  // ===== 9. Isolamento =====
  const orgB = mkOrg(1);
  check("9.1 org B não enxerga sinais da org A", BS.list(orgB, {}).length === 0);
  const validation = HS.observe(org, { observation: "   ", domain: "sales" });
  check("9.2 observação vazia recusada", validation.ok === false && validation.reason === "empty_observation");

  console.log("\n=== TEST: Human Signals F9 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Human Signals F9 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
