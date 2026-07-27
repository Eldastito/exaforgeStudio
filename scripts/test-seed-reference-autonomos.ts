/**
 * TEST — Seeder das contas de referência (peixaria + chaveiro).
 *
 * Prova, em DB temporário, que o seeder provisiona as duas contas corretamente
 * e é idempotente:
 *   - orgs com plano `autonomo`, ativas, onboarding concluído;
 *   - dono (role owner) por e-mail;
 *   - arquétipo Comigo aplicado (peixaria revenda / chaveiro servico_tecnico móvel);
 *   - módulos = vertical ∩ plano + `copiloto` (Balcão) ligado;
 *   - peixaria: produtos POR KG (sale_mode='weight' + porções); chaveiro: serviços;
 *   - re-rodar não duplica (idempotente);
 *   - o Balcão fecha uma venda por peso com o produto semeado.
 *
 * Uso: npm run test:seed-reference-autonomos
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seed-ref-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seed-ref-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { seedReferenceAutonomos } = await import("./seed-reference-autonomos.js");
  const { BalcaoService } = await import("../src/server/BalcaoService.js");

  const summary = await seedReferenceAutonomos("SenhaTeste@1");
  const PEIXARIA = "org_ref_peixaria", CHAVEIRO = "org_ref_chaveiro";
  const settings = (org: string) => db.prepare("SELECT * FROM organization_settings WHERE organization_id = ?").get(org) as any;
  const modulesOf = (org: string) => { try { return JSON.parse(settings(org)?.enabled_modules || "[]"); } catch { return []; } };
  const products = (org: string) => db.prepare("SELECT * FROM products_services WHERE organization_id = ? ORDER BY name").all(org) as any[];

  // ===== 1. Orgs base =====
  check("seeder reporta 2 contas criadas", summary.length === 2 && summary.every((s) => s.created), JSON.stringify(summary.map((s) => s.created)));
  check("peixaria: ativa, onboarding concluído, plano autonomo", settings(PEIXARIA)?.status === "active" && settings(PEIXARIA)?.onboarding_status === "completed" && settings(PEIXARIA)?.plan_id === "autonomo", JSON.stringify(settings(PEIXARIA)));
  check("chaveiro: ativa, plano autonomo", settings(CHAVEIRO)?.status === "active" && settings(CHAVEIRO)?.plan_id === "autonomo");

  // ===== 2. Donos =====
  const peixOwner = db.prepare("SELECT role, password_hash FROM users WHERE organization_id = ? AND email = 'peixaria@demo.zappflow.app'").get(PEIXARIA) as any;
  check("peixaria: dono (owner) criado com senha", peixOwner?.role === "owner" && !!peixOwner?.password_hash);
  const chavOwner = db.prepare("SELECT role FROM users WHERE organization_id = ? AND email = 'chaveiro@demo.zappflow.app'").get(CHAVEIRO) as any;
  check("chaveiro: dono (owner) criado", chavOwner?.role === "owner");

  // ===== 3. Arquétipo Comigo =====
  check("peixaria: arquétipo revenda (balcão)", settings(PEIXARIA)?.comigo_archetype === "revenda" && settings(PEIXARIA)?.comigo_mode === "balcao");
  check("chaveiro: arquétipo servico_tecnico, móvel", settings(CHAVEIRO)?.comigo_archetype === "servico_tecnico" && settings(CHAVEIRO)?.comigo_mobile === 1);
  check("chaveiro: valor/hora definido (60)", near(Number(settings(CHAVEIRO)?.comigo_hour_value), 60));

  // ===== 4. Módulos: vertical ∩ plano + copiloto (Balcão) =====
  const mP = modulesOf(PEIXARIA), mC = modulesOf(CHAVEIRO);
  check("peixaria: Balcão (copiloto) ligado + vendas/catalogo", mP.includes("copiloto") && mP.includes("vendas") && mP.includes("catalogo"), JSON.stringify(mP));
  check("chaveiro: Balcão (copiloto) + agenda ligados", mC.includes("copiloto") && mC.includes("agenda"), JSON.stringify(mC));

  // ===== 4b. Quick-Start aplicado: personas/cadências semeadas =====
  // copiloto sobrevive ao applyPack (que roda applyVertical por dentro) porque
  // é ligado DEPOIS — este é o ponto crítico da ordem no seeder.
  const areasOf = (org: string) => db.prepare("SELECT COUNT(*) c FROM service_areas WHERE organization_id = ?").get(org) as any;
  check("peixaria: Quick-Start marcado (quickstart_applied)", settings(PEIXARIA)?.quickstart_applied === 1);
  check("peixaria: personas do varejo semeadas (Vendas + Suporte = 2)", areasOf(PEIXARIA).c === 2, String(areasOf(PEIXARIA).c));
  check("chaveiro: personas de serviço semeadas (4)", areasOf(CHAVEIRO).c === 4, String(areasOf(CHAVEIRO).c));
  check("chaveiro: área Orçamentos existe", !!db.prepare("SELECT 1 FROM service_areas WHERE organization_id = ? AND lower(name)='orçamentos'").get(CHAVEIRO));
  check("summary expõe contagem de personas", summary.find((s) => s.orgId === CHAVEIRO)?.personas === 4, JSON.stringify(summary.map((s) => s.personas)));

  // ===== 5. Catálogo =====
  const pProds = products(PEIXARIA);
  const tilapia = pProds.find((p) => p.name.startsWith("Tilápia"));
  check("peixaria: 6 itens no catálogo", pProds.length === 6, String(pProds.length));
  check("peixaria: Tilápia vendida por KG (sale_mode=weight + porções)", tilapia?.sale_mode === "weight" && !!tilapia?.sale_options_json && near(Number(tilapia?.price), 39.9), JSON.stringify(tilapia && { sm: tilapia.sale_mode, so: tilapia.sale_options_json, price: tilapia.price }));
  check("peixaria: item comum (lata) fica por unidade", pProds.find((p) => p.name.startsWith("Sardinha"))?.sale_mode === "unit");
  const cProds = products(CHAVEIRO);
  check("chaveiro: 5 serviços no catálogo", cProds.length === 5 && cProds.every((p) => p.type === "service"), JSON.stringify(cProds.map((p) => p.type)));

  // ===== 6. Idempotência =====
  const again = await seedReferenceAutonomos("SenhaTeste@1");
  check("re-rodar não recria (created=false)", again.every((s) => !s.created), JSON.stringify(again.map((s) => s.created)));
  check("re-rodar não duplica produtos (peixaria segue 6)", products(PEIXARIA).length === 6, String(products(PEIXARIA).length));
  check("re-rodar não duplica dono (peixaria segue 1)", (db.prepare("SELECT COUNT(*) c FROM users WHERE organization_id = ?").get(PEIXARIA) as any).c === 1);
  check("re-rodar não duplica personas (chaveiro segue 4)", areasOf(CHAVEIRO).c === 4, String(areasOf(CHAVEIRO).c));
  check("re-rodar preserva o Balcão (copiloto segue ligado)", modulesOf(CHAVEIRO).includes("copiloto"), JSON.stringify(modulesOf(CHAVEIRO)));

  // ===== 7. Balcão fecha uma venda por peso do produto semeado =====
  const o = BalcaoService.openOrder(PEIXARIA, { sessionAlias: "Balcão" });
  BalcaoService.addItem(PEIXARIA, o, { productId: tilapia.id, name: tilapia.name, qty: 1.35, unitPrice: tilapia.price });
  const ord = db.prepare("SELECT total FROM comigo_orders WHERE id = ?").get(o) as any;
  check("Balcão: 1,35 kg × 39,90 = 53,87", near(Number(ord.total), 53.87), String(ord.total));

  console.log("\n=== Seeder contas de referência (peixaria + chaveiro) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
