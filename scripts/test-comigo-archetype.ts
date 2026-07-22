/**
 * TEST — Comigo/Onboarding por arquétipo (ADR-120 / ADR-088 D1).
 *
 * Uso: npm run test:comigo-archetype
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-arch-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-arch-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoArchetypeService: A } = await import("../src/server/ComigoArchetypeService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  // ===== 1. recommend puro =====
  const foodtruck = A.recommend({ archetype: "foodtruck", service: "balcao", mobile: true });
  check("foodtruck: Mesa/QR ligada", foodtruck.mesaEnabled === true);
  check("foodtruck: ficha padrão fabricacao", foodtruck.defaultRecipeKind === "fabricacao");
  check("foodtruck: móvel", foodtruck.mobile === true);

  const marmita = A.recommend({ archetype: "marmita", service: "balcao" });
  check("marmita: Mesa/QR desligada (por encomenda)", marmita.mesaEnabled === false);
  check("marmita: ficha fabricacao", marmita.defaultRecipeKind === "fabricacao");

  const unhas = A.recommend({ archetype: "unhas", service: "agenda" });
  check("unha: modo agenda (hora marcada)", unhas.mode === "agenda");
  check("unha: ficha servico", unhas.defaultRecipeKind === "servico");
  check("unha: Mesa/QR desligada", unhas.mesaEnabled === false);

  // hora marcada força ficha serviço mesmo em arquétipo de comida
  const comidaAgenda = A.recommend({ archetype: "salgados", service: "agenda" });
  check("hora marcada → ficha servico (sobrepõe)", comidaAgenda.defaultRecipeKind === "servico" && comidaAgenda.mode === "agenda");

  const chaveiro = A.recommend({ archetype: "servico_tecnico", service: "balcao" });
  check("chaveiro: serviço mas chegou-e-comprou (balcao, sem Mesa)", chaveiro.mode === "balcao" && chaveiro.mesaEnabled === false && chaveiro.defaultRecipeKind === "servico");

  check("gera dicas em linguagem de gente", foodtruck.tips.length >= 1 && unhas.tips.length >= 1);

  // ===== 2. apply persiste + getConfig lê =====
  check("antes do onboarding: não configurado", A.getConfig(orgId).configured === false);
  A.apply(orgId, { archetype: "foodtruck", service: "balcao", mobile: true }, "u1");
  const cfg = A.getConfig(orgId) as any;
  check("após apply: configurado", cfg.configured === true);
  check("config guarda o arquétipo", cfg.archetype === "foodtruck");
  check("config: Mesa/QR ligada", cfg.mesaEnabled === true);
  check("config: móvel", cfg.mobile === true);

  // ===== 3. Reconfigurar sobrescreve =====
  A.apply(orgId, { archetype: "marmita", service: "balcao", mobile: false }, "u1");
  const cfg2 = A.getConfig(orgId) as any;
  check("reconfigurar troca o arquétipo", cfg2.archetype === "marmita");
  check("reconfigurar desliga a Mesa", cfg2.mesaEnabled === false);

  // ===== 4. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org não configurada", A.getConfig(other).configured === false);

  // ===== 5. Perguntas expostas pra UI =====
  const qs = A.questions();
  check("3 perguntas expostas", qs.length === 3 && qs[0].key === "archetype");

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Onboarding por arquétipo (ADR-120) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Onboarding por arquétipo OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
