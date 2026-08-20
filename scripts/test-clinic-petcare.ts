/**
 * TEST — Plano de saúde + internação + cirurgia do pet (Petshop F5). DB-backed, det.
 * Prova (isolamento; segurança pré-op; nunca inventa):
 *   - plano de saúde: set liga/desliga (sem nome = sem plano) e aparece na ficha;
 *   - internação: admit/discharge; não interna 2x; internações ativas da org;
 *   - cirurgia: agenda com checklist default; marca itens; concluir EXIGE checklist
 *     100% (bloqueia se incompleto); cancelar sempre permitido;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:clinic-petcare
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-petcare-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-petcare-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ClinicPetService: PET } = await import("../src/server/ClinicPetService.js");
  const { ClinicPetCareService: CARE } = await import("../src/server/ClinicPetCareService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet A', 'active', 'petshop')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Pet B', 'active', 'petshop')`).run(randomUUID(), B);
  const tutorA = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Ana', 'ana')`).run(tutorA, A);
  const pet = PET.create(A, { tutorContactId: tutorA, name: "Rex", species: "cachorro" }).id;

  // ═══════════════ 1. plano de saúde ═══════════════
  CARE.setHealthPlan(A, pet, { name: "Plano Ouro" }, "u1");
  check("1.1 plano aparece ativo na ficha", PET.get(A, pet).healthPlanName === "Plano Ouro" && PET.get(A, pet).healthPlanStatus === "active");
  CARE.setHealthPlan(A, pet, { name: null }, "u1");
  check("1.2 sem nome = sem plano (null)", PET.get(A, pet).healthPlanName === null && PET.get(A, pet).healthPlanStatus === null);
  let hpBad = false; try { CARE.setHealthPlan(A, "nao-existe", { name: "X" }); } catch { hpBad = true; }
  check("1.3 pet inexistente rejeitado", hpBad);

  // ═══════════════ 2. internação ═══════════════
  const h = CARE.admit(A, pet, { reason: "Observação pós-cirúrgica" }, "u1");
  check("2.1 admite (internação criada)", !!h.id);
  check("2.2 internação ativa da org lista o pet", CARE.activeHospitalizations(A).some((x) => x.petName === "Rex"));
  let dupe = false; try { CARE.admit(A, pet, {}); } catch { dupe = true; }
  check("2.3 não interna 2x o mesmo pet", dupe);
  CARE.discharge(A, h.id, { notes: "Alta ok" }, "u1");
  check("2.4 alta encerra a internação", CARE.listHospitalizations(A, pet)[0].status === "discharged" && CARE.activeHospitalizations(A).length === 0);
  let disBad = false; try { CARE.discharge(A, h.id, {}); } catch { disBad = true; }
  check("2.5 alta 2x é rejeitada", disBad);
  // pós-alta pode internar de novo
  const h2 = CARE.admit(A, pet, { reason: "nova" }, "u1");
  check("2.6 pode reinternar após alta", !!h2.id && CARE.activeHospitalizations(A).length === 1);

  // ═══════════════ 3. cirurgia + checklist ═══════════════
  const s = CARE.scheduleSurgery(A, pet, { procedureName: "Castração", scheduledAt: "2026-09-01T09:00:00Z" }, "u1");
  check("3.1 agenda cirurgia com checklist default", !!s.id && CARE.listSurgeries(A, pet)[0].checklist.length === 4);
  let doneBad = false; try { CARE.setSurgeryStatus(A, s.id, "done"); } catch { doneBad = true; }
  check("3.2 concluir com checklist INCOMPLETO é bloqueado (segurança)", doneBad);
  const sg = CARE.listSurgeries(A, pet)[0];
  for (let i = 0; i < sg.checklist.length; i++) CARE.setChecklistItem(A, s.id, i, true, "u1");
  check("3.3 marca todos os itens", CARE.listSurgeries(A, pet)[0].checklist.every((c: any) => c.done));
  const done = CARE.setSurgeryStatus(A, s.id, "done", "u1");
  check("3.4 concluir com checklist 100% funciona", done.status === "done" && CARE.listSurgeries(A, pet)[0].performedAt);
  const s2 = CARE.scheduleSurgery(A, pet, { procedureName: "Limpeza dentária" }, "u1");
  check("3.5 cancelar sempre permitido (sem exigir checklist)", CARE.setSurgeryStatus(A, s2.id, "cancelled").status === "cancelled");
  let sbad = false; try { CARE.scheduleSurgery(A, pet, {}); } catch { sbad = true; }
  check("3.6 procedureName obrigatório", sbad);
  let idxBad = false; try { CARE.setChecklistItem(A, s.id, 99, true); } catch { idxBad = true; }
  check("3.7 índice de checklist inválido rejeitado", idxBad);

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  check("4.1 internações de A não aparecem em B", CARE.activeHospitalizations(B).length === 0);
  let cross = false; try { CARE.admit(B, pet, {}); } catch { cross = true; }
  check("4.2 não interna pet de outra org", cross);
  let crossS = false; try { CARE.scheduleSurgery(B, pet, { procedureName: "X" }); } catch { crossS = true; }
  check("4.3 não agenda cirurgia de pet de outra org", crossS);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} clinic-petcare: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
