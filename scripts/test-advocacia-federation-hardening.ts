/**
 * TEST — Hardening da federação OAB (ADR-191 OAB-F5). DB-backed, determinístico.
 * Doc-of-record executável de dupla função:
 *   (A) CODIFICA os guardrails RN-PN no contexto ADVOCACIA como REGRESSÃO tocando os
 *       serviços reais OAB-F1..F3;
 *   (B) verifica a FIAÇÃO de produção (serviços importáveis, rotas montadas, testes wired).
 *
 * FECHA a federação OAB. Uso: npm run test:advocacia-federation-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adv-fed-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-adv-fed-hard-123456";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function routePaths(router: any): string[] {
  const out: string[] = [];
  try { for (const l of router?.stack || []) if (l?.route?.path) out.push(String(l.route.path)); } catch { /* noop */ }
  return out;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalProfessionalFederationService: FED } = await import("../src/server/LegalProfessionalFederationService.js");
  const { LegalProfessionalScheduleService: SCHED } = await import("../src/server/LegalProfessionalScheduleService.js");
  const { LegalProfessionalBookingService: BOOK } = await import("../src/server/LegalProfessionalBookingService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { ProfessionalService } = await import("../src/server/ProfessionalService.js");

  // ═══════════ (B) FIAÇÃO DE PRODUÇÃO ═══════════
  check("B1 serviços da federação importáveis", typeof FED?.federate === "function" && typeof FED?.defederate === "function" && typeof SCHED?.setWindows === "function" && typeof BOOK?.availability === "function");
  const router = (await import("../src/server/routes/advocacia.js")).default as any;
  const rp = routePaths(router);
  check("B2 rotas de federação montadas", rp.includes("/lawyers/:id/federation") && rp.includes("/lawyers/:id/federation/revoke") && rp.includes("/professional-network/settings"));
  check("B3 rotas de agenda federada montadas", rp.includes("/lawyers/:id/offerings") && rp.includes("/lawyers/:id/windows") && rp.includes("/lawyers/:id/availability") && rp.includes("/holds/:holdId/booking"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const wired = ["test:legal-federation", "test:legal-professional-schedule", "test:legal-professional-booking", "test:advocacia-federation-hardening"];
  check("B4 testes da federação wired no package.json", wired.every((t) => typeof pkg.scripts?.[t] === "string"));
  check("B5 runbook cobre a federação OAB", fs.readFileSync(path.join(repoRoot, "docs/runbook/advocacia-operacao.md"), "utf8").includes("Federação OAB"));

  // ═══════════ (A) GUARDRAILS RN-PN (contexto advocacia) ═══════════
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Adv A', 'active', 'advocacia')`).run(randomUUID(), A);
  const oab = String(400000 + Math.floor(Math.random() * 500000));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u1");
  const noOab = P.createLawyer(A, { name: "Estagiário" }, "u1");

  // RN-PN-8 — gate opt-in (rede desativada não federa).
  let g1 = false; try { FED.federate(A, lawyer.id, "u1"); } catch { g1 = true; }
  check("RN-PN-8 rede desativada → federar rejeitado (gate server-side)", g1);
  db.prepare(`UPDATE organization_settings SET professional_network_enabled = 1 WHERE organization_id = ?`).run(A);

  // RN-ADV-08 — OAB obrigatória (não inventa identidade).
  let g2 = false; try { FED.federate(A, noOab.id, "u1"); } catch { g2 = true; }
  check("RN-ADV-08 advogado sem OAB não federa", g2);

  // Federa + prova a fronteira §90.
  const fed = FED.federate(A, lawyer.id, "u1");
  check("RN-PN-1 federar cria identidade global + vínculo aceito", fed.federated === true && !!fed.professionalId);

  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Adv B', 'active', 'advocacia', 1)`).run(randomUUID(), B);
  const lawyerB = P.createLawyer(B, { name: "Dra. Ana", oabUf: "SP", oabNumber: oab }, "u2");
  const fedB = FED.federate(B, lawyerB.id, "u2");
  check("§90 mesma OAB → MESMA identidade global (ecossistema)", fedB.professionalId === fed.professionalId);
  check("RN-PN-2 vínculos SEPARADOS por org", fedB.relationshipId !== fed.relationshipId);

  // RN-PN-3 — defederar preserva a identidade global.
  FED.defederate(A, lawyer.id, "u1");
  check("RN-PN-3 defederar revoga vínculo mas PRESERVA identidade global", FED.status(A, lawyer.id).federated === false && !!ProfessionalService.findByRegistration("OAB", `SP ${oab}`));
  check("RN-PN-2 revogar em A não afeta B", FED.status(B, lawyerB.id).federated === true);

  // RN-PN-4 — vagas ATERRADAS: sem janela federada → zero vagas (não inventa).
  FED.federate(A, lawyer.id, "u1");
  const slots = await BOOK.availability(A, lawyer.id, "2027-06-14", { slotMinutes: 60, nowISO: "2027-06-14T00:00:00.000Z" } as any);
  check("RN-PN-4 sem janela → zero vagas (nunca inventa)", Array.isArray(slots) && slots.length === 0);

  // Config exige federação (RN-PN-8/2) — advogado defederado não configura.
  FED.defederate(A, lawyer.id, "u1");
  let g3 = false; try { SCHED.listWindows(A, lawyer.id); } catch { g3 = true; }
  check("RN-PN-2 configurar agenda exige federação viva", g3);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} advocacia-federation-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
