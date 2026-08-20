/**
 * TEST — ADR-180 F4b: flags opt-in da Agenda Federada. DB-backed, det., isolado.
 * Prova que o service LÊ (default off) e ESCREVE as duas flags com coerência
 * (autobooking exige rede; desligar a rede desliga autobooking) e isolado por org.
 *
 * Uso: npm run test:professional-network-settings
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnset-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnset-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalNetworkSettingsService: SET } = await import("../src/server/ProfessionalNetworkSettingsService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'B', 'active', 'petshop')`).run(randomUUID(), B);

  // 1. default off
  const d = SET.get(A);
  check("1.1 network default off", d.networkEnabled === false);
  check("1.2 autobooking default off", d.autobookingEnabled === false);

  // 2. liga a rede
  const s1 = SET.set(A, { networkEnabled: true });
  check("2.1 network ligada", s1.networkEnabled === true);
  check("2.2 autobooking segue off", s1.autobookingEnabled === false);

  // 3. liga autobooking (deve ligar a rede junto — coerência)
  const s2 = SET.set(A, { autobookingEnabled: true });
  check("3.1 autobooking ligado", s2.autobookingEnabled === true);
  check("3.2 rede segue ligada", s2.networkEnabled === true);

  // 4. desligar a rede força autobooking off (nunca órfão)
  const s3 = SET.set(A, { networkEnabled: false });
  check("4.1 rede desligada", s3.networkEnabled === false);
  check("4.2 autobooking forçado off", s3.autobookingEnabled === false);

  // 5. ligar autobooking direto liga a rede (coerência)
  const s4 = SET.set(A, { autobookingEnabled: true });
  check("5.1 rede ligada junto", s4.networkEnabled === true && s4.autobookingEnabled === true);

  // 6. patch parcial não mexe no que não veio
  SET.set(A, { networkEnabled: true, autobookingEnabled: false });
  const s5 = SET.set(A, { networkEnabled: true }); // não passa autobooking
  check("6.1 patch parcial preserva autobooking", s5.autobookingEnabled === false && s5.networkEnabled === true);

  // 7. isolamento — mexer em A não afeta B
  check("7.1 B intocado (isolamento)", SET.get(B).networkEnabled === false && SET.get(B).autobookingEnabled === false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-network-settings: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
