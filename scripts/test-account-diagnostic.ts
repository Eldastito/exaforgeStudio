/**
 * TEST — Diagnóstico de conta (go-live) — AccountDiagnosticService.
 *
 * Verifica o "está tudo certo?": detecta conta SEM recorte de módulos ("vê
 * tudo") vs restrita à vertical moda, aponta módulos da moda faltando, os
 * sinais operacionais (catálogo/loja/usuários) e as recomendações acionáveis.
 * Também confirma que master admin é distinto de owner.
 *
 * Uso: npm run test:account-diagnostic
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-acctdiag-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-acctdiag-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AccountDiagnosticService } = await import("../src/server/AccountDiagnosticService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  // enabled_modules NULL de propósito = "vê tudo" (legado).

  const owner = { email: "eldastito@toulon.com", role: "owner" };
  const master = { email: "master@zappflow.test", role: "owner" };

  // ===== conta SEM recorte: "vê tudo" =====
  const d0 = AccountDiagnosticService.report(orgId, owner);
  check("owner NÃO é master admin", d0.access.isMasterAdmin === false && d0.access.isOwner === true);
  check("owner enxerga só a própria org", d0.access.seesOnlyOwnOrg === true);
  check("detecta 'vê tudo' (modules.restricted=false)", d0.modules.restricted === false);
  check("recomenda aplicar a vertical moda", d0.recommendations.some((r: string) => /vertical moda/i.test(r)));
  check("goLive: sem catálogo/loja no começo", d0.goLive.catalogProducts === 0 && d0.goLive.storefrontPublished === false);

  // ===== master admin é distinto =====
  const dm = AccountDiagnosticService.report(orgId, master);
  check("master admin detectado", dm.access.isMasterAdmin === true && dm.access.seesOnlyOwnOrg === false);

  // ===== aplica a vertical moda → passa a ser restrita =====
  ModuleService.applyVertical(orgId, "moda");
  const d1 = AccountDiagnosticService.report(orgId, owner);
  check("após aplicar moda: restrito", d1.modules.restricted === true && d1.modules.vertical === "moda");
  check("moda: catalogo/loja/estudio ligados", ["catalogo", "loja", "estudio"].every((m) => d1.modules.modaEnabled.includes(m)));
  check("moda: sem módulos da moda faltando", d1.modules.modaMissing.length === 0);
  check("moda: nada de excesso fora da vertical", Array.isArray(d1.modules.extraBeyondModa) && d1.modules.extraBeyondModa.length === 0);
  check("não recomenda mais aplicar vertical", !d1.recommendations.some((r: string) => /Aplique a vertical moda/i.test(r)));

  // ===== sinais operacionais evoluem com o setup =====
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'toulon', 1, 1)`).run(orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, storefront_visible) VALUES (?, ?, 'product', 'Camisa', 100, 1, 1)`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp_cloud', 'WhatsApp', 'connected')`).run(randomUUID(), orgId);
  const d2 = AccountDiagnosticService.report(orgId, owner);
  check("goLive reflete WhatsApp conectado", d2.goLive.whatsappConnected === true && d2.goLive.channelsConnected === 1);
  check("goLive reflete catálogo publicado + loja no ar", d2.goLive.catalogProducts === 1 && d2.goLive.catalogPublished === 1 && d2.goLive.storefrontPublished === true);
  check("recomendações encolhem conforme o setup avança", d2.recommendations.length < d0.recommendations.length);

  // --- Relatório ---
  console.log("\n=== TEST: Diagnóstico de conta (go-live) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Diagnóstico de conta OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
