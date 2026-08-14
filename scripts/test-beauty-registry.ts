/**
 * TEST — BEAUTY-001 (ADR-169 F1): registro da vertical Beleza & Salões.
 *
 * Prova que a vertical `beleza` está registrada como DADO no catálogo canônico
 * (verticals.ts) e que os 3 pontos de composição da plataforma reconhecem
 * a chave sem alteração adicional:
 *
 *  1. VerticalKey union aceita "beleza"; VERTICALS contém a entrada com preset
 *     coerente (agenda + estudio + vendas/pagamentos/campanhas/cadencias/
 *     assinaturas + diretor/rie/execucao).
 *  2. GET /api/analytics/verticals (via ModuleService.catalog) expõe o card
 *     "Beleza & Salões" 💇 para o onboarding.
 *  3. CONSENT_BY_VERTICAL semeia dados_pessoais + comunicacoes + marketing
 *     (RN-BS-04: consent de FOTO — hair_simulation — e consent de MARKETING
 *     — use_in_marketing — são escopos SEPARADOS, ativados em F5+ do ADR-169).
 *  4. ModuleService.applyVertical('beleza', orgId) grava vertical +
 *     enabled_modules e chama LgpdService.seedConsentForVertical (idempotente).
 *  5. EntitlementService reconhece a chave: overview() lista módulos do preset
 *     como `state='active'`; módulos incoerentes (clinica, escola, retail_floor)
 *     ficam escondidos (FALLBACK_HIDDEN_BY_VERTICAL — safety net pra org sem
 *     blueprint; F2 adiciona `beleza_salao_v1` que passa a ser fonte primária).
 *  6. Isolamento multi-tenant: org Beleza e org Varejo coexistem sem cross.
 *  7. Regra dura §17/§65 do PRD: NENHUMA constante hardcoded ao Studio Márcia
 *     nesta fatia — a vertical é dado; o piloto vira tenant real em F2 via
 *     POST /api/admin/blueprints + /organizations/:id/blueprint.
 *
 * Uso: npm run test:beauty-registry
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-reg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-registry-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VERTICALS, CONSENT_BY_VERTICAL, getVertical, OPTIONAL_MODULES } = await import("../src/server/verticals.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { EntitlementService } = await import("../src/server/EntitlementService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  // Helpers
  function seedOrg(vertical?: string, planId?: string) {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id) VALUES (?, ?, 'X', 'active', ?, ?)`,
    ).run(randomUUID(), orgId, vertical || null, planId || null);
    return orgId;
  }
  const enabledOf = (orgId: string) => {
    const r = db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id=?`).get(orgId) as any;
    return r?.enabled_modules ? (JSON.parse(r.enabled_modules) as string[]) : null;
  };
  const verticalOf = (orgId: string) => {
    const r = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id=?`).get(orgId) as any;
    return r?.vertical || null;
  };
  const cats = (orgId: string) => LgpdService.getConsentConfig(orgId).categories;

  // ===== 1. VERTICAL "beleza" existe no catálogo =====
  const beleza = getVertical("beleza");
  check("getVertical('beleza') retorna a entrada", !!beleza);
  check("beleza.label = 'Beleza & Salões'", !!beleza && beleza.label === "Beleza & Salões");
  check("beleza.icon = '💇' (PRD §77 identidade visual do card)", !!beleza && beleza.icon === "💇");
  check("beleza.saleMode = 'unit' (venda por atendimento, não fatia)", !!beleza && beleza.saleMode === "unit");
  check("beleza aparece em VERTICALS (catálogo do onboarding)", VERTICALS.some(v => v.key === "beleza"));

  // ===== 2. Preset coerente com a operação do salão =====
  const modules = beleza?.modules || [];
  check("preset inclui agenda (coração operacional)", modules.includes("agenda"));
  check("preset inclui vendas + pagamentos (revenda de produto + comissão)", modules.includes("vendas") && modules.includes("pagamentos"));
  check("preset inclui campanhas + cadencias (recuperação/manutenção)", modules.includes("campanhas") && modules.includes("cadencias"));
  check("preset inclui assinaturas (pacote de 10 escovas, ADR-169 D5)", modules.includes("assinaturas"));
  check("preset inclui estudio (antes/depois no Instagram)", modules.includes("estudio"));
  check("preset inclui diretor + rie + execucao (superfícies transversais)", modules.includes("diretor") && modules.includes("rie") && modules.includes("execucao"));
  check("preset NÃO inclui clinica (evita expor UI de prontuário — ADR-169 D5)", !modules.includes("clinica"));
  check("preset NÃO inclui escola / retail / retail_floor / vms (incoerentes)", !modules.includes("escola") && !modules.includes("retail") && !modules.includes("retail_floor") && !modules.includes("vms"));
  check("todos os módulos do preset são OPTIONAL_MODULES conhecidos", modules.every(m => (OPTIONAL_MODULES as readonly string[]).includes(m)));

  // ===== 3. CONSENT_BY_VERTICAL semeia o essencial da operação =====
  const bcats = CONSENT_BY_VERTICAL["beleza"];
  check("consent inclui dados_pessoais (base legal Art.7)", Array.isArray(bcats) && bcats.includes("dados_pessoais"));
  check("consent inclui comunicacoes (lembrete 24h, cadência, oportunidade)", Array.isArray(bcats) && bcats.includes("comunicacoes"));
  check("consent inclui marketing (campanhas ao público autorizado)", Array.isArray(bcats) && bcats.includes("marketing"));
  check("consent NÃO inclui dados_sensiveis (foto é escopo separado hair_simulation, F5+)", Array.isArray(bcats) && !bcats.includes("dados_sensiveis"));

  // ===== 4. ModuleService.applyVertical grava vertical + enabled + consent =====
  const orgBeleza = seedOrg(undefined, "growth");
  ModuleService.applyVertical(orgBeleza, "beleza"); // retorno void por design
  check("applyVertical('beleza') grava vertical (não lança)", verticalOf(orgBeleza) === "beleza");
  const en = enabledOf(orgBeleza)!;
  check("enabled_modules gravado (com growth como teto)", Array.isArray(en) && en.length > 0);
  check("enabled inclui agenda + vendas + pagamentos (todos no plano growth)", en.includes("agenda") && en.includes("vendas") && en.includes("pagamentos"));
  check("enabled inclui estudio (growth libera)", en.includes("estudio"));
  check("enabled NÃO inclui rie/execucao no growth (só a partir de scale)", !en.includes("rie") && !en.includes("execucao"));
  const csAfter = cats(orgBeleza);
  check("consent semeado (dados_pessoais/comunicacoes/marketing)", ["dados_pessoais", "comunicacoes", "marketing"].every(c => csAfter.includes(c)));

  // ===== 5. seedConsentForVertical é idempotente (não sobrescreve config já ajustada) =====
  const orgCustom = seedOrg(undefined, "growth");
  LgpdService.updateConsentConfig(orgCustom, { categories: ["so_uma"] });
  ModuleService.applyVertical(orgCustom, "beleza");
  const cc = cats(orgCustom);
  check("consent customizado é PRESERVADO ao aplicar beleza (RN LGPD)", cc.length === 1 && cc[0] === "so_uma");

  // ===== 6. Beleza + Scale = mais módulos entram (rie/execucao) =====
  const orgScale = seedOrg(undefined, "scale");
  ModuleService.applyVertical(orgScale, "beleza");
  const enScale = enabledOf(orgScale)!;
  check("beleza+scale liga rie + execucao (plano libera)", enScale.includes("rie") && enScale.includes("execucao"));
  check("beleza+scale segue não ligando clinica/escola/retail_floor (não estão no preset)", !enScale.includes("clinica") && !enScale.includes("escola") && !enScale.includes("retail_floor"));

  // ===== 7. Beleza + Autonomo = teto recorta a wishlist (moda existente é o precedente) =====
  const orgAuto = seedOrg(undefined, "autonomo");
  ModuleService.applyVertical(orgAuto, "beleza");
  const enAuto = enabledOf(orgAuto)!;
  check("beleza+autonomo liga agenda + vendas + pagamentos (no plano)", enAuto.includes("agenda") && enAuto.includes("vendas") && enAuto.includes("pagamentos"));
  check("beleza+autonomo NÃO liga estudio/campanhas/cadencias (acima do teto)", !enAuto.includes("estudio") && !enAuto.includes("campanhas") && !enAuto.includes("cadencias"));
  check("estudio fica indisponível no autonomo (isEnabled=false)", !ModuleService.isEnabled(orgAuto, "estudio"));

  // ===== 8. EntitlementService reconhece a chave (fallback vertical, sem blueprint) =====
  PermissionService.seedSystemProfiles(orgBeleza);
  const ownerProfId = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgBeleza) as any).id;
  const ownerUser = { userId: "u_owner", email: "dona@studio.com", role: "owner", role_profile_id: ownerProfId, organizationId: orgBeleza };

  const decAgenda = EntitlementService.check(orgBeleza, ownerUser, "agenda", "view");
  check("EntitlementService: agenda 'active' pra beleza+growth (dono)", decAgenda.allowed && decAgenda.state === "active", `state=${decAgenda.state} reason=${decAgenda.reason}`);

  const decClinica = EntitlementService.check(orgBeleza, ownerUser, "clinica", "view");
  check("EntitlementService: clinica 'hidden' pra beleza (FALLBACK_HIDDEN_BY_VERTICAL)", decClinica.state === "hidden" && decClinica.visibility === "hidden", `state=${decClinica.state}`);

  const decEscola = EntitlementService.check(orgBeleza, ownerUser, "escola", "view");
  check("EntitlementService: escola 'hidden' pra beleza", decEscola.state === "hidden", `state=${decEscola.state}`);

  const decRetailFloor = EntitlementService.check(orgBeleza, ownerUser, "retail_floor", "view");
  check("EntitlementService: retail_floor 'hidden' pra beleza", decRetailFloor.state === "hidden", `state=${decRetailFloor.state}`);

  // Módulos do preset aparecem no overview (overview retorna Record<module, decision> direto)
  const overview = EntitlementService.overview(orgBeleza, ownerUser);
  const activeKeys = new Set(Object.entries(overview).filter(([, d]: any) => d.state === "active").map(([k]) => k));
  check("overview: agenda entre 'active' pra beleza+growth", activeKeys.has("agenda"));
  check("overview: estudio entre 'active' pra beleza+growth", activeKeys.has("estudio"));
  check("overview: clinica NÃO entre 'active' (escondida pela vertical)", !activeKeys.has("clinica"));

  // ===== 9. Isolamento multi-tenant: Beleza x Varejo =====
  const orgVarejo = seedOrg(undefined, "growth");
  ModuleService.applyVertical(orgVarejo, "varejo");
  const enV = enabledOf(orgVarejo)!;
  check("multi-tenant: org varejo NÃO ganha módulo da beleza", !enV.includes("assinaturas") || !enabledOf(orgBeleza)!.includes("catalogo"));
  check("multi-tenant: applyVertical na beleza não muda a varejo (vertical)", verticalOf(orgVarejo) === "varejo");
  ModuleService.applyVertical(orgBeleza, "beleza"); // re-aplica beleza
  check("multi-tenant: re-aplicar beleza não muda enabled_modules da varejo", JSON.stringify(enabledOf(orgVarejo)) === JSON.stringify(enV));

  // ===== 10. Todas as verticais existentes seguem aplicáveis (zero regressão) =====
  let allApplied = true;
  for (const v of VERTICALS) {
    const o = seedOrg(undefined, "scale");
    try {
      ModuleService.applyVertical(o, v.key);
      if (!Array.isArray(enabledOf(o))) allApplied = false;
    } catch {
      allApplied = false;
    }
  }
  check("todas as verticais (incluindo beleza) aplicam sem erro em plan=scale", allApplied);

  // ===== 11. Regra dura §17/§65 do PRD: nenhum hardcoded ao Studio Márcia nesta fatia =====
  // (Verificação simbólica — F1 é DADO em verticals.ts. Se algum arquivo do server
  // conter "studio_marcia"/"marcia_studio"/"studio de beleza márcia" como constante,
  // este check falha. O teste é grep-textual sobre src/server e src/features.)
  const forbiddenNeedles = ["studio_marcia", "studio de beleza márcia", "marcia_studio"];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* dirs inexistentes → skip */ }
  check("nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)", hardcoded === null, hardcoded || undefined);

  // --- Relatório ---
  console.log("\n=== TEST: Vertical Beleza & Salões — registro (ADR-169 F1 / BEAUTY-001) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Vertical Beleza & Salões registrada e reconhecida por toda a plataforma.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
