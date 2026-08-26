/**
 * TEST — Vertical Advocacia (ADR-191 F1: definição + preset + consent). DB-backed, det.
 * Prova que advocacia é vertical de 1ª classe que COMPÕE módulos existentes (agenda +
 * áreas + assinaturas + pagamentos + cadências), sem motor novo:
 *   - getVertical("advocacia") existe (label/icon/descrição/saleMode);
 *   - todo módulo do preset é VÁLIDO (não descartado no sanitize);
 *   - ModuleService.catalog() inclui advocacia (aparece no onboarding);
 *   - NÃO liga varejo (catalogo/loja) nem o módulo `clinica` (prontuário não cabe);
 *   - applyVertical (sem teto) liga o preset completo;
 *   - consent LGPD pré-populado (dados_pessoais + comunicacoes + sigilo_profissional,
 *     SEM dados_sensiveis — sigilo não é Art.11);
 *   - re-aplicar é idempotente e preserva add-on já ligado (grandfather).
 *
 * Uso: npm run test:advocacia-vertical
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-adv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { getVertical, VERTICALS, OPTIONAL_MODULES, CONSENT_BY_VERTICAL } = await import("../src/server/verticals.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");

  // ═══ 1. definição ═══
  const v = getVertical("advocacia");
  check("1.1 vertical advocacia existe", !!v && v!.key === "advocacia");
  check("1.2 label + ícone", !!v && v!.label === "Advocacia / Jurídico" && v!.icon === "⚖️");
  check("1.3 preset de prestador de serviço jurídico (agenda+areas+assinaturas)", !!v && v!.modules.includes("agenda") && v!.modules.includes("areas") && v!.modules.includes("assinaturas") && v!.modules.includes("pagamentos"));
  check("1.4 NÃO é varejo (sem catalogo/loja) nem prontuário (sem clinica)", !!v && !v!.modules.includes("catalogo") && !v!.modules.includes("loja") && !v!.modules.includes("clinica"));
  check("1.5 herda as superfícies transversais (diretor/rie/execucao — CEO layer é horizontal)", !!v && ["diretor", "rie", "execucao"].every((m) => v!.modules.includes(m)));
  check("1.6 aparece no catálogo (onboarding)", VERTICALS.some((x) => x.key === "advocacia") && ModuleService.catalog().some((x: any) => x.key === "advocacia"));

  // ═══ 2. preset todo VÁLIDO ═══
  const opt = new Set(OPTIONAL_MODULES as readonly string[]);
  check("2.1 todos os módulos do preset são conhecidos", v!.modules.every((m) => opt.has(m)));

  // ═══ 3. applyVertical sem teto → preset completo ═══
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Advocacia Silva & Associados', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "advocacia");
  const row = db.prepare(`SELECT vertical, enabled_modules FROM organization_settings WHERE organization_id = ?`).get(A) as any;
  check("3.1 vertical gravada = advocacia", row.vertical === "advocacia");
  const enabled: string[] = JSON.parse(row.enabled_modules || "[]");
  check("3.2 agenda + áreas + assinaturas ligadas", ["agenda", "areas", "assinaturas"].every((m) => enabled.includes(m)));
  check("3.3 pagamentos + cadencias ligados", ["pagamentos", "cadencias"].every((m) => enabled.includes(m)));
  check("3.4 varejo/clinica NÃO ligados", !enabled.includes("catalogo") && !enabled.includes("loja") && !enabled.includes("clinica"));

  // ═══ 4. consent LGPD ═══
  check("4.1 consent pré-populado (dados_pessoais + comunicacoes + sigilo_profissional)", ["dados_pessoais", "comunicacoes", "sigilo_profissional"].every((c) => CONSENT_BY_VERTICAL.advocacia.includes(c)));
  check("4.2 SEM dados_sensiveis (sigilo não é Art.11 — base é exercício de direitos)", !CONSENT_BY_VERTICAL.advocacia.includes("dados_sensiveis"));

  // ═══ 5. idempotência + grandfather ═══
  // add-on (ADDON_MODULES) fora do preset: grandfather preserva ao re-aplicar.
  ModuleService.setModules(A, [...enabled, "retail_floor"]);
  ModuleService.applyVertical(A, "advocacia");
  const enabled2: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(A) as any).enabled_modules || "[]");
  check("5.1 re-aplicar preserva add-on já ligado (grandfather)", enabled2.includes("retail_floor") && enabled2.includes("agenda"));

  // ═══ 6. isolamento ═══
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), B);
  check("6.1 org B sem vertical não vaza módulos de A", (db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id=?`).get(B) as any).vertical == null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} advocacia-vertical: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
