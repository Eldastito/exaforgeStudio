/**
 * TESTE — Diretório de vendedores + lotação por loja (PDR TOULON, Fatia 2 / SELL).
 * ------------------------------------------------------------------------------
 * Prova, offline (RetailSellerDirectoryService):
 *   - lotação vendedor×loja: setStores adiciona várias lojas SEM duplicar a
 *     identidade; principal marcada; remover desativa (nunca DELETE);
 *   - descoberta por filial: código com nome = confirmado; sem nome = pendência;
 *     filial com UM código e volume alto = suspeito de compartilhado;
 *   - cobertura agrega lotados + pendências + suspeitos;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-seller-directory
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-dir-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-seller-dir-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerDirectoryService: Dir } = await import("../src/server/RetailSellerDirectoryService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const avBrasil = randomUUID(), barra = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Avenida Brasil', 'AV', 1)`).run(avBrasil, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Barra', 'BR', 1)`).run(barra, A);

  // Vendedor canônico Ana (matrícula 1001) — mapeada.
  const ana = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '1001', 'Ana', 1)`).run(ana, A);

  // ===== 1. lotação vendedor×loja =====
  Dir.setStores(A, ana, [avBrasil, barra], barra, "boss");
  const anaStores = Dir.storesForSeller(A, ana);
  check("Ana lotada em 2 lojas (identidade única)", anaStores.length === 2);
  check("loja principal marcada (Barra)", anaStores.find((s: any) => s.store_id === barra)?.is_primary === 1);
  check("Barra vê Ana no roster", Dir.sellersForStore(A, barra).some((s: any) => s.seller_id === ana));

  // remover Barra desativa (nunca DELETE)
  Dir.setStores(A, ana, [avBrasil], avBrasil, "boss");
  check("remover loja desativa o vínculo", Dir.storesForSeller(A, ana).length === 1);
  const raw = db.prepare(`SELECT COUNT(*) AS n FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ?`).get(A, ana) as any;
  check("vínculo desativado permanece no banco (histórico)", Number(raw.n) === 2);

  // ===== 2. descoberta por filial =====
  const pdv = db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo, valor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // Avenida Brasil: código 1001 (Ana, mapeado) + 1002 (sem nome) → confirmado + pendência.
  pdv.run(randomUUID(), A, "AV", "1", "2026-08-01", "op", "1001", 100);
  pdv.run(randomUUID(), A, "AV", "2", "2026-08-01", "op", "1002", 100);
  const dAV = Dir.discoverByStore(A, avBrasil);
  check("descoberta AV: 1001 confirmado", dAV.confirmed.some((c: any) => c.codigo === "1001" && c.name === "Ana"));
  check("descoberta AV: 1002 pendência de nome", dAV.pendingName.some((c: any) => c.codigo === "1002" && c.name === null));
  check("descoberta AV: sem suspeito (2 códigos)", dAV.sharedCodeSuspects.length === 0);

  // Barra: UM único código com volume alto → suspeito de compartilhado.
  for (let i = 0; i < 160; i++) pdv.run(randomUUID(), A, "BR", String(i + 1), "2026-08-01", "cx", "9999", 50);
  const dBR = Dir.discoverByStore(A, barra);
  check("descoberta BR: código único + volume alto = suspeito compartilhado", dBR.sharedCodeSuspects.some((c: any) => c.codigo === "9999") && dBR.pendingName.length === 0 && dBR.confirmed.length === 0);

  // ===== 3. cobertura + flag de uso de lotação =====
  const cov = Dir.coverage(A, avBrasil);
  check("cobertura AV: lotados=1, pendências=1", cov.counts.lotados === 1 && cov.counts.pendingName === 1);
  check("orgUsesAssignments true quando há lotação", cov.orgUsesAssignments === true);
  check("org B (sem lotação) → orgUsesAssignments false", Dir.orgUsesAssignments(B) === false);

  // ===== 3.5. próxima matrícula no padrão da rede =====
  // AV: pool numérico {1001 (Ana), 1002} → próxima = 1003 (maior + 1, largura 4).
  check("nextMatricula AV = 1003 (maior do pool + 1)", Dir.nextMatricula(A, avBrasil) === "1003", Dir.nextMatricula(A, avBrasil));
  // Colisão: se 1003 já existir em retail_sellers, pula para 1004.
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '1003', 'Bia', 1)`).run(randomUUID(), A);
  check("nextMatricula pula matrícula já usada (→ 1004)", Dir.nextMatricula(A, avBrasil) === "1004", Dir.nextMatricula(A, avBrasil));
  // BR: pool {9999} → próxima = 10000 (preserva prefixo/ordem numérica).
  check("nextMatricula BR = 10000 (9999 + 1)", Dir.nextMatricula(A, barra) === "10000", Dir.nextMatricula(A, barra));
  // Loja NOVA, código numérico de filial, sem base numérica → filial + 0001.
  const nova = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Nova Iguaçu', '1065', 1)`).run(nova, A);
  check("nextMatricula loja nova = filial + 0001 (10650001)", Dir.nextMatricula(A, nova) === "10650001", Dir.nextMatricula(A, nova));
  let matIso = false;
  try { Dir.nextMatricula(B, avBrasil); } catch { matIso = true; }
  check("nextMatricula isola por org (loja de A invisível para B)", matIso);

  // ===== 3.6. excluir (soft delete) vendedor =====
  const carla = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '2001', 'Carla', 1)`).run(carla, A);
  Dir.setStores(A, carla, [avBrasil, barra], avBrasil, "boss");
  check("pré-exclusão: Carla lotada em 2 lojas", Dir.storesForSeller(A, carla).length === 2);
  Dir.deactivateSeller(A, carla, "boss");
  const carlaRow = db.prepare(`SELECT active FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(A, carla) as any;
  check("exclusão desativa a identidade (active=0)", Number(carlaRow.active) === 0);
  check("exclusão encerra todas as lotações", Dir.storesForSeller(A, carla).length === 0);
  check("loja não vê mais o vendedor excluído no roster", !Dir.sellersForStore(A, avBrasil).some((s: any) => s.seller_id === carla));
  const carlaAssignRaw = db.prepare(`SELECT COUNT(*) AS n FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ?`).get(A, carla) as any;
  check("vínculos preservados no banco (histórico, nunca DELETE)", Number(carlaAssignRaw.n) === 2);
  let delIso = false;
  try { Dir.deactivateSeller(B, carla, "x"); } catch { delIso = true; }
  check("excluir isola por org (vendedor de A invisível para B)", delIso);

  // ===== 4. isolamento =====
  let iso = false;
  try { Dir.coverage(B, avBrasil); } catch { iso = true; }
  check("org B não lê cobertura da loja de A", iso);
  check("org B não vê a lotação de Ana", Dir.storesForSeller(B, ana).length === 0);

  console.log("\n=== TEST: Diretório de vendedores + lotação (Fatia 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
