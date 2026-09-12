/**
 * TEST — Sales Coach F6 (ADR-202): superfície (flag + RBAC + bundle). Prova o gate por
 * flag (RN-SC-7), o RBAC (RN-SC-9: gestor vê o time, vendedor só a si), a composição do
 * bundle (F1–F5), e o isolamento por org. Lógica testável do service (a rota é glue fino).
 *
 * Uso: npm run test:sales-coach-surface
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scsurf-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scsurf-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const ORG = "org-A", ASOF = "2026-09-12";

  // Flag ON no org-A; org-B sem settings (default off).
  db.prepare("INSERT INTO organization_settings (organization_id, sales_coach_enabled) VALUES (?, 1)").run(ORG);
  db.prepare("INSERT INTO organization_settings (organization_id, sales_coach_enabled) VALUES ('org-off', 0)").run();

  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active) VALUES (?, ?, ?, ?, ?, ?)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  seller.run("sA", ORG, "M1", "Ana", "uA", 1);
  seller.run("sB", ORG, "M2", "Bruno", "uB", 1);
  seller.run("sInativo", ORG, "M9", "Velho", null, 0);
  sale.run("v1", ORG, "2026-08-05", "Ana", "M1", 1000, 10); sale.run("v2", ORG, "2026-09-05", "Ana", "M1", 800, 8);

  // ── 1. flag ──
  check("1.1 org com flag=1 → habilitado", SalesCoachService.isEnabled(ORG) === true);
  check("1.2 org com flag=0 → desabilitado", SalesCoachService.isEnabled("org-off") === false);
  check("1.3 org sem settings → desabilitado (0-regressão)", SalesCoachService.isEnabled("org-sem") === false);
  // setOrgEnabled: porta de administração do rollout (reversível).
  SalesCoachService.setOrgEnabled("org-off", true);
  check("1.4 setOrgEnabled liga a flag", SalesCoachService.isEnabled("org-off") === true);
  SalesCoachService.setOrgEnabled("org-off", false);
  check("1.5 setOrgEnabled desliga a flag", SalesCoachService.isEnabled("org-off") === false);

  // ── 2. listSellers ──
  const list = SalesCoachService.listSellers(ORG);
  check("2.1 lista só vendedores ativos", list.length === 2 && !list.some((s: any) => s.id === "sInativo"));
  check("2.2 isolamento: outra org vazia", SalesCoachService.listSellers("org-B").length === 0);

  // ── 3. sellerForUser ──
  check("3.1 resolve vendedor pelo usuário", SalesCoachService.sellerForUser(ORG, "uA") === "sA");
  check("3.2 usuário sem vendedor → null", SalesCoachService.sellerForUser(ORG, "uX") === null);

  // ── 4. RBAC canView ──
  check("4.1 gestor (owner) vê qualquer vendedor do org", SalesCoachService.canView(ORG, { role: "owner" } as any, "sB") === true);
  check("4.2 gestor NÃO vê vendedor de outra org", SalesCoachService.canView(ORG, { role: "admin" } as any, "id-inexistente") === false);
  check("4.3 vendedor vê a SI mesmo", SalesCoachService.canView(ORG, { role: "agent", userId: "uA" } as any, "sA") === true);
  check("4.4 vendedor NÃO vê outro vendedor", SalesCoachService.canView(ORG, { role: "agent", userId: "uA" } as any, "sB") === false);
  check("4.5 sem usuário → sem acesso", SalesCoachService.canView(ORG, undefined, "sA") === false);

  // ── 5. bundle compõe F1–F5 ──
  const b = SalesCoachService.bundle(ORG, "sA", { asOf: ASOF });
  check("5.1 bundle tem snapshot/gaps/feedback/solutions/roleplay", !!b && !!b.snapshot && !!b.gaps && !!b.feedback && !!b.solutions && !!b.roleplay);
  check("5.2 bundle do vendedor certo (seller resolvido)", b.seller?.id === "sA");
  check("5.3 vendedor inexistente → bundle null", SalesCoachService.bundle(ORG, "nao-existe", { asOf: ASOF }) === null);

  // ── 6. isolamento no bundle ──
  check("6.1 vendedor de A não vaza para B", SalesCoachService.bundle("org-B", "sA", { asOf: ASOF }) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-surface: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
