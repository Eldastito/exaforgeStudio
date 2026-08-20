/**
 * TEST — Profissional descobrível (ADR-180 F10.1). DB-backed, det., isolado.
 * Prova: RN-PN-9 (opt-in default OFF); ligar/desligar a visibilidade + região base; string
 * vazia limpa; UF normalizada; desligar/editar NÃO apaga identidade nem especialidades
 * (RN-PN-3); profissional inexistente → erro (não inventa).
 *
 * Uso: npm run test:professional-discoverability
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-disc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-disc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'petshop')`).run(randomUUID(), A);
  const p = PRO.upsertIdentity({ name: "Dra. Vet", council: "CRMV-SP", registrationNumber: "12345", specialties: ["cardiologia"] }, A);

  // 0. RN-PN-9 — nasce NÃO descobrível.
  check("0.1 default OFF (opt-in)", p.discoverable === false && p.baseCity === null && p.baseState === null);

  // 1. Liga a descoberta + região base.
  const on = PRO.setDiscoverability(p.id, { discoverable: true, baseCity: "Porto Alegre", baseState: "rs" });
  check("1.1 descobrível ligado", on.discoverable === true);
  check("1.2 cidade guardada", on.baseCity === "Porto Alegre");
  check("1.3 UF normalizada (maiúsc, 2 letras)", on.baseState === "RS");

  // 2. NÃO apaga identidade/especialidades (RN-PN-3).
  check("2.1 identidade intacta", on.name === "Dra. Vet" && on.council === "CRMV-SP" && on.specialties.join() === "cardiologia");

  // 3. Update parcial: só o que passa muda.
  const partial = PRO.setDiscoverability(p.id, { discoverable: false });
  check("3.1 desligar mantém cidade", partial.discoverable === false && partial.baseCity === "Porto Alegre");

  // 4. String vazia limpa a região.
  const cleared = PRO.setDiscoverability(p.id, { baseCity: "", baseState: "" });
  check("4.1 cidade limpa com string vazia", cleared.baseCity === null && cleared.baseState === null);

  // 5. lat/lng explícitos (F10.3 usa no match).
  const geo = PRO.setDiscoverability(p.id, { baseLat: -30.03, baseLng: -51.23 });
  check("5.1 lat/lng guardados", geo.baseLat === -30.03 && geo.baseLng === -51.23);

  // 6. Inexistente → erro (não inventa).
  let e6 = false; try { PRO.setDiscoverability("nao-existe", { discoverable: true }); } catch (e: any) { e6 = e.message === "professional_not_found"; }
  check("6.1 profissional inexistente → erro", e6);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-discoverability: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
