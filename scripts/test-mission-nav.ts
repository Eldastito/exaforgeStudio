/**
 * TEST — Mission nav (ADR-189 F8, Mission OS). DB-backed, determinístico.
 * Prova (§25/§83): com o Mission Layer LIGADO, "Executando" FUNDE em "Missões" no primary (net-zero
 * itens — não cresce a sidebar); DESLIGADO → "Executando" fica (0-regressão); missionsNav reflete;
 * nada some (é swap, não remoção); isolamento.
 *
 * Uso: npm run test:mission-nav
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mnav-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "test"; process.env.JWT_SECRET = "test-secret-mnav-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { NavigationManifestService: NAV } = await import("../src/server/NavigationManifestService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = (missionFlag: number) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, enabled_modules, billing_status, falatu_enabled, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 'varejo', 'autonomo', ?, 'active', 1, ?)`)
      .run(randomUUID(), o, JSON.stringify(["catalogo", "vendas"]), missionFlag);
    PermissionService.seedSystemProfiles(o);
    return o;
  };
  const owner = (org: string) => ({ userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id=? AND system_key='owner'`).get(org) as any).id, organizationId: org });
  const pKeys = (m: any) => m.primary.map((p: any) => p.key);

  // ON: Mission Layer ligado → "Missões" no lugar de "Executando".
  const A = mkOrg(1);
  const mA = NAV.forUser(A, owner(A));
  check("1.1 missionsNav true", mA.missionsNav === true);
  check("1.2 primary tem 'missoes' e NÃO 'executando' (§25 fusão)", pKeys(mA).includes("missoes") && !pKeys(mA).includes("executando"));

  // OFF: sem o Mission Layer → "Executando" fica (0-regressão).
  const B = mkOrg(0);
  const mB = NAV.forUser(B, owner(B));
  check("2.1 missionsNav false (flag off)", mB.missionsNav === false);
  check("2.2 primary tem 'executando' e NÃO 'missoes' (0-regressão)", pKeys(mB).includes("executando") && !pKeys(mB).includes("missoes"));

  // §83: net-zero — a contagem do primary é IGUAL com/sem a flag (não cresce a sidebar).
  check("3.1 net-zero itens no primary (swap, não adição)", mA.primary.length === mB.primary.length);

  // Nada some: Hoje/Resultados/Empresa seguem nos dois.
  check("3.2 Hoje/Resultados/Empresa presentes nos dois", ["hoje", "resultados", "empresa"].every((k) => pKeys(mA).includes(k) && pKeys(mB).includes(k)));

  // Isolamento: a flag de A não afeta B.
  check("4.1 isolamento (A=missoes, B=executando)", pKeys(mA).includes("missoes") && pKeys(mB).includes("executando"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-nav: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
