/**
 * TEST — Vertical Petshop / Veterinário (Fase 1: definição + preset). DB-backed, det.
 * Prova que o petshop é uma vertical de 1ª classe que COMPÕE os módulos existentes
 * (varejo + clínica + serviços), sem motor novo:
 *   - getVertical("petshop") existe (label/icon/descrição/saleMode);
 *   - todo módulo do preset é VÁLIDO (não é descartado no sanitize);
 *   - ModuleService.catalog() inclui petshop (aparece no onboarding);
 *   - applyVertical (sem teto de plano) liga o preset completo — inclusive a
 *     `clinica` (parte veterinária) e o `catalogo`/`vendas` (produtos);
 *   - consentimento LGPD pré-populado (dados_pessoais + comunicações, SEM
 *     dados_sensiveis — a ficha é do animal, não da pessoa);
 *   - re-aplicar a vertical é idempotente e preserva add-on já ligado (grandfather).
 *
 * Uso: npm run test:petshop-vertical
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-petshop-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-petshop-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { getVertical, VERTICALS, OPTIONAL_MODULES, CONSENT_BY_VERTICAL } = await import("../src/server/verticals.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");

  // ═══════════════ 1. definição da vertical ═══════════════
  const v = getVertical("petshop");
  check("1.1 vertical petshop existe", !!v && v!.key === "petshop");
  check("1.2 label + ícone", !!v && v!.label === "Petshop / Veterinário" && v!.icon === "🐾");
  check("1.3 preset compõe produtos + clínica + serviços", !!v && v!.modules.includes("clinica") && v!.modules.includes("catalogo") && v!.modules.includes("agenda") && v!.modules.includes("compras"));
  check("1.4 aparece no catálogo (onboarding)", VERTICALS.some((x) => x.key === "petshop") && ModuleService.catalog().some((x: any) => x.key === "petshop"));

  // ═══════════════ 2. preset todo VÁLIDO (nada descartado no sanitize) ═══════════════
  const opt = new Set(OPTIONAL_MODULES as readonly string[]);
  check("2.1 todos os módulos do preset são conhecidos", v!.modules.every((m) => opt.has(m)));

  // ═══════════════ 3. applyVertical sem teto → preset completo ═══════════════
  const A = `org_${randomUUID().slice(0, 8)}`;
  // Sem plan_id (NULL) → sem teto → liga o preset inteiro.
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Petshop Amigo Fiel', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "petshop");
  const row = db.prepare(`SELECT vertical, enabled_modules FROM organization_settings WHERE organization_id = ?`).get(A) as any;
  check("3.1 vertical gravada = petshop", row.vertical === "petshop");
  const enabled: string[] = JSON.parse(row.enabled_modules || "[]");
  check("3.2 clínica (veterinário/cirurgia/internação) ligada", enabled.includes("clinica"));
  check("3.3 produtos (catálogo+vendas+pagamentos) ligados", ["catalogo", "vendas", "pagamentos"].every((m) => enabled.includes(m)));
  check("3.4 estoque/serviços (compras+agenda+areas) ligados", ["compras", "agenda", "areas"].every((m) => enabled.includes(m)));

  // ═══════════════ 4. consentimento LGPD ═══════════════
  check("4.1 consent pré-populado (dados_pessoais + comunicacoes)", CONSENT_BY_VERTICAL.petshop.includes("dados_pessoais") && CONSENT_BY_VERTICAL.petshop.includes("comunicacoes"));
  check("4.2 SEM dados_sensiveis (ficha é do animal, não da pessoa — LGPD Art.11)", !CONSENT_BY_VERTICAL.petshop.includes("dados_sensiveis"));

  // ═══════════════ 5. idempotência + grandfather de add-on ═══════════════
  // Liga um add-on que NÃO está no preset (retail_floor) e re-aplica: deve preservar.
  ModuleService.setModules(A, [...enabled, "retail_floor"]);
  ModuleService.applyVertical(A, "petshop");
  const enabled2: string[] = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(A) as any).enabled_modules || "[]");
  check("5.1 re-aplicar preserva add-on já ligado (grandfather)", enabled2.includes("retail_floor") && enabled2.includes("clinica"));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} petshop-vertical: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
