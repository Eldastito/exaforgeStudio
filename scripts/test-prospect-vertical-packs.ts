/**
 * TEST — F4 (GAP-CLOSURE-03): vertical packs de ICP no Prospect. Prova os templates
 * curados (chaves alinhadas a VERTICALS, dor/oferta/segmento/sinais), a adoção via o
 * createIcp existente (ICP novo editável, não sobrescreve), a honestidade (vertical sem
 * pack → erro, nunca inventa), a INTEGRAÇÃO com o score (o segmento do pack dirige o
 * icpMatch do computeScore) e o isolamento multi-tenant.
 *
 * Uso: npm run test:prospect-vertical-packs
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vpack-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-vpack-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");
  const { listProspectVerticalPacks, getProspectVerticalPack } = await import("../src/server/prospectVerticalPacks.js");
  const { VERTICALS } = await import("../src/server/verticals.js");
  const validKeys = new Set(VERTICALS.map((v: any) => v.key));

  // ── 1. Packs curados: shape + chaves válidas ──
  const packs = ProspectService.listVerticalPacks();
  check("1.1 lista traz vários packs", packs.length >= 8);
  check("1.2 toda chave de pack ∈ VERTICALS (não inventa nicho)", packs.every((p: any) => validKeys.has(p.vertical)));
  check("1.3 cada pack tem dor/oferta/segmento/sinais", packs.every((p: any) => p.criteria.dor && p.criteria.oferta && p.criteria.segmento && Array.isArray(p.criteria.sinais) && p.criteria.sinais.length > 0));
  check("1.4 getProspectVerticalPack('saude') existe", !!getProspectVerticalPack("saude"));
  check("1.5 vertical sem pack → null (honesto)", getProspectVerticalPack("outro") === null && getProspectVerticalPack("naoexiste") === null);

  // ── 2. Adoção: cria ICP novo editável via createIcp ──
  const orgA = "org-A";
  const icp = ProspectService.adoptVerticalPack(orgA, "saude", "actor-1");
  check("2.1 adotar cria ICP com nome/vertical do pack", icp && icp.vertical === "saude" && !!icp.name);
  check("2.2 ICP carrega a criteria do pack (dor/oferta/segmento)", icp.criteria && icp.criteria.dor && icp.criteria.segmento.includes("clinica"));
  const fetched = ProspectService.getIcp(orgA, icp.id);
  check("2.3 ICP persistido e recuperável", !!fetched && fetched.id === icp.id && fetched.status === "active");
  // não sobrescreve: adotar de novo cria OUTRO ICP editável
  const icp2 = ProspectService.adoptVerticalPack(orgA, "saude", "actor-1");
  check("2.4 adotar de novo cria ICP distinto (não sobrescreve)", icp2.id !== icp.id && ProspectService.listIcps(orgA).length === 2);

  // ── 3. Honestidade: vertical sem pack → erro ──
  let threw = false; try { ProspectService.adoptVerticalPack(orgA, "outro", "actor-1"); } catch { threw = true; }
  check("3.1 adotar vertical sem pack lança (não inventa template)", threw);

  // ── 4. INTEGRAÇÃO com o score: o segmento do pack dirige o icpMatch ──
  const camp = ProspectService.createCampaign(orgA, { name: "Camp saúde", icpId: icp.id }, "actor-1");
  ProspectService.importRecords(orgA, { campaignId: camp.id, sourceRef: "match", records: [{ company: "Clínica Alfa", industry: "clinica", domain: "alfa.com" }] });
  ProspectService.importRecords(orgA, { campaignId: camp.id, sourceRef: "nomatch", records: [{ company: "Restaurante Beta", industry: "restaurante", domain: "beta.com" }] });
  const db = (await import("../src/server/db.js")).default;
  const match = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND display_name = 'Clínica Alfa'").get(orgA) as any;
  const nomatch = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND display_name = 'Restaurante Beta'").get(orgA) as any;
  const sMatch = ProspectService.computeScore(orgA, match.id);
  const sNo = ProspectService.computeScore(orgA, nomatch.id);
  check("4.1 conta do segmento do pack → icpMatch true", sMatch.explanation.icpMatch === true);
  check("4.2 conta fora do segmento → icpMatch false", sNo.explanation.icpMatch === false);
  check("4.3 encaixe (account_fit) maior na conta que casa o pack", sMatch.account_fit > sNo.account_fit);

  // ── 5. Isolamento multi-tenant ──
  const orgB = "org-B";
  check("5.1 ICP de A não vaza pra B", ProspectService.getIcp(orgB, icp.id) === null && ProspectService.listIcps(orgB).length === 0);
  check("5.2 listVerticalPacks é conteúdo global (igual pra qualquer org)", ProspectService.listVerticalPacks().length === packs.length);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} prospect-vertical-packs: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
