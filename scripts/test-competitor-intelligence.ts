/**
 * TEST — CompetitorIntelligenceService (Closure Track B do PRD-PEL-01, F1).
 * DB-backed, determinístico. Prova:
 *   1. Schema: competitor_accounts com colunas certas + UNIQUE(org, platform, handle);
 *   2. Validações: missing_org, missing_platform, invalid_platform,
 *      missing_handle, invalid_handle, duplicate_competitor;
 *   3. Handle é normalizado (strip @ inicial);
 *   4. Duplicata case-insensitive dentro da mesma org+platform;
 *   5. Mesma handle em outra org OU outra platform é permitida;
 *   6. tags são filtradas (não-strings ignoradas) e limitadas em 20;
 *   7. listCompetitors filtra por org, active default, platform;
 *   8. getCompetitor só retorna da própria org;
 *   9. updateCompetitor faz merge parcial; handle/platform imutáveis
 *      (não expostos no patch);
 *  10. deactivate/reactivate atualizam active com touch em updated_at;
 *  11. hardDelete só remove se a org for dona;
 *  12. includeInactive:true traz também os soft-deleted.
 *
 * Uso: npm run test:competitor-intelligence
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ci-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ci-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { CompetitorIntelligenceService: CIS, CompetitorError, SUPPORTED_PLATFORMS } =
    await import("../src/server/CompetitorIntelligenceService.js");

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(competitor_accounts)").all() as any[])
    .map(c => c.name);
  check("1.1 competitor_accounts tem organization_id", cols.includes("organization_id"));
  check("1.2 competitor_accounts tem platform", cols.includes("platform"));
  check("1.3 competitor_accounts tem handle", cols.includes("handle"));
  check("1.4 competitor_accounts tem display_name", cols.includes("display_name"));
  check("1.5 competitor_accounts tem notes", cols.includes("notes"));
  check("1.6 competitor_accounts tem tags_json", cols.includes("tags_json"));
  check("1.7 competitor_accounts tem active", cols.includes("active"));
  check("1.8 SUPPORTED_PLATFORMS inclui instagram, tiktok, youtube, linkedin, x, facebook",
    SUPPORTED_PLATFORMS.includes("instagram") &&
    SUPPORTED_PLATFORMS.includes("tiktok") &&
    SUPPORTED_PLATFORMS.includes("youtube") &&
    SUPPORTED_PLATFORMS.includes("linkedin") &&
    SUPPORTED_PLATFORMS.includes("x") &&
    SUPPORTED_PLATFORMS.includes("facebook"));

  const ORG_A = "org-alpha";
  const ORG_B = "org-beta";

  // ═══════════════ 2. Validações de addCompetitor ═══════════════
  let missingOrg = false;
  try { CIS.addCompetitor({ orgId: "", platform: "instagram", handle: "nike" }); }
  catch (e: any) { missingOrg = e instanceof CompetitorError && e.code === "missing_org"; }
  check("2.1 orgId vazio → missing_org", missingOrg);

  let missingPlatform = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "", handle: "nike" }); }
  catch (e: any) { missingPlatform = e instanceof CompetitorError && e.code === "missing_platform"; }
  check("2.2 platform vazio → missing_platform", missingPlatform);

  let invalidPlatform = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "myspace" as any, handle: "nike" }); }
  catch (e: any) { invalidPlatform = e instanceof CompetitorError && e.code === "invalid_platform"; }
  check("2.3 platform desconhecido → invalid_platform", invalidPlatform);

  let missingHandle = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "" }); }
  catch (e: any) { missingHandle = e instanceof CompetitorError && e.code === "missing_handle"; }
  check("2.4 handle vazio → missing_handle", missingHandle);

  let handleWithAtSign = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "@" }); }
  catch (e: any) { handleWithAtSign = e instanceof CompetitorError && e.code === "missing_handle"; }
  check("2.5 só '@' → missing_handle (após strip)", handleWithAtSign);

  let invalidHandle = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "com espaço" }); }
  catch (e: any) { invalidHandle = e instanceof CompetitorError && e.code === "invalid_handle"; }
  check("2.6 handle com char inválido → invalid_handle", invalidHandle);

  let tooLong = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "a".repeat(33) }); }
  catch (e: any) { tooLong = e instanceof CompetitorError && e.code === "invalid_handle"; }
  check("2.7 handle > 32 chars → invalid_handle", tooLong);

  // ═══════════════ 3. Happy path ═══════════════
  const c1 = CIS.addCompetitor({
    orgId: ORG_A, platform: "instagram", handle: "@nike",
    display_name: "Nike Brasil", notes: "referência no varejo",
    tags: ["retail", "athletics"],
  });
  check("3.1 handle com @ é armazenado sem @", c1.handle === "nike");
  check("3.2 display_name/notes/tags preenchidos",
    c1.display_name === "Nike Brasil" && c1.notes === "referência no varejo" && c1.tags.length === 2);
  check("3.3 active=true default", c1.active === true);
  check("3.4 organization_id vem no retorno", c1.organization_id === ORG_A);
  check("3.5 platform vem no retorno", c1.platform === "instagram");

  // ═══════════════ 4. Duplicata rejeitada (case-insensitive) ═══════════════
  let dup = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "nike" }); }
  catch (e: any) { dup = e instanceof CompetitorError && e.code === "duplicate_competitor"; }
  check("4.1 duplicata exata → duplicate_competitor", dup);

  let dupCase = false;
  try { CIS.addCompetitor({ orgId: ORG_A, platform: "instagram", handle: "NIKE" }); }
  catch (e: any) { dupCase = e instanceof CompetitorError && e.code === "duplicate_competitor"; }
  check("4.2 duplicata case-insensitive rejeitada", dupCase);

  // ═══════════════ 5. Mesma handle permitida em outra org OU outra platform ═══════════════
  const c2 = CIS.addCompetitor({ orgId: ORG_B, platform: "instagram", handle: "nike" });
  check("5.1 mesma handle em outra org OK", c2.organization_id === ORG_B && c2.handle === "nike");

  const c3 = CIS.addCompetitor({ orgId: ORG_A, platform: "tiktok", handle: "nike" });
  check("5.2 mesma handle em outra platform da mesma org OK", c3.platform === "tiktok");

  // ═══════════════ 6. Tags filtradas e limitadas ═══════════════
  const cTags = CIS.addCompetitor({
    orgId: ORG_A, platform: "youtube", handle: "adidas",
    tags: ["a", "b", null as any, "c", 123 as any, "d", ...Array(30).fill("x")],
  });
  check("6.1 tags não-string são filtradas", !cTags.tags.some(t => typeof t !== "string"));
  check("6.2 tags limitadas em 20", cTags.tags.length === 20);

  // ═══════════════ 7. listCompetitors ═══════════════
  const listA = CIS.listCompetitors(ORG_A);
  check("7.1 lista de ORG_A tem 3 ativos (nike/ig, nike/tiktok, adidas/yt)", listA.length === 3);
  check("7.2 lista filtra por org (não vê ORG_B)", !listA.some(c => c.organization_id !== ORG_A));

  const listAins = CIS.listCompetitors(ORG_A, { platform: "instagram" });
  check("7.3 filtro por platform funciona", listAins.length === 1 && listAins[0].platform === "instagram");

  const listB = CIS.listCompetitors(ORG_B);
  check("7.4 lista de ORG_B só tem o próprio", listB.length === 1 && listB[0].organization_id === ORG_B);

  const listNone = CIS.listCompetitors("");
  check("7.5 orgId vazio → []", listNone.length === 0);

  // ═══════════════ 8. getCompetitor só da própria org ═══════════════
  const getSelf = CIS.getCompetitor(ORG_A, c1.id);
  check("8.1 dono acessa próprio", getSelf?.id === c1.id);

  const getOther = CIS.getCompetitor(ORG_B, c1.id);
  check("8.2 outra org não acessa por id → null", getOther === null);

  const getNone = CIS.getCompetitor("", c1.id);
  check("8.3 orgId vazio → null", getNone === null);

  // ═══════════════ 9. updateCompetitor merge parcial ═══════════════
  const upd1 = CIS.updateCompetitor(ORG_A, c1.id, { notes: "atualizado" });
  check("9.1 notes atualiza", upd1?.notes === "atualizado");
  check("9.2 outros campos preservados (display_name)", upd1?.display_name === "Nike Brasil");
  check("9.3 outros campos preservados (tags)", (upd1?.tags?.length || 0) === 2);

  const upd2 = CIS.updateCompetitor(ORG_A, c1.id, { display_name: null, tags: ["novo"] });
  check("9.4 display_name pode ser limpo", upd2?.display_name === null);
  check("9.5 tags substituídas", upd2?.tags.length === 1 && upd2?.tags[0] === "novo");
  check("9.6 notes preservada do update anterior", upd2?.notes === "atualizado");

  const updNone = CIS.updateCompetitor(ORG_A, "id-inexistente", { notes: "x" });
  check("9.7 update em id inexistente → null", updNone === null);

  const updWrongOrg = CIS.updateCompetitor(ORG_B, c1.id, { notes: "invasao" });
  check("9.8 update por outra org → null (isolamento)", updWrongOrg === null);

  const stillOk = CIS.getCompetitor(ORG_A, c1.id);
  check("9.9 update por outra org NÃO altera dados", stillOk?.notes === "atualizado");

  // ═══════════════ 10. deactivate / reactivate ═══════════════
  const deact = CIS.deactivate(ORG_A, c1.id);
  check("10.1 deactivate retorna true", deact === true);

  const afterDeact = CIS.getCompetitor(ORG_A, c1.id);
  check("10.2 active=false após deactivate", afterDeact?.active === false);

  // Lista default esconde inativo
  const listActive = CIS.listCompetitors(ORG_A);
  check("10.3 lista default esconde inativos", listActive.length === 2);

  // includeInactive traz todos
  const listAll = CIS.listCompetitors(ORG_A, { includeInactive: true });
  check("10.4 includeInactive traz também inativos", listAll.length === 3);

  const deactAgain = CIS.deactivate(ORG_A, c1.id);
  check("10.5 deactivate em já inativo → false", deactAgain === false);

  const react = CIS.reactivate(ORG_A, c1.id);
  check("10.6 reactivate retorna true", react === true);

  const afterReact = CIS.getCompetitor(ORG_A, c1.id);
  check("10.7 active=true após reactivate", afterReact?.active === true);

  const reactAgain = CIS.reactivate(ORG_A, c1.id);
  check("10.8 reactivate em já ativo → false", reactAgain === false);

  const deactWrongOrg = CIS.deactivate(ORG_B, c1.id);
  check("10.9 deactivate por outra org → false", deactWrongOrg === false);

  // ═══════════════ 11. hardDelete ═══════════════
  const delWrongOrg = CIS.hardDelete(ORG_B, c1.id);
  check("11.1 hardDelete por outra org → false", delWrongOrg === false);

  const stillPresent = CIS.getCompetitor(ORG_A, c1.id);
  check("11.2 após tentativa mal-sucedida, registro intacto", stillPresent?.id === c1.id);

  const del = CIS.hardDelete(ORG_A, c1.id);
  check("11.3 dono hardDelete → true", del === true);

  const gone = CIS.getCompetitor(ORG_A, c1.id);
  check("11.4 após hardDelete, get retorna null", gone === null);

  const delAgain = CIS.hardDelete(ORG_A, c1.id);
  check("11.5 hardDelete em já removido → false", delAgain === false);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
