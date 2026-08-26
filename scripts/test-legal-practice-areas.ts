/**
 * TEST — Áreas do direito + advogados (ADR-191 F3). DB-backed, determinístico.
 * Prova a COMPOSIÇÃO PURA (zero tabela nova): áreas reusam clinic_specialties,
 * advogados reusam clinic_professionals (OAB em council+registration_number), vínculo
 * advogado↔área reusa o N:N. OAB validada, nunca inventada. Isolado por org.
 *
 * Uso: npm run test:legal-practice-areas
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalprac-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalprac-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalPracticeService: L } = await import("../src/server/LegalPracticeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Advogados', 'active', 'advocacia')`).run(randomUUID(), A);

  // ── 1. Áreas do direito (reuso clinic_specialties) ──
  const civel = L.createArea(A, { name: "Cível" }, "u1");
  const trab = L.createArea(A, { name: "Trabalhista" }, "u1");
  check("1.1 área criada (reuso de clinic_specialties)", !!civel?.id && civel.name === "Cível");
  check("1.2 lista traz as áreas", L.listAreas(A).length === 2);
  const seed = L.seedDefaultAreas(A, "u1");
  check("1.3 seed de áreas comuns (idempotente — não duplica Cível/Trabalhista)", seed.created === 6 && L.listAreas(A).length === 8);
  check("1.4 seed 2ª vez não cria nada (idempotente)", L.seedDefaultAreas(A, "u1").created === 0);

  // ── 2. OAB validada, nunca inventada ──
  check("2.1 OAB válida normaliza (UF + número)", L.normalizeOab("sp", "123456").registrationNumber === "SP 123456");
  check("2.2 sem OAB → em branco (honesto, não inventa)", L.normalizeOab(null, null).registrationNumber === null);
  let threwUf = false; try { L.normalizeOab("XX", "123456"); } catch { threwUf = true; }
  check("2.3 UF inválida rejeitada", threwUf);
  let threwNum = false; try { L.normalizeOab("SP", "1"); } catch { threwNum = true; }
  check("2.4 número inválido rejeitado", threwNum);

  // ── 3. Advogado (reuso clinic_professionals; OAB em council+registration) ──
  const adv = L.createLawyer(A, { name: "Dra. Ana Silva", oabUf: "SP", oabNumber: "123.456", color: "#334155", areaIds: [civel.id, trab.id] }, "u1");
  check("3.1 advogado criado com OAB (council=OAB)", adv.name === "Dra. Ana Silva" && adv.council === "OAB" && adv.registration_number === "SP 123456");
  check("3.2 lista de advogados", L.listLawyers(A).length === 1);
  const areas = L.areasForLawyer(A, adv.id);
  check("3.3 vínculo advogado↔áreas (reuso N:N)", areas.length === 2 && areas.some((a: any) => a.name === "Cível") && areas.some((a: any) => a.name === "Trabalhista"));

  // ── 4. reatribuir áreas ──
  L.setLawyerAreas(A, adv.id, [civel.id], "u1");
  check("4.1 reatribuir áreas (só Cível ativa)", L.areasForLawyer(A, adv.id).length === 1);

  // ── 5. isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro Escritório', 'active', 'advocacia')`).run(randomUUID(), B);
  check("5.1 org B não vê áreas/advogados de A", L.listAreas(B).length === 0 && L.listLawyers(B).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-practice-areas: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
