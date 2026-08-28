/**
 * TEST — StudioVisualRecipeService.usageStats (ADR-194 F4).
 * DB-backed, determinístico. Prova:
 *   1. Sem uso → total_uses=0, by_recipe=[], by_vertical=[];
 *   2. Extrai recipe_key do prompt marcado `[KEY@vN] ...` gravado pela F2;
 *   3. Ignora rows kind != 'image' e prompts sem marca;
 *   4. Contagem correta por recipe, tie-break por last_used desc;
 *   5. Filtro por orgId funciona (scope=org vs global);
 *   6. Rollup by_vertical soma em cada vertical hint da receita;
 *   7. total_uses = soma dos uses;
 *   8. Recipe removida do catálogo → name=null, vertical_hints=[];
 *   9. since filtra por created_at.
 *
 * Uso: npm run test:studio-visual-recipes-analytics
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vre-analytics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vre-analytics-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { StudioVisualRecipeService: VRE } =
    await import("../src/server/StudioVisualRecipeService.js");

  // ═══════════════ 1. Estado inicial (sem uso) ═══════════════
  const empty = VRE.usageStats({});
  check("1.1 sem uso → total_uses=0", empty.total_uses === 0);
  check("1.2 sem uso → by_recipe=[]", Array.isArray(empty.by_recipe) && empty.by_recipe.length === 0);
  check("1.3 sem uso → by_vertical=[]", Array.isArray(empty.by_vertical) && empty.by_vertical.length === 0);
  check("1.4 sem uso, sem orgId → scope=global", empty.scope === "global");

  const orgEmpty = VRE.usageStats({ orgId: "ORG_A" });
  check("1.5 sem uso, com orgId → scope=org", orgEmpty.scope === "org");
  check("1.6 sem uso, com orgId → total_uses=0", orgEmpty.total_uses === 0);

  // Seed do catálogo — precisamos das receitas ativas pra rollup by_vertical.
  VRE.seedInitialRecipes();

  // ═══════════════ 2. Inserir usos direto na studio_creations ═══════════════
  // Usar SQL direto pra controlar exatamente prompt, kind, org e timestamp.
  const insert = db.prepare(
    "INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );

  // ORG_A: 3× PRODUCT_EXPLOSION, 1× BILLBOARD_3D
  insert.run("c-a-1", "ORG_A", "image", "[PRODUCT_EXPLOSION@v1] tênis azul", "/m/a1.png", "2026-08-01 10:00:00");
  insert.run("c-a-2", "ORG_A", "image", "[PRODUCT_EXPLOSION@v1] mochila preta", "/m/a2.png", "2026-08-05 11:00:00");
  insert.run("c-a-3", "ORG_A", "image", "[PRODUCT_EXPLOSION@v1] boné", "/m/a3.png", "2026-08-10 12:00:00");
  insert.run("c-a-4", "ORG_A", "image", "[BILLBOARD_3D@v1] outdoor", "/m/a4.png", "2026-08-12 13:00:00");

  // ORG_B: 2× BILLBOARD_3D (mesmo dia, ordem estável)
  insert.run("c-b-1", "ORG_B", "image", "[BILLBOARD_3D@v1] cidade", "/m/b1.png", "2026-08-15 14:00:00");
  insert.run("c-b-2", "ORG_B", "image", "[BILLBOARD_3D@v1] noite", "/m/b2.png", "2026-08-15 15:00:00");

  // Ruído: sem marca, ou kind não image → devem ser ignorados
  insert.run("c-noise-1", "ORG_A", "image", "prompt livre sem marca", "/m/n1.png", "2026-08-10 10:00:00");
  insert.run("c-noise-2", "ORG_A", "video", "[PRODUCT_EXPLOSION@v1] deveria ser ignorado (kind=video)", "/m/n2.mp4", "2026-08-11 10:00:00");
  insert.run("c-noise-3", "ORG_A", "image", "[SEM_AT_SEM_VN] prompt malformado", "/m/n3.png", "2026-08-11 11:00:00");

  // Receita desconhecida no catálogo — vai aparecer com name=null
  insert.run("c-a-x1", "ORG_A", "image", "[GHOST_KEY@v1] receita não catalogada", "/m/gx.png", "2026-08-20 10:00:00");

  // ═══════════════ 3. Global (todas as orgs) ═══════════════
  const global = VRE.usageStats({});
  check("3.1 global scope=global", global.scope === "global");
  const total = 3 + 1 + 2 + 1;                          // PRODUCT_EXPLOSION(3) + BILLBOARD_3D(1+2) + GHOST(1)
  check("3.2 total_uses global (7)", global.total_uses === total);

  const gMap = new Map(global.by_recipe.map(r => [r.recipe_key, r]));
  check("3.3 PRODUCT_EXPLOSION uses=3 global", gMap.get("PRODUCT_EXPLOSION")?.uses === 3);
  check("3.4 BILLBOARD_3D uses=3 global (1 A + 2 B)", gMap.get("BILLBOARD_3D")?.uses === 3);
  check("3.5 GHOST_KEY uses=1 global", gMap.get("GHOST_KEY")?.uses === 1);
  check("3.6 GHOST_KEY name=null (não catalogada)", gMap.get("GHOST_KEY")?.name === null);
  check("3.7 GHOST_KEY vertical_hints=[]", (gMap.get("GHOST_KEY")?.vertical_hints || []).length === 0);
  check("3.8 PRODUCT_EXPLOSION name preenchido (catalogada)",
    !!gMap.get("PRODUCT_EXPLOSION")?.name && gMap.get("PRODUCT_EXPLOSION")?.name === "Product Explosion");
  check("3.9 by_recipe ordenado por uses desc, tie por last_used desc",
    global.by_recipe[0].uses >= global.by_recipe[1].uses &&
    global.by_recipe[1].uses >= global.by_recipe[2].uses);
  // Tie-break: PRODUCT_EXPLOSION e BILLBOARD_3D ambos com 3 uses.
  // BILLBOARD_3D última = 2026-08-15 15:00; PRODUCT_EXPLOSION última = 2026-08-10 12:00.
  // BILLBOARD_3D deve vir antes.
  check("3.10 tie-break: BILLBOARD_3D (last_used mais recente) antes de PRODUCT_EXPLOSION",
    global.by_recipe[0].recipe_key === "BILLBOARD_3D" &&
    global.by_recipe[1].recipe_key === "PRODUCT_EXPLOSION");

  // ═══════════════ 4. Ruído ignorado ═══════════════
  check("4.1 prompt sem [KEY@v] ignorado (não aparece em by_recipe)",
    !global.by_recipe.some(r => r.recipe_key.includes(" ") || r.recipe_key === ""));
  check("4.2 kind=video ignorado (PRODUCT_EXPLOSION uses=3, não 4)",
    gMap.get("PRODUCT_EXPLOSION")?.uses === 3);

  // ═══════════════ 5. Filtro por orgId ═══════════════
  const orgA = VRE.usageStats({ orgId: "ORG_A" });
  check("5.1 ORG_A scope=org", orgA.scope === "org");
  check("5.2 ORG_A total_uses=5 (3 PE + 1 BB + 1 GHOST)", orgA.total_uses === 5);
  const aMap = new Map(orgA.by_recipe.map(r => [r.recipe_key, r]));
  check("5.3 ORG_A PRODUCT_EXPLOSION uses=3", aMap.get("PRODUCT_EXPLOSION")?.uses === 3);
  check("5.4 ORG_A BILLBOARD_3D uses=1 (só o da A)", aMap.get("BILLBOARD_3D")?.uses === 1);

  const orgB = VRE.usageStats({ orgId: "ORG_B" });
  check("5.5 ORG_B total_uses=2 (só BB)", orgB.total_uses === 2);
  const bMap = new Map(orgB.by_recipe.map(r => [r.recipe_key, r]));
  check("5.6 ORG_B BILLBOARD_3D uses=2", bMap.get("BILLBOARD_3D")?.uses === 2);
  check("5.7 ORG_B não vê PRODUCT_EXPLOSION", !bMap.has("PRODUCT_EXPLOSION"));

  const orgC = VRE.usageStats({ orgId: "ORG_C_INEXISTENTE" });
  check("5.8 org inexistente → by_recipe=[]", orgC.by_recipe.length === 0);
  check("5.9 org inexistente → total_uses=0", orgC.total_uses === 0);

  // ═══════════════ 6. by_vertical rollup ═══════════════
  // PRODUCT_EXPLOSION → verticals: ["retail", "storefront"]  → 3 uses each
  // BILLBOARD_3D      → verticals: ["retail", "beauty", "fashion"] → 3 uses each
  // GHOST_KEY não tem verticais (não catalogada)
  const vMap = new Map(global.by_vertical.map(v => [v.vertical, v.uses]));
  check("6.1 by_vertical inclui retail (3 PE + 3 BB = 6)", vMap.get("retail") === 6);
  check("6.2 by_vertical inclui storefront (3 PE)", vMap.get("storefront") === 3);
  check("6.3 by_vertical inclui beauty (3 BB)", vMap.get("beauty") === 3);
  check("6.4 by_vertical inclui fashion (3 BB)", vMap.get("fashion") === 3);
  check("6.5 by_vertical ordenado por uses desc (retail primeiro)",
    global.by_vertical[0].vertical === "retail");
  check("6.6 by_vertical ordenado por uses desc, tie por vertical asc",
    global.by_vertical.every((v, i, arr) => i === 0 || arr[i - 1].uses > v.uses || (arr[i - 1].uses === v.uses && arr[i - 1].vertical <= v.vertical)));

  // ═══════════════ 7. Filtro since ═══════════════
  const sinceMid = VRE.usageStats({ since: "2026-08-13 00:00:00" });
  const sMap = new Map(sinceMid.by_recipe.map(r => [r.recipe_key, r]));
  // Após 08-13: BILLBOARD_3D (b1, b2 em 08-15) + GHOST_KEY (08-20) = 3
  check("7.1 since 08-13 → total_uses=3", sinceMid.total_uses === 3);
  check("7.2 since 08-13 filtra PRODUCT_EXPLOSION (todos ≤ 08-10)", !sMap.has("PRODUCT_EXPLOSION"));
  check("7.3 since 08-13 mantém BILLBOARD_3D (b1/b2 em 08-15)", sMap.get("BILLBOARD_3D")?.uses === 2);
  check("7.4 since 08-13 mantém GHOST_KEY (08-20)", sMap.get("GHOST_KEY")?.uses === 1);

  const sinceFuture = VRE.usageStats({ since: "2027-01-01 00:00:00" });
  check("7.5 since no futuro → total_uses=0", sinceFuture.total_uses === 0);
  check("7.6 since no futuro → by_recipe=[]", sinceFuture.by_recipe.length === 0);

  // ═══════════════ 8. last_used correto ═══════════════
  check("8.1 PRODUCT_EXPLOSION last_used = 2026-08-10 12:00:00",
    gMap.get("PRODUCT_EXPLOSION")?.last_used === "2026-08-10 12:00:00");
  check("8.2 BILLBOARD_3D last_used = 2026-08-15 15:00:00 (max global)",
    gMap.get("BILLBOARD_3D")?.last_used === "2026-08-15 15:00:00");
  check("8.3 ORG_A BILLBOARD_3D last_used = 2026-08-12 13:00:00 (só o da A)",
    aMap.get("BILLBOARD_3D")?.last_used === "2026-08-12 13:00:00");

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
