/**
 * TESTE — Fase 2 / F2.2 (ADR-203): navegação simplificada atrás da flag `simplified_navigation_enabled`.
 * Prova: (1) flag OFF por padrão e reversível, só owner/admin liga (setter + meta de /entitlements/me);
 * (2) isolamento por org; (3) PARIDADE com o Sidebar legado — toda tela do menu atual existe no catálogo com o MESMO
 * gate (nada some, RN-F2-1; RBAC/plano preservados, RN-F2-3); (4) 1º nível = Hoje·FalaTu·Executando·Resultados·Empresa,
 * cada destino só aparece se visível sob o gate legado; Empresa só gestor; (5) Explorar agrupa e busca sem acento;
 * (6) item sem permissão NUNCA vira cadeado (some). Sem LLM, sem rede.
 * Uso:  npm run test:simplified-navigation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f22-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-simplified-nav-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { NavigationManifestService: N } = await import("../src/server/NavigationManifestService.js");
  const C = await import("../src/lib/navCatalog.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); return id; };
  const A = mkOrg(), B = mkOrg();

  // ── (1)(2) flag ──
  check("default OFF (0-regressão: menu legado)", N.isSimplified(A) === false);
  check("setSimplified liga", N.setSimplified(A, true).enabled === true && N.isSimplified(A) === true);
  check("isolamento: outra org segue OFF", N.isSimplified(B) === false);
  check("manifesto reflete a flag", N.forUser(A, { role: "owner" }).simplifiedNavEnabled === true && N.forUser(B, { role: "owner" }).simplifiedNavEnabled === false);
  check("reversível: desliga", N.setSimplified(A, false).enabled === false);

  const entSrc = fs.readFileSync("src/server/routes/entitlements.ts", "utf8");
  check("/me expõe simplifiedNavEnabled", /simplifiedNavEnabled:\s*NavigationManifestService\.isSimplified/.test(entSrc));
  check("PUT /simplified-navigation exige owner/admin", /router\.put\("\/simplified-navigation",\s*requireRole\("owner",\s*"admin"\)/.test(entSrc));

  // ── (3) paridade com o Sidebar legado ──
  const side = fs.readFileSync("src/features/Sidebar.tsx", "utf8");
  const legacy = side.split("\n").map(l => {
    const m = l.match(/setViewMode\('([a-z_0-9]+)'\)/); if (!m || !/<NavItem/.test(l)) return null;
    return { vm: m[1], mods: [...l.matchAll(/mod\('([a-z_]+)'\)/g)].map(x => x[1]), access: [...l.matchAll(/canAccessModule\('([a-z_]+)'\)/g)].map(x => x[1]) };
  }).filter(Boolean) as Array<{ vm: string; mods: string[]; access: string[] }>;
  const cat = new Map(C.NAV_CATALOG.map(e => [e.viewMode, e]));
  const missing = [...new Set(legacy.map(l => l.vm))].filter(vm => !cat.has(vm));
  check(`toda tela do Sidebar legado existe no catálogo (${legacy.length} entradas)`, missing.length === 0, missing.join(","));
  const base: any = { isModuleEnabled: () => false, canAccessModule: () => true, isMasterAdmin: false, isManager: false, falatuEnabled: false, missionLayerEnabled: false, vertical: null, groupAvailable: false, coachAvailable: false };
  const modKeys = [...new Set(legacy.flatMap(l => l.mods))];
  const gateBad: string[] = [];
  for (const k of modKeys) {
    const ctx = { ...base, isModuleEnabled: (x: string) => x === k };
    for (const l of legacy) {
      const e = cat.get(l.vm); if (!e) continue;
      const wantsMod = l.mods.includes(k) && l.vm !== "beauty";
      if (wantsMod && !e.visible(ctx)) gateBad.push(`${l.vm}@${k}`);
    }
  }
  check("gate de MÓDULO idêntico ao legado (cada mod('x') libera exatamente a tela)", gateBad.length === 0, gateBad.join(","));
  const ungatedShown = legacy.filter(l => l.mods.length > 0 && l.vm !== "beauty" && cat.get(l.vm)?.visible(base));
  check("tela com mod() some quando o módulo está desligado (nunca cadeado)", ungatedShown.length === 0, ungatedShown.map(l => l.vm).join(","));
  const accBad = legacy.filter(l => l.access.length && cat.get(l.vm)?.visible({ ...base, canAccessModule: () => false }));
  check("tela com canAccessModule() some sem permissão (RBAC preservado)", accBad.length === 0, accBad.map(l => l.vm).join(","));
  check("só-master some para não-master", ["admin", "product_evolution", "ai_usage", "niche_intel", "production_readiness", "radar_consultant"].every(v => !cat.get(v)!.visible(base) && cat.get(v)!.visible({ ...base, isMasterAdmin: true })));
  check("Beauty AI exige vertical beleza + estúdio", !cat.get("beauty")!.visible({ ...base, isModuleEnabled: () => true }) && cat.get("beauty")!.visible({ ...base, isModuleEnabled: () => true, vertical: "beleza" }));

  // ── (4) 1º nível ──
  const keys = (c: any) => C.primaryNav(c).map(p => p.key).join(",");
  check("vendedor sem módulos: Hoje·Resultados (sem Empresa/FalaTu/Executando)", keys(base) === "hoje,resultados", keys(base));
  const owner = { ...base, isManager: true, falatuEnabled: true, isModuleEnabled: () => true };
  check("dono completo: Hoje·FalaTu·Executando·Resultados·Empresa", keys(owner) === "hoje,falatu,executando,resultados,empresa", keys(owner));
  check("Executando → Missões quando o Mission Layer está ligado", C.primaryNav({ ...owner, missionLayerEnabled: true }).find(p => p.key === "executando")!.viewMode === "missoes");
  check("Executando → Tarefas sem Missões", C.primaryNav(owner).find(p => p.key === "executando")!.viewMode === "tarefas");
  check("FalaTu some sem flag da org (mesmo gate do legado)", !keys({ ...owner, falatuEnabled: false }).includes("falatu"));
  check("Empresa só gestor", !keys({ ...owner, isManager: false }).includes("empresa") && keys({ ...base, isManager: true }).includes("empresa"));
  check("Hoje cai em Insights quando Central de Saúde é negada", C.primaryNav({ ...base, canAccessModule: () => false })[0].viewMode === "insights");

  // ── (5) Explorar ──
  const g = C.exploreGroups(owner);
  check("Explorar agrupa (≥4 grupos) e cobre toda tela visível", g.length >= 4 && g.flatMap(x => x.items).length === C.NAV_CATALOG.filter(e => e.visible(owner)).length);
  check("busca sem acento/caixa ('ATENDIMENTO' acha 'Atendimento')", C.exploreGroups(owner, "ATENDIMENTO").flatMap(x => x.items).some(e => e.viewMode === "kanban"));
  check("busca sem resultado → vazio", C.exploreGroups(owner, "zzzxxx").length === 0);

  // ── (6) UI: legado intacto com flag OFF ──
  check("Sidebar só troca o menu quando a flag está ON (legado preservado)", /simplifiedNavEnabled \? \(/.test(side) && /<nav className="space-y-1">\s*\n\s*\{canAccessModule\('saude_negocio'\)/.test(side));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
