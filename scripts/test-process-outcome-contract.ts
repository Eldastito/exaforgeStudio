/**
 * TEST — ProcessOutcomeContractService: avalia o Outcome Contract de PROCESSO
 * (PRD 8 / ADR-165 F2). DB-backed, det. Prova (§13 achado (a), RN-OA-1..3):
 *   - condição de processo (antes INERTE) agora É avaliada via evaluateCondition;
 *   - aceita formato nativo {op,path,value} E clausal {field,operator,value}/all/any;
 *   - sem contrato → no_contract (não inventa sucesso, RN-OA-2);
 *   - failure tem precedência sobre success (RN-OA-1 conservador);
 *   - condição não-normalizável → unevaluable/indeterminate (nunca "passou");
 *   - RN-OA-3: avaliação NÃO muda o status da instância (read-only);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:process-outcome-contract
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-poc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-poc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ProcessOutcomeContractService: POC, toCondition } = await import("../src/server/ProcessOutcomeContractService.js");
  const ORG = "org-1", OTHER = "org-2";
  let dv = 0, iv = 0;

  const mkDef = (successRaw: any, failureRaw: any, org = ORG) => {
    const id = `def-${dv++}`;
    db.prepare(`INSERT INTO process_definitions (id, organization_id, process_type, name, version, success_conditions_json, failure_conditions_json, steps_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, org, `pt-${id}`, "Proc", 1, successRaw != null ? JSON.stringify(successRaw) : null, failureRaw != null ? JSON.stringify(failureRaw) : null, JSON.stringify([{ id: "s1", commandType: "noop" }]));
    return id;
  };
  const mkInst = (defId: string, ctx: any, status = "completed", result: any = null, org = ORG) => {
    const id = `inst-${iv++}`;
    db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, context_json, result_json) VALUES (?,?,?,?,?,?,?)`)
      .run(id, org, defId, `pt-${defId}`, status, JSON.stringify(ctx), result != null ? JSON.stringify(result) : null);
    return id;
  };

  // ═══════════════ 1. toCondition normaliza os dois formatos ═══════════════
  check("1.1 nativo {op,path,value} passa direto", JSON.stringify(toCondition({ op: "eq", path: "a", value: 1 })) === JSON.stringify({ op: "eq", path: "a", value: 1 }));
  check("1.2 clausal {field,operator,value} → {op,path,value}", JSON.stringify(toCondition({ field: "paid", operator: "equals", value: true })) === JSON.stringify({ op: "eq", path: "paid", value: true }));
  check("1.3 {all:[...]} → and", (toCondition({ all: [{ field: "x", operator: "truthy" }] }) as any).op === "and");
  check("1.4 clausal inválida (sem operator) → null", toCondition({ field: "x" }) === null);

  // ═══════════════ 2. sem contrato → no_contract (RN-OA-2) ═══════════════
  const dNone = mkDef(null, null);
  const iNone = mkInst(dNone, { paid: true });
  check("2.1 definição sem success/failure → no_contract", POC.evaluate(ORG, iNone).verdict === "no_contract");

  // ═══════════════ 3. success bate (nativo) ═══════════════
  const dS = mkDef({ op: "truthy", path: "paid" }, null);
  check("3.1 paid=true satisfaz success → success", POC.evaluate(ORG, mkInst(dS, { paid: true })).verdict === "success");
  check("3.2 paid ausente → indeterminate (definido mas não satisfeito)", POC.evaluate(ORG, mkInst(dS, { paid: false })).verdict === "indeterminate");

  // ═══════════════ 4. success clausal via result.* ═══════════════
  const dSC = mkDef({ field: "result.confirmed", operator: "equals", value: true }, null);
  check("4.1 clausal lê result.confirmed do result_json → success", POC.evaluate(ORG, mkInst(dSC, {}, "completed", { confirmed: true })).verdict === "success");

  // ═══════════════ 5. failure tem precedência sobre success (RN-OA-1) ═══════════════
  const dF = mkDef({ op: "truthy", path: "paid" }, { op: "truthy", path: "refunded" });
  check("5.1 paid=true E refunded=true → failure (precedência)", POC.evaluate(ORG, mkInst(dF, { paid: true, refunded: true })).verdict === "failure");
  check("5.2 paid=true, refunded=false → success", POC.evaluate(ORG, mkInst(dF, { paid: true, refunded: false })).verdict === "success");

  // ═══════════════ 6. condição não-normalizável → unevaluable/indeterminate ═══════════════
  const dBad = mkDef({ weird: "shape" }, null);
  const rBad = POC.evaluate(ORG, mkInst(dBad, { paid: true }));
  check("6.1 contrato presente mas não-normalizável → indeterminate + unevaluable", rBad.verdict === "indeterminate" && rBad.contract.success.unevaluable === true);

  // ═══════════════ 7. RN-OA-3: read-only (status intacto) ═══════════════
  const dRO = mkDef({ op: "truthy", path: "paid" }, null);
  const iRO = mkInst(dRO, { paid: true }, "executing");
  POC.evaluate(ORG, iRO); POC.evaluate(ORG, iRO);
  check("7.1 avaliar NÃO muda o status da instância (read-only)", db.prepare("SELECT status FROM process_instances WHERE id=?").get(iRO).status === "executing");

  // ═══════════════ 8. isolamento multi-tenant ═══════════════
  const dOther = mkDef({ op: "truthy", path: "paid" }, null, OTHER);
  const iOther = mkInst(dOther, { paid: true }, "completed", null, OTHER);
  check("8.1 org-1 não avalia instância da outra org → no_contract/not found", POC.evaluate(ORG, iOther).found === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} process-outcome-contract: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
