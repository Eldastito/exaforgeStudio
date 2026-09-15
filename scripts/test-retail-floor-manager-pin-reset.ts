/**
 * TESTE — Reset do PIN da gerência (Atendimento de Loja) esquecido.
 * ------------------------------------------------------------------------------
 * O PIN normal (setManagerPin) EXIGE o PIN atual pra trocar — se esqueceram,
 * travam. resetManagerPin (owner/admin, rota gated) redefine SEM o PIN antigo.
 * Prova, offline:
 *   - com PIN configurado, trocar sem o atual FALHA (o cadeado protege);
 *   - reset define um PIN NOVO sem o antigo; o novo passa e o antigo não;
 *   - reset com pin vazio REMOVE o PIN; formato inválido é rejeitado;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-manager-pin-reset
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-floor-pin-reset-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-floor-pin-reset-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
function verifies(fn: () => void): boolean { try { fn(); return true; } catch { return false; } }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailFloorService: Floor } = await import("../src/server/RetailFloorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Av. brasil', '1082', 1)`).run(store, A);

  // 1) Cadastra o PIN inicial (sem PIN antigo, pois não havia).
  Floor.setManagerPin(A, store, "1234", undefined, "u1");
  check("1.1 PIN inicial configurado e verifica", verifies(() => Floor.verifyManagerPin(A, store, "1234")));
  check("1.2 PIN errado NÃO verifica", !verifies(() => Floor.verifyManagerPin(A, store, "0000")));

  // 2) Esqueceram: trocar SEM o PIN atual falha (o cadeado protege).
  check("2.1 trocar sem o PIN atual FALHA (setManagerPin exige o atual)", !verifies(() => Floor.setManagerPin(A, store, "5678", undefined, "u1")));

  // 3) Reset (owner/admin) define PIN novo SEM o antigo.
  const r = Floor.resetManagerPin(A, store, "5678", "owner1");
  check("3.1 reset define PIN novo (hasManagerPin=true)", r.hasManagerPin === true);
  check("3.2 PIN novo verifica", verifies(() => Floor.verifyManagerPin(A, store, "5678")));
  check("3.3 PIN antigo NÃO verifica mais", !verifies(() => Floor.verifyManagerPin(A, store, "1234")));

  // 4) Reset com pin vazio REMOVE o PIN.
  const r2 = Floor.resetManagerPin(A, store, null, "owner1");
  check("4.1 reset com pin vazio remove (hasManagerPin=false)", r2.hasManagerPin === false);
  const row = db.prepare(`SELECT manager_pin_hash FROM retail_stores WHERE id = ?`).get(store) as any;
  check("4.2 hash zerado no banco", !row?.manager_pin_hash);

  // 5) Formato inválido é rejeitado.
  check("5.1 PIN de 2 dígitos é rejeitado", !verifies(() => Floor.resetManagerPin(A, store, "12", "owner1")));

  // 6) Isolamento: reset numa org que não é dona da loja não acha a loja.
  check("6.1 org B não reseta a loja de A", !verifies(() => Floor.resetManagerPin(B, store, "9999", "ownerB")));

  console.log("\n=== TEST: Reset do PIN da gerência ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
