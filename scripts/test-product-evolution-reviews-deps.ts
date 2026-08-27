/**
 * TEST — Reviews (histórico) + Dependencies (grafo) do Product Evolution Ledger
 * (ADR-193 F1.5).
 *
 * Prova:
 *   1. setStatus grava review imutável;
 *   2. Reviews ordenados por mais recente primeiro;
 *   3. Evidence snapshot é serializado JSON e volta como array;
 *   4. Dependencies: 4 tipos aceitos, tipo inválido rejeitado;
 *   5. Self-dependency rejeitada;
 *   6. Chave inexistente → 404;
 *   7. Idempotência: mesma dependência 2x retorna a mesma linha;
 *   8. listDependencies retorna outgoing + incoming;
 *   9. removeDependency remove por id.
 *
 * Uso: npm run test:product-evolution-reviews-deps
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pel-rd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rd-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { ProductEvolutionLedgerService: PEL, LedgerValidationError, LedgerNotFoundError } =
    await import("../src/server/ProductEvolutionLedgerService.js");

  // ═══════════════ 1. Schemas ═══════════════
  const revCols = (db.prepare("PRAGMA table_info(product_evolution_reviews)").all() as any[]).map(c => c.name);
  check("1.1 product_evolution_reviews tem previous_status/new_status/reason",
    revCols.includes("previous_status") && revCols.includes("new_status") && revCols.includes("reason"));
  check("1.2 product_evolution_reviews SEM organization_id (global)", !revCols.includes("organization_id"));

  const depCols = (db.prepare("PRAGMA table_info(product_evolution_dependencies)").all() as any[]).map(c => c.name);
  check("1.3 product_evolution_dependencies tem dependency_type", depCols.includes("dependency_type"));
  check("1.4 product_evolution_dependencies SEM organization_id (global)", !depCols.includes("organization_id"));

  // ═══════════════ 2. Reviews — setStatus grava review ═══════════════
  PEL.createItem({ evolution_key: "REV_TEST", title: "review test" });
  PEL.setStatus("REV_TEST", { new_status: "ANALYZED", reason: "primeira análise" });
  PEL.setStatus("REV_TEST", { new_status: "PRD_READY", reason: "PRD escrito" });
  PEL.setStatus("REV_TEST", { new_status: "APPROVED", reason: "aprovado pelo dono" });

  const reviews = PEL.listReviews("REV_TEST");
  check("2.1 3 transições geraram 3 reviews", reviews.length === 3);
  check("2.2 review mais recente é APPROVED", reviews[0].new_status === "APPROVED");
  check("2.3 review mais antigo é ANALYZED", reviews[2].new_status === "ANALYZED");
  check("2.4 previous_status coerente com progressão",
    reviews[0].previous_status === "PRD_READY" && reviews[2].previous_status === "IDEA");
  check("2.5 reason preservado", reviews[0].reason === "aprovado pelo dono");

  // ═══════════════ 3. Evidence snapshot no review ═══════════════
  const ev = PEL.addEvidence("REV_TEST", { evidence_type: "code", reference: "src/x.ts" });
  PEL.verifyEvidence(ev.id, "reviewer-x");
  PEL.setStatus("REV_TEST", { new_status: "IMPLEMENTING", reason: "iniciando implementação" });
  const revsWithEvid = PEL.listReviews("REV_TEST");
  check("3.1 review mais recente tem evidence_snapshot array",
    Array.isArray(revsWithEvid[0].evidence_snapshot));
  check("3.2 snapshot inclui a evidência criada",
    revsWithEvid[0].evidence_snapshot.length === 1 &&
    revsWithEvid[0].evidence_snapshot[0].evidence_type === "code");
  check("3.3 snapshot registra verified=1",
    revsWithEvid[0].evidence_snapshot[0].verified === 1);

  // Snapshot dos reviews antigos (antes da evid) é vazio
  check("3.4 review antigo tem snapshot vazio (evid não existia ainda)",
    revsWithEvid[3].evidence_snapshot.length === 0);

  // ═══════════════ 4. listReviews em item inexistente ═══════════════
  let notFoundThrown = false;
  try { PEL.listReviews("GHOST_KEY"); }
  catch (e: any) { notFoundThrown = e instanceof LedgerNotFoundError; }
  check("4.1 listReviews em item inexistente lança LedgerNotFoundError", notFoundThrown);

  // ═══════════════ 5. Dependencies — tipos aceitos ═══════════════
  PEL.createItem({ evolution_key: "DEP_A", title: "A" });
  PEL.createItem({ evolution_key: "DEP_B", title: "B" });
  PEL.createItem({ evolution_key: "DEP_C", title: "C" });

  const dep1 = PEL.addDependency({
    evolution_key: "DEP_A",
    depends_on_key: "DEP_B",
    dependency_type: "requires",
    notes: "A precisa de B pronto",
  });
  check("5.1 addDependency retorna row", !!dep1?.id);
  check("5.2 dependency_type persistido", dep1.dependency_type === "requires");

  const types: Array<'requires' | 'enhances' | 'blocks' | 'related'> = ['enhances', 'blocks', 'related'];
  let allTypesOk = true;
  for (const t of types) {
    try { PEL.addDependency({ evolution_key: "DEP_A", depends_on_key: "DEP_C", dependency_type: t }); }
    catch { allTypesOk = false; break; }
  }
  check("5.3 todos os 4 tipos aceitos", allTypesOk);

  // Tipo inválido
  let badTypeRejected = false;
  try { PEL.addDependency({ evolution_key: "DEP_A", depends_on_key: "DEP_B", dependency_type: "banana" as any }); }
  catch (e: any) { badTypeRejected = e instanceof LedgerValidationError && e.code === "invalid_dependency_type"; }
  check("5.4 dependency_type inválido rejeitado", badTypeRejected);

  // ═══════════════ 6. Self-dependency ═══════════════
  let selfRejected = false;
  try { PEL.addDependency({ evolution_key: "DEP_A", depends_on_key: "DEP_A", dependency_type: "requires" }); }
  catch (e: any) { selfRejected = e instanceof LedgerValidationError && e.code === "self_dependency"; }
  check("6.1 self-dependency rejeitada", selfRejected);

  // ═══════════════ 7. Chave inexistente ═══════════════
  let ghostRejected = false;
  try { PEL.addDependency({ evolution_key: "GHOST", depends_on_key: "DEP_B", dependency_type: "requires" }); }
  catch (e: any) { ghostRejected = e instanceof LedgerNotFoundError; }
  check("7.1 addDependency com from inexistente → 404", ghostRejected);

  let ghostTargetRejected = false;
  try { PEL.addDependency({ evolution_key: "DEP_A", depends_on_key: "GHOST", dependency_type: "requires" }); }
  catch (e: any) { ghostTargetRejected = e instanceof LedgerNotFoundError; }
  check("7.2 addDependency com alvo inexistente → 404", ghostTargetRejected);

  // ═══════════════ 8. Idempotência ═══════════════
  const dep1Again = PEL.addDependency({
    evolution_key: "DEP_A",
    depends_on_key: "DEP_B",
    dependency_type: "requires",
    notes: "outra nota",
  });
  check("8.1 mesma dependência 2x → retorna o mesmo id", dep1Again.id === dep1.id);

  // ═══════════════ 9. listDependencies ═══════════════
  const listA = PEL.listDependencies("DEP_A");
  check("9.1 A tem 4 outgoing (requires B + 3 tipos → C)", listA.outgoing.length === 4);
  check("9.2 A não tem incoming", listA.incoming.length === 0);
  // outgoing pra B do tipo requires
  const outB = listA.outgoing.find(d => d.depends_on_key === "DEP_B");
  check("9.3 outgoing tem depends_on_key + depends_on_title",
    outB?.depends_on_key === "DEP_B" && outB?.depends_on_title === "B");

  const listB = PEL.listDependencies("DEP_B");
  check("9.4 B tem 1 incoming (A → B requires)", listB.incoming.length === 1);
  check("9.5 B não tem outgoing", listB.outgoing.length === 0);
  check("9.6 incoming aponta pra A", listB.incoming[0].item_key === "DEP_A");

  // ═══════════════ 10. removeDependency ═══════════════
  const removed = PEL.removeDependency(dep1.id);
  check("10.1 removeDependency retorna true", removed === true);
  const removedAgain = PEL.removeDependency(dep1.id);
  check("10.2 remover 2x retorna false", removedAgain === false);
  const listBAfter = PEL.listDependencies("DEP_B");
  check("10.3 B não tem mais incoming após remove", listBAfter.incoming.length === 0);

  // ═══════════════ 11. Transições após F1.5 não regridem ═══════════════
  // Item novo em IDEA sem review anterior — setStatus deve funcionar normal
  PEL.createItem({ evolution_key: "SMOKE_TEST_F15", title: "smoke" });
  PEL.setStatus("SMOKE_TEST_F15", { new_status: "ANALYZED", reason: "smoke" });
  const smokeRevs = PEL.listReviews("SMOKE_TEST_F15");
  check("11.1 novo item cria review corretamente", smokeRevs.length === 1);
  check("11.2 previous_status = IDEA", smokeRevs[0].previous_status === "IDEA");

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
