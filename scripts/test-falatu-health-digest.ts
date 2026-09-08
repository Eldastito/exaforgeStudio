/**
 * TEST — Fala Tu entrega o resumo da CENTRAL DE SAÚDE também pelo Fala Tu (F9).
 * `FalaTuService.healthDigestFor` reusa `BusinessTutorService.morningBrief` (o
 * mesmo do digest de WhatsApp) e o expõe no /briefing, MAS role-gated (§73):
 *   - dono (visão completa) → resumo com texto.
 *   - vendedor (sem visão completa) → null (não vaza dinheiro).
 *   - isolamento por org.
 *
 * Uso: npm run test:falatu-health-digest
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-health-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-health-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    return o;
  };
  const A = mkOrg();
  const owner = { userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: A };
  const vend = { userId: randomUUID(), email: "vend@toulon.com", role: "agent", organizationId: A };

  // ── 1. dono (visão completa) recebe o resumo ──
  const d = await FalaTuService.healthDigestFor(A, owner);
  check("1.1 dono recebe healthDigest (não null)", d !== null);
  check("1.2 healthDigest tem texto", !!d && typeof d.text === "string" && d.text.trim().length > 0);
  check("1.3 healthDigest tem status", !!d && typeof d.status === "string");

  // ── 2. vendedor (sem visão completa) → null (não vaza dinheiro, §73) ──
  const dv = await FalaTuService.healthDigestFor(A, vend);
  check("2.1 vendedor NÃO recebe (null)", dv === null);

  // ── 3. isolamento: cada org tem o seu (dono de B recebe o de B) ──
  const B = mkOrg();
  const ownerB = { userId: randomUUID(), role: "owner", organizationId: B };
  const dB = await FalaTuService.healthDigestFor(B, ownerB);
  check("3.1 dono de B recebe o resumo de B", dB !== null && typeof dB.text === "string");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-health-digest: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
