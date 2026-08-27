/**
 * TEST — ProductEvolutionLedgerService (ADR-193 F1).
 * DB-backed, determinístico. Prova:
 *   1. evolution_key valida regex, unicidade, imutabilidade;
 *   2. transições obedecem STATUS_GRAPH (RN-PEL-3);
 *   3. VALIDATED requer evidência verificada (RN-PEL-4);
 *   4. SUPERSEDED requer superseded_by válido (RN-PEL-5);
 *   5. evidence_type/source_type restritos aos enums (RN-PEL-6);
 *   6. escopo GLOBAL — schema sem organization_id (RN-PEL-2);
 *   7. filtros (status/domain/q) retornam subset esperado;
 *   8. gaps view filtra corretamente.
 *
 * Uso: npm run test:product-evolution-ledger
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pel-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pel-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ProductEvolutionLedgerService: PEL,
    EVIDENCE_TYPES, SOURCE_TYPES, STATUSES,
    LedgerValidationError, LedgerNotFoundError,
  } = await import("../src/server/ProductEvolutionLedgerService.js");

  // ═══════════════ 1. evolution_key: regex, unicidade, imutabilidade ═══════════════
  const validKeys = ["FOO", "FOO_BAR", "F00_BAR", "MISSION_OPERATING_LAYER", "A1B"];
  const invalidKeys = ["foo", "1FOO", "F-OO", "FO", "FOO BAR", "", "A".repeat(65)];
  let allValid = true;
  for (const k of validKeys) {
    try { PEL.createItem({ evolution_key: k, title: "test " + k }); }
    catch { allValid = false; break; }
  }
  check("1.1 chaves válidas aceitas", allValid);

  let allInvalidRejected = true;
  for (const k of invalidKeys) {
    try {
      PEL.createItem({ evolution_key: k, title: "x" });
      allInvalidRejected = false;
      break;
    } catch (e: any) {
      if (!(e instanceof LedgerValidationError)) { allInvalidRejected = false; break; }
    }
  }
  check("1.2 chaves inválidas rejeitadas", allInvalidRejected);

  // unicidade
  let threwDup = false;
  try { PEL.createItem({ evolution_key: "FOO", title: "y" }); }
  catch (e: any) { threwDup = e instanceof LedgerValidationError && e.code === "duplicate_key"; }
  check("1.3 evolution_key duplicada é rejeitada", threwDup);

  // ═══════════════ 2. schema global sem organization_id (RN-PEL-2) ═══════════════
  const itemCols = (db.prepare("PRAGMA table_info(product_evolution_items)").all() as any[]).map(c => c.name);
  check("2.1 product_evolution_items SEM organization_id", !itemCols.includes("organization_id"));

  const evidCols = (db.prepare("PRAGMA table_info(product_evolution_evidence)").all() as any[]).map(c => c.name);
  check("2.2 product_evolution_evidence SEM organization_id", !evidCols.includes("organization_id"));

  const srcCols = (db.prepare("PRAGMA table_info(product_evolution_sources)").all() as any[]).map(c => c.name);
  check("2.3 product_evolution_sources SEM organization_id", !srcCols.includes("organization_id"));

  // ═══════════════ 3. transição de estado obedece grafo (RN-PEL-3) ═══════════════
  // Cria item novo pra testar transição
  const t1 = PEL.createItem({ evolution_key: "TRANSITION_TEST", title: "transição" });
  check("3.1 item novo nasce em IDEA", t1.status === "IDEA");

  // IDEA → ANALYZED OK
  const t2 = PEL.setStatus("TRANSITION_TEST", { new_status: "ANALYZED", reason: "análise pronta" });
  check("3.2 IDEA → ANALYZED aceito", t2.status === "ANALYZED");

  // ANALYZED → PRODUCTION (skip) — DEVE recusar
  let skipRejected = false;
  try { PEL.setStatus("TRANSITION_TEST", { new_status: "PRODUCTION", reason: "pular" }); }
  catch (e: any) { skipRejected = e instanceof LedgerValidationError && e.code === "invalid_transition"; }
  check("3.3 salto ANALYZED → PRODUCTION rejeitado", skipRejected);

  // reason obrigatório
  let reasonRequired = false;
  try { PEL.setStatus("TRANSITION_TEST", { new_status: "PRD_READY" } as any); }
  catch (e: any) { reasonRequired = e instanceof LedgerValidationError && e.code === "missing_reason"; }
  check("3.4 transição sem reason rejeitada", reasonRequired);

  // Avança até PRODUCTION passo a passo
  PEL.setStatus("TRANSITION_TEST", { new_status: "PRD_READY", reason: "prd" });
  PEL.setStatus("TRANSITION_TEST", { new_status: "APPROVED", reason: "ap" });
  PEL.setStatus("TRANSITION_TEST", { new_status: "IMPLEMENTING", reason: "impl" });
  PEL.setStatus("TRANSITION_TEST", { new_status: "CODED", reason: "coded" });
  PEL.setStatus("TRANSITION_TEST", { new_status: "TESTED", reason: "tested" });
  const t3 = PEL.setStatus("TRANSITION_TEST", { new_status: "PRODUCTION", reason: "em prod" });
  check("3.5 progressão até PRODUCTION funciona", t3.status === "PRODUCTION");

  // ═══════════════ 4. VALIDATED requer evidência verificada (RN-PEL-4) ═══════════════
  let noEvidenceRejected = false;
  try { PEL.setStatus("TRANSITION_TEST", { new_status: "VALIDATED", reason: "sem evid" }); }
  catch (e: any) { noEvidenceRejected = e instanceof LedgerValidationError && e.code === "no_verified_evidence"; }
  check("4.1 VALIDATED sem evidência verificada rejeitado", noEvidenceRejected);

  // adiciona evidência NÃO verificada — ainda rejeita
  const evid = PEL.addEvidence("TRANSITION_TEST", { evidence_type: "code", reference: "src/x.ts:42" });
  let stillRejected = false;
  try { PEL.setStatus("TRANSITION_TEST", { new_status: "VALIDATED", reason: "não verified" }); }
  catch (e: any) { stillRejected = e instanceof LedgerValidationError; }
  check("4.2 VALIDATED com evidência não verificada rejeitado", stillRejected);
  check("4.3 evidência criada com verified=0 por default", evid.verified === 0);

  // verifica → agora aceita
  PEL.verifyEvidence(evid.id, "user-42");
  const t4 = PEL.setStatus("TRANSITION_TEST", { new_status: "VALIDATED", reason: "confirmado" });
  check("4.4 VALIDATED com evidência verificada aceito", t4.status === "VALIDATED");
  check("4.5 validated_at é setado", !!t4.validated_at);

  // ═══════════════ 5. SUPERSEDED requer superseded_by (RN-PEL-5) ═══════════════
  const sup = PEL.createItem({ evolution_key: "SUPERSEDER", title: "novo" });
  PEL.createItem({ evolution_key: "TO_BE_SUPERSEDED", title: "antigo" });

  // Progressão pra CODED (estado válido pra SUPERSEDED)
  PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "ANALYZED", reason: "a" });
  PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "PRD_READY", reason: "b" });
  PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "APPROVED", reason: "c" });
  PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "IMPLEMENTING", reason: "d" });

  // SUPERSEDED sem superseded_by → recusa
  let noSupRejected = false;
  try { PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "SUPERSEDED", reason: "morto" }); }
  catch (e: any) { noSupRejected = e instanceof LedgerValidationError && e.code === "missing_superseded_by"; }
  check("5.1 SUPERSEDED sem superseded_by rejeitado", noSupRejected);

  // SUPERSEDED com chave inexistente → recusa
  let invalidSupRejected = false;
  try { PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "SUPERSEDED", reason: "m", superseded_by: "GHOST" }); }
  catch (e: any) { invalidSupRejected = e instanceof LedgerValidationError && e.code === "invalid_superseded_by"; }
  check("5.2 SUPERSEDED com chave inexistente rejeitado", invalidSupRejected);

  // SUPERSEDED com chave válida → aceita
  const t5 = PEL.setStatus("TO_BE_SUPERSEDED", { new_status: "SUPERSEDED", reason: "m", superseded_by: "SUPERSEDER" });
  check("5.3 SUPERSEDED com chave válida aceito", t5.status === "SUPERSEDED" && t5.superseded_by === "SUPERSEDER");

  // ═══════════════ 6. enums de tipo (RN-PEL-6) ═══════════════
  PEL.createItem({ evolution_key: "ENUM_TEST", title: "enum" });

  // todos os 13 evidence_types aceitos
  let allEvidOk = true;
  for (const et of EVIDENCE_TYPES) {
    try { PEL.addEvidence("ENUM_TEST", { evidence_type: et, reference: `ref-${et}` }); }
    catch { allEvidOk = false; break; }
  }
  check("6.1 todos os 13 evidence_types aceitos", allEvidOk && EVIDENCE_TYPES.length === 13);

  let badEvidRejected = false;
  try { PEL.addEvidence("ENUM_TEST", { evidence_type: "banana" as any, reference: "x" }); }
  catch (e: any) { badEvidRejected = e instanceof LedgerValidationError && e.code === "invalid_evidence_type"; }
  check("6.2 evidence_type inválido rejeitado", badEvidRejected);

  // todos os 10 source_types aceitos
  let allSrcOk = true;
  for (const st of SOURCE_TYPES) {
    try { PEL.addSource("ENUM_TEST", { source_type: st, title: `src-${st}` }); }
    catch { allSrcOk = false; break; }
  }
  check("6.3 todos os 10 source_types aceitos", allSrcOk && SOURCE_TYPES.length === 10);

  let badSrcRejected = false;
  try { PEL.addSource("ENUM_TEST", { source_type: "carrot" as any, title: "x" }); }
  catch (e: any) { badSrcRejected = e instanceof LedgerValidationError && e.code === "invalid_source_type"; }
  check("6.4 source_type inválido rejeitado", badSrcRejected);

  // ═══════════════ 7. filtros ═══════════════
  // Cria items com domínios/status distintos
  const q1 = PEL.createItem({ evolution_key: "FILTER_A", title: "alpha", domain: "vision" });
  PEL.createItem({ evolution_key: "FILTER_B", title: "beta", domain: "vision" });
  PEL.createItem({ evolution_key: "FILTER_C", title: "gamma", domain: "verticals" });
  PEL.setStatus("FILTER_A", { new_status: "ANALYZED", reason: "a" });

  const byStatus = PEL.listItems({ status: "ANALYZED" });
  check("7.1 filtro por status funciona", byStatus.some(i => i.evolution_key === "FILTER_A") && byStatus.some(i => i.evolution_key === "TRANSITION_TEST") === false);

  const byDomain = PEL.listItems({ domain: "vision" });
  check("7.2 filtro por domain funciona", byDomain.length === 2 && byDomain.every(i => i.domain === "vision"));

  const byQ = PEL.listItems({ q: "alpha" });
  check("7.3 filtro por q em title funciona", byQ.length === 1 && byQ[0].evolution_key === "FILTER_A");

  // ═══════════════ 8. gaps view ═══════════════
  // FILTER_B tá em IDEA (não é gap por definição — só entra a partir de PRD_READY)
  // FILTER_A tá em ANALYZED (não é gap ainda)
  // Vou criar um que esteja em CODED sem evidência verificada
  PEL.createItem({ evolution_key: "GAP_ITEM", title: "gap", priority: "P0" });
  PEL.setStatus("GAP_ITEM", { new_status: "ANALYZED", reason: "a" });
  PEL.setStatus("GAP_ITEM", { new_status: "PRD_READY", reason: "b" });
  PEL.setStatus("GAP_ITEM", { new_status: "APPROVED", reason: "c" });
  PEL.setStatus("GAP_ITEM", { new_status: "IMPLEMENTING", reason: "d" });
  PEL.setStatus("GAP_ITEM", { new_status: "CODED", reason: "e" });

  const gaps = PEL.gaps();
  check("8.1 gaps inclui item CODED sem evidência verificada", gaps.some(i => i.evolution_key === "GAP_ITEM"));
  check("8.2 gaps NÃO inclui item VALIDATED (TRANSITION_TEST)", !gaps.some(i => i.evolution_key === "TRANSITION_TEST"));
  check("8.3 gaps NÃO inclui item IDEA (FILTER_B)", !gaps.some(i => i.evolution_key === "FILTER_B"));

  // ═══════════════ 9. imutabilidade + updateItem ═══════════════
  const upd = PEL.updateItem("FILTER_A", { summary: "atualizado", priority: "P1" });
  check("9.1 updateItem atualiza campos permitidos", upd.summary === "atualizado" && upd.priority === "P1");

  // Ledger service NÃO expõe método pra mudar evolution_key — rota bloqueia via handler.
  // O teste da rota valida esse caminho no server; aqui garantimos que evolution_key
  // não muda por updateItem (a lista `allowed` no service não o inclui).
  const untouched = PEL.getItem("FILTER_A");
  check("9.2 evolution_key permanece imutável após update", untouched?.evolution_key === "FILTER_A");

  // getItem inexistente
  check("9.3 getItem inexistente retorna null", PEL.getItem("GHOST_KEY") === null);

  // updateItem em inexistente → throw
  let notFoundThrown = false;
  try { PEL.updateItem("GHOST_KEY", { title: "x" }); }
  catch (e: any) { notFoundThrown = e instanceof LedgerNotFoundError; }
  check("9.4 updateItem em item inexistente lança LedgerNotFoundError", notFoundThrown);

  // ═══════════════ 10. contadores esperados ═══════════════
  check("10.1 STATUSES tem 13 valores", STATUSES.length === 13);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
