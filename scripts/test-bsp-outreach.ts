/**
 * TEST — BusinessSkillsPackService (Track C do PRD-PEL-01, F3 Local Marketing).
 * DB-backed, determinístico. Prova:
 *   1. Schema: bsp_contact_competitor_match com PK composta e índices;
 *   2. enrichContactsWithCompetitor: match case-insensitive por identifier↔handle;
 *   3. Multi-plataforma (não filtra por provider do canal);
 *   4. Idempotência: reroda não duplica;
 *   5. Só considera competitor active=1;
 *   6. listContactCompetitorMatches: join com detalhes, ordenação por matched_at DESC, limit;
 *   7. isContactWatchedCompetitor: lookup rápido;
 *   8. missing_org;
 *   9. Isolamento multi-tenant.
 *
 * Uso: npm run test:bsp-outreach
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bsp-outreach-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bsp-out-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessSkillsPackService: BSP, BusinessSkillsPackError } =
    await import("../src/server/BusinessSkillsPackService.js");
  const { v4: uuidv4 } = await import("uuid");

  const ORG_A = "org-alpha-out";
  const ORG_B = "org-beta-out";

  // ═══════════════ 1. Schema ═══════════════
  const cols = (db.prepare("PRAGMA table_info(bsp_contact_competitor_match)").all() as any[])
    .map((c: any) => c.name);
  for (const col of ["organization_id", "contact_id", "competitor_id", "matched_at"]) {
    check(`1.x coluna ${col}`, cols.includes(col));
  }
  const idxs = (db.prepare("PRAGMA index_list(bsp_contact_competitor_match)").all() as any[])
    .map((i: any) => i.name);
  check("1.x índice por org existe",
    idxs.some((n: string) => n.includes("bsp_ccm_org")));

  // Seed: canal + contatos + competitors para ORG_A
  const CH_WA = uuidv4();
  const CH_IG = uuidv4();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier) VALUES (?, ?, 'whatsapp', 'WA A', 'wa-a')`).run(CH_WA, ORG_A);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier) VALUES (?, ?, 'instagram', 'IG A', 'ig-a')`).run(CH_IG, ORG_A);

  const insertContact = (id: string, orgId: string, channelId: string, name: string, identifier: string) => {
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, channelId, name, identifier);
  };
  const insertCompetitor = (id: string, orgId: string, platform: string, handle: string, displayName?: string, active: number = 1) => {
    db.prepare(`INSERT INTO competitor_accounts (id, organization_id, platform, handle, display_name, active) VALUES (?, ?, ?, ?, ?, ?)`).run(id, orgId, platform, handle, displayName || null, active);
  };

  const C1 = uuidv4(); insertContact(C1, ORG_A, CH_WA, "Loja X", "lojax");
  const C2 = uuidv4(); insertContact(C2, ORG_A, CH_IG, "Loja Y", "LojaY"); // maiúsculo → case-insensitive
  const C3 = uuidv4(); insertContact(C3, ORG_A, CH_WA, "Cliente normal", "5511999998888"); // não bate com nenhum concorrente
  const C4 = uuidv4(); insertContact(C4, ORG_A, CH_IG, "Loja Z inativa", "lojaz-inactive");

  const K1 = uuidv4(); insertCompetitor(K1, ORG_A, "instagram", "LOJAX", "Loja X Concorrente"); // case dif do contato
  const K2 = uuidv4(); insertCompetitor(K2, ORG_A, "tiktok", "lojay");
  const K3 = uuidv4(); insertCompetitor(K3, ORG_A, "instagram", "lojaz-inactive", "Inativa", 0); // inativo → não bate
  const K4 = uuidv4(); insertCompetitor(K4, ORG_A, "youtube", "nao-existe-como-contato");

  // ═══════════════ 2. enrichContactsWithCompetitor — happy path ═══════════════
  const r1 = BSP.enrichContactsWithCompetitor(ORG_A);
  check("2.1 contacts_checked = 4", r1.contacts_checked === 4);
  check("2.2 competitors_active = 3 (K3 inativo)", r1.competitors_active === 3);
  check("2.3 matched = 2 (C1↔K1, C2↔K2)", r1.matched === 2);

  // Confirma na tabela
  const persisted = db.prepare(
    "SELECT contact_id, competitor_id FROM bsp_contact_competitor_match WHERE organization_id = ?"
  ).all(ORG_A) as any[];
  const pairs = new Set(persisted.map((p: any) => `${p.contact_id}:${p.competitor_id}`));
  check("2.4 match C1↔K1 persistido", pairs.has(`${C1}:${K1}`));
  check("2.5 match C2↔K2 persistido", pairs.has(`${C2}:${K2}`));
  check("2.6 total de rows = 2", persisted.length === 2);
  check("2.7 C3 (sem competitor correspondente) não gerou match",
    ![...pairs].some(p => p.startsWith(`${C3}:`)));
  check("2.8 C4↔K3 NÃO persistiu (competitor inativo)",
    !pairs.has(`${C4}:${K3}`));
  check("2.9 K4 (sem contato correspondente) não gerou row",
    ![...pairs].some(p => p.endsWith(`:${K4}`)));

  // ═══════════════ 3. Multi-plataforma (não filtra por provider de canal) ═══════════════
  // C1 é WhatsApp mas match com competitor instagram — OK
  const row1 = db.prepare(
    "SELECT ca.platform FROM bsp_contact_competitor_match m JOIN competitor_accounts ca ON ca.id = m.competitor_id WHERE m.contact_id = ?"
  ).get(C1) as any;
  check("3.1 contato WhatsApp bate com competitor instagram (multi-platform)",
    row1?.platform === "instagram");

  // C2 é IG mas match com competitor tiktok — OK
  const row2 = db.prepare(
    "SELECT ca.platform FROM bsp_contact_competitor_match m JOIN competitor_accounts ca ON ca.id = m.competitor_id WHERE m.contact_id = ?"
  ).get(C2) as any;
  check("3.2 contato Instagram bate com competitor tiktok (multi-platform)",
    row2?.platform === "tiktok");

  // ═══════════════ 4. Idempotência ═══════════════
  const beforeCount = (db.prepare("SELECT COUNT(*) c FROM bsp_contact_competitor_match WHERE organization_id = ?").get(ORG_A) as any).c;
  const r2 = BSP.enrichContactsWithCompetitor(ORG_A);
  const afterCount = (db.prepare("SELECT COUNT(*) c FROM bsp_contact_competitor_match WHERE organization_id = ?").get(ORG_A) as any).c;
  check("4.1 reroda não duplica", afterCount === beforeCount);
  check("4.2 matched reportado ainda = 2", r2.matched === 2);

  // ═══════════════ 5. Novo competitor entra no batch ═══════════════
  const K5 = uuidv4();
  insertCompetitor(K5, ORG_A, "instagram", "5511999998888"); // bate com C3
  const r3 = BSP.enrichContactsWithCompetitor(ORG_A);
  check("5.1 novo competitor gera novo match (matched = 3)", r3.matched === 3);
  check("5.2 competitors_active pulou pra 4", r3.competitors_active === 4);

  // ═══════════════ 6. listContactCompetitorMatches ═══════════════
  const list = BSP.listContactCompetitorMatches(ORG_A);
  check("6.1 lista retorna 3 rows", list.length === 3);
  const item = list.find((x: any) => x.contact_id === C1);
  check("6.2 item tem contact_name", item?.contact_name === "Loja X");
  check("6.3 item tem contact_identifier", item?.contact_identifier === "lojax");
  check("6.4 item tem competitor_handle", item?.competitor_handle === "LOJAX");
  check("6.5 item tem competitor_platform", item?.competitor_platform === "instagram");
  check("6.6 item tem competitor_display_name",
    item?.competitor_display_name === "Loja X Concorrente");
  check("6.7 item tem matched_at",
    typeof item?.matched_at === "string" && item.matched_at.length > 0);

  // limit
  const limited = BSP.listContactCompetitorMatches(ORG_A, { limit: 1 });
  check("6.8 limit=1 respeitado", limited.length === 1);

  // limit clamping (>500 → 500; <1 → 1)
  const clampedHi = BSP.listContactCompetitorMatches(ORG_A, { limit: 99999 });
  check("6.9 limit>500 clamp funciona (retorna todos disponíveis)",
    clampedHi.length === 3);
  const clampedLo = BSP.listContactCompetitorMatches(ORG_A, { limit: 0 });
  check("6.10 limit=0 clamp para 1", clampedLo.length === 1);

  // orgId vazio → []
  check("6.11 orgId vazio → []",
    BSP.listContactCompetitorMatches("").length === 0);

  // ═══════════════ 7. isContactWatchedCompetitor ═══════════════
  check("7.1 contato COM match → true",
    BSP.isContactWatchedCompetitor(ORG_A, C1) === true);
  check("7.2 contato SEM match → false",
    BSP.isContactWatchedCompetitor(ORG_A, C4) === false);
  check("7.3 orgId vazio → false",
    BSP.isContactWatchedCompetitor("", C1) === false);
  check("7.4 contactId vazio → false",
    BSP.isContactWatchedCompetitor(ORG_A, "") === false);
  check("7.5 contact_id inexistente → false",
    BSP.isContactWatchedCompetitor(ORG_A, "nao-existe") === false);

  // ═══════════════ 8. Validações ═══════════════
  let missingOrg = false;
  try { BSP.enrichContactsWithCompetitor(""); }
  catch (e: any) { missingOrg = e instanceof BusinessSkillsPackError && e.code === "missing_org"; }
  check("8.1 orgId vazio → missing_org", missingOrg);

  // Org com zero contatos e zero competitors — não quebra
  const ORG_EMPTY = "org-empty-out";
  const rEmpty = BSP.enrichContactsWithCompetitor(ORG_EMPTY);
  check("8.2 org sem dados → matched=0, checked=0, active=0",
    rEmpty.matched === 0 && rEmpty.contacts_checked === 0 && rEmpty.competitors_active === 0);

  // ═══════════════ 9. Isolamento multi-tenant ═══════════════
  const CH_B = uuidv4();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name) VALUES (?, ?, 'whatsapp', 'WA B')`).run(CH_B, ORG_B);
  const CB1 = uuidv4(); insertContact(CB1, ORG_B, CH_B, "Contato B", "lojax"); // mesmo handle que ORG_A, mas outra org
  const KB1 = uuidv4(); insertCompetitor(KB1, ORG_B, "instagram", "lojax"); // mesmo handle, outra org

  const rB = BSP.enrichContactsWithCompetitor(ORG_B);
  check("9.1 ORG_B: matched=1 (isolado do ORG_A)", rB.matched === 1);
  check("9.2 ORG_B: contacts_checked=1", rB.contacts_checked === 1);
  check("9.3 ORG_B: competitors_active=1", rB.competitors_active === 1);

  // ORG_A ainda tem 3, não misturou
  const listA = BSP.listContactCompetitorMatches(ORG_A);
  const listB = BSP.listContactCompetitorMatches(ORG_B);
  check("9.4 ORG_A ainda tem 3 matches após batch de ORG_B", listA.length === 3);
  check("9.5 ORG_B tem 1 match isolado", listB.length === 1);
  check("9.6 match do ORG_B refere só rows do ORG_B",
    listB[0].contact_id === CB1 && listB[0].competitor_id === KB1);

  // isContactWatched cross-org: contactId do B NÃO aparece como watched em A
  check("9.7 isContactWatched cross-org bloqueado",
    BSP.isContactWatchedCompetitor(ORG_A, CB1) === false);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
