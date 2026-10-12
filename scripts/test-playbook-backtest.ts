/**
 * TESTE — ADR-206 F5.5: BACKTEST de playbook (contrato de uma versão reaplicado ao histórico real).
 * Prova, nos serviços REAIS:
 *   A) sem contrato → no_contract (hoje os playbooks de plataforma não trazem contrato; não inventa); sem histórico → no_history;
 *   B) amostra mínima → insufficient_data (sem veredito); consistent / diverges / inconclusive pelo limite de Wilson;
 *   C) falso sucesso (contrato diria sucesso e o caso falhou) e falso fracasso contados à parte; indeterminado fora da taxa;
 *   D) andamento/cancelado ficam de fora e são ditos; escolhe a versão pedida (mesmo histórico, contratos diferentes → vereditos diferentes);
 *   E) read-only (nada muda); isolado por empresa; avisos de honestidade sempre presentes e `calibrated:false`;
 *   F) o refator do ProcessOutcomeContractService (verdictFor) não mudou o veredito por instância; rota montada; sem tabela nova.
 * Uso: npm run test:playbook-backtest
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pbt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pbt-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PlaybookBacktestService: B } = await import("../src/server/PlaybookBacktestService.js");
  const { ProcessRuntimeService } = await import("../src/server/ProcessRuntimeService.js");
  const { ProcessOutcomeContractService: C } = await import("../src/server/ProcessOutcomeContractService.js");
  const { CollectionPlaybookService } = await import("../src/server/CollectionPlaybook.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };

  const donor = mkOrg(); CollectionPlaybookService.seed(donor);
  const steps = JSON.parse(ProcessRuntimeService.latestActiveDefinition(donor, "receivable_collection_v1").steps_json);
  const SUCCESS = { op: "eq", path: "result.paid", value: true };
  const FAILURE = { op: "eq", path: "result.paid", value: false };
  const define = (org: string, type: string, success: any, failure: any) => ProcessRuntimeService.defineProcess(org, { processType: type, name: "T", steps, successConditions: success, failureConditions: failure });
  const inst = (org: string, defId: string, type: string, status: string, paid: boolean | null) =>
    db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, context_json, result_json) VALUES (?, ?, ?, ?, ?, '{}', ?)`)
      .run(randomUUID(), org, defId, type, status, paid === null ? null : JSON.stringify({ paid }));
  const many = (org: string, defId: string, type: string, status: string, paid: boolean | null, n: number) => { for (let i = 0; i < n; i++) inst(org, defId, type, status, paid); };

  // A) sem contrato / sem histórico
  check("playbook de plataforma sem contrato → no_contract (não inventa)", B.backtest(donor, "receivable_collection_v1").verdict === "no_contract");
  const o1 = mkOrg(); const d1 = define(o1, "t_none", SUCCESS, FAILURE);
  check("com contrato mas sem instância → no_history", B.backtest(o1, "t_none").verdict === "no_history");
  check("processo/definição inexistente → found:false, sem lançar", B.backtest(o1, "nao_existe").found === false && B.backtest(o1, "t_none", { definitionId: "xxxx" }).found === false);
  check("processType vazio é recusado", B.backtest(o1, "").found === false);

  // B) amostra e vereditos
  const oS = mkOrg(); const dS = define(oS, "t_small", SUCCESS, FAILURE);
  many(oS, dS.id, "t_small", "completed", true, 3); many(oS, dS.id, "t_small", "failed", false, 1);
  const rS = B.backtest(oS, "t_small");
  check("amostra pequena (4 decididos) → insufficient_data, mas mostra a concordância", rS.verdict === "insufficient_data" && rS.agreement.agree === 4 && rS.instances.decided === 4);
  const oC = mkOrg(); const dC = define(oC, "t_ok", SUCCESS, FAILURE);
  many(oC, dC.id, "t_ok", "completed", true, 20); many(oC, dC.id, "t_ok", "failed", false, 10);
  const rC = B.backtest(oC, "t_ok");
  check("30/30 concordam → consistent_with_history com banda de Wilson", rC.verdict === "consistent_with_history" && rC.agreement.rate === 1 && rC.agreement.interval.lower >= 0.8 && rC.agreement.confidence !== "insufficient");
  const oD = mkOrg(); const dD = define(oD, "t_bad", SUCCESS, FAILURE);
  many(oD, dD.id, "t_bad", "completed", true, 5); many(oD, dD.id, "t_bad", "failed", true, 15); // contrato diz sucesso, caso falhou
  const rD = B.backtest(oD, "t_bad");
  check("contrato que discorda do histórico → diverges_from_history", rD.verdict === "diverges_from_history" && rD.agreement.agree === 5);
  check("falso sucesso (perigoso) contado à parte e listado", rD.agreement.falseSuccess === 15 && rD.agreement.falseFailure === 0 && rD.disagreements.length > 0 && rD.disagreements.every((x: any) => x.contractSays === "success" && x.actual === "failed"));
  const oI = mkOrg(); const dI = define(oI, "t_mid", SUCCESS, FAILURE);
  many(oI, dI.id, "t_mid", "completed", true, 10); many(oI, dI.id, "t_mid", "completed", false, 2); // 2 falsos fracassos
  const rI = B.backtest(oI, "t_mid");
  check("12 decididos, 10 concordam → inconclusive (banda cruza o limiar)", rI.verdict === "inconclusive" && rI.agreement.falseFailure === 2);

  // C) indeterminado / D) exclusões / versão
  const oU = mkOrg(); const dU = define(oU, "t_und", SUCCESS, FAILURE);
  many(oU, dU.id, "t_und", "completed", true, 12); many(oU, dU.id, "t_und", "completed", null, 5);
  many(oU, dU.id, "t_und", "cancelled", null, 3); many(oU, dU.id, "t_und", "executing", null, 2);
  const rU = B.backtest(oU, "t_und");
  check("indeterminado (sem resultado) fica fora da taxa mas é contado; cobertura < 1", rU.instances.decided === 12 && rU.instances.undecided === 5 && rU.agreement.rate === 1 && Math.abs(rU.coverage - 12 / 17) < 1e-9);
  check("cancelado e em andamento ficam de fora e são ditos", rU.instances.excluded === 5 && rU.instances.total === 22 && rU.instances.terminal === 17);
  const oV = mkOrg(); const v1 = define(oV, "t_ver", SUCCESS, FAILURE);
  const v2 = define(oV, "t_ver", { op: "eq", path: "result.paid", value: false }, { op: "eq", path: "result.paid", value: true }); // v2 com contrato INVERTIDO
  many(oV, v1.id, "t_ver", "completed", true, 15); many(oV, v1.id, "t_ver", "failed", false, 15);
  check("padrão: avalia a versão mais nova (v2 invertida diverge)", B.backtest(oV, "t_ver").definition.version === 2 && B.backtest(oV, "t_ver").verdict === "diverges_from_history");
  check("definitionId escolhe a versão (v1 concorda no MESMO histórico)", B.backtest(oV, "t_ver", { definitionId: v1.id }).verdict === "consistent_with_history" && B.backtest(oV, "t_ver", { definitionId: v1.id }).definition.version === 1);
  check("definição de outra empresa não é aceita", B.backtest(oC, "t_ver", { definitionId: v1.id }).found === false);

  // E) read-only, isolamento, honestidade
  const snap = (org: string) => JSON.stringify(db.prepare("SELECT id, status, result_json FROM process_instances WHERE organization_id = ? ORDER BY id").all(org));
  const before = snap(oD); B.backtest(oD, "t_bad"); check("read-only: nenhuma instância mudou", snap(oD) === before);
  check("isolamento: histórico de outra empresa não entra", B.backtest(oC, "t_bad").found === false && B.backtest(oD, "t_ok").found === false);
  check("sempre traz avisos de honestidade, calibrated:false e limiares", [rS, rC, rD, rI, rU].every((r) => r.caveats.length >= 3 && r.calibrated === false && r.thresholds.minDecided === 10));
  check("avisos dizem que backtest não é promessa", /não é promessa/.test(rC.caveats[0]));

  // F) refator + fiação
  const probe = db.prepare("SELECT * FROM process_instances WHERE organization_id = ? LIMIT 1").get(oC) as any;
  const defRow = db.prepare("SELECT * FROM process_definitions WHERE id = ?").get(dC.id) as any;
  check("evaluate (rota antiga) segue igual ao verdictFor", C.evaluate(oC, probe.id).verdict === C.verdictFor(defRow, probe).verdict && C.evaluate(oC, probe.id).verdict === "success");
  check("verdictFor: falha tem precedência sobre sucesso", C.verdictFor({ success_conditions_json: JSON.stringify({ op: "truthy", path: "result" }), failure_conditions_json: JSON.stringify({ op: "truthy", path: "result" }) }, { context_json: "{}", result_json: JSON.stringify({ a: 1 }), status: "x" }).verdict === "failure");
  check("verdictFor: sem contrato → no_contract; condição inavaliável → indeterminate", C.verdictFor({}, { context_json: "{}", status: "x" }).verdict === "no_contract" && C.verdictFor({ success_conditions_json: JSON.stringify({ foo: 1 }) }, { context_json: "{}", status: "x" }).verdict === "indeterminate");
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/runtime.ts"), "utf8");
  check("rota /playbook-registry/backtest montada", /"\/playbook-registry\/backtest"/.test(route) && route.includes("PlaybookBacktestService"));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("sem tabela nova de backtest", !/CREATE TABLE IF NOT EXISTS (playbook_backtest|backtest)/.test(dbsrc));
  const svc = fs.readFileSync(path.join(process.cwd(), "src/server/PlaybookBacktestService.ts"), "utf8");
  check("serviço não escreve (nenhum INSERT/UPDATE/DELETE)", !/\b(INSERT|UPDATE|DELETE)\b/i.test(svc.replace(/\/\*[\s\S]*?\*\//g, "")));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
