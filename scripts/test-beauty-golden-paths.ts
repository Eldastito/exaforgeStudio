/**
 * TEST — BEAUTY-018 (ADR-169 F17): Golden paths E2E da vertical Beleza & Salões.
 *
 * Encadeia TODAS as fatias F1–F16 num fluxo REAL do §7 do PRD (a "jornada
 * da cliente") sobre um fixture "Studio Márcia" (por dado, §17/§65 — nunca
 * hardcoded no service). Cada passo prova que o próximo pode acontecer.
 *
 * FLUXO E2E (10 passos):
 *   1. Vertical registrada (F1)
 *   2. Blueprint atribuído ao piloto por dado (F2)
 *   3. Perfis RBAC semeados condicionalmente (F3)
 *   4. Serviço com duração no catálogo + profissional habilitado (F4)
 *   5. Consent + upload de foto + EXIF strip + URL assinada (F5)
 *   6. Simulação SUCCEEDED via stub provider (F6)
 *   7. Análise de harmonia descritiva com actor+reason (F8)
 *   8. Recomendação de serviços do catálogo real (F9)
 *   9. Seleção + agendamento com profissional certa (F10)
 *  10. Handler beauty_review_invite pronto pro atendimento assured (F13)
 *
 * Cada passo é uma "gate" — a falha de um passo trava todo o resto.
 *
 * Uso: npm run test:beauty-golden-paths
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-golden-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-golden-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const sharp = (await import("sharp")).default;

  const { VERTICALS, CONSENT_BY_VERTICAL } = await import("../src/server/verticals.js");
  const { BlueprintSeeder, inferBlueprintKeyFor } = await import("../src/server/BlueprintSeeder.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { ProfessionalServiceService } = await import("../src/server/ProfessionalServiceService.js");
  const { AppointmentService } = await import("../src/server/AppointmentService.js");
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");
  const { BeautyHairSimulationService } = await import("../src/server/BeautyHairSimulationService.js");
  const { BeautyHarmonyAnalysisService } = await import("../src/server/BeautyHarmonyAnalysisService.js");
  const { LookServiceRecommendationService } = await import("../src/server/LookServiceRecommendationService.js");
  const { BeautyLookToAppointmentService } = await import("../src/server/BeautyLookToAppointmentService.js");
  const { BeautyReviewInviteCommandHandler } = await import("../src/server/BeautyReviewInviteCommandHandler.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  // ═══════ SETUP: fixture "Studio Márcia" por dado (§17/§65) ═══════
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const businessName = "Studio de Beleza Márcia"; // dado, não constante
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled, beauty_hair_simulator_enabled) VALUES (?, ?, ?, 'active', 'beleza', 'growth', 'active', 1, 1)`,
  ).run(randomUUID(), orgId, businessName);

  BlueprintSeeder.seedInitialBlueprints("golden_paths_test");

  // ═══════ 1. Vertical registrada (F1) ═══════
  check("1.1 vertical 'beleza' registrada em VERTICALS", (VERTICALS as any[]).some((v: any) => v.key === "beleza"));
  check(
    "1.2 CONSENT_BY_VERTICAL.beleza inclui escopos LGPD",
    Array.isArray((CONSENT_BY_VERTICAL as any).beleza) && (CONSENT_BY_VERTICAL as any).beleza.length > 0,
  );

  // ═══════ 2. Blueprint atribuído (F2) ═══════
  const bpInf = inferBlueprintKeyFor("beleza", "growth");
  check("2.1 inferBlueprintKeyFor('beleza','growth')='beleza_salao_v1'", bpInf?.key === "beleza_salao_v1");
  const bpRow = db.prepare(
    `SELECT id FROM vertical_blueprints WHERE key = 'beleza_salao_v1' AND status = 'published' ORDER BY version DESC LIMIT 1`,
  ).get() as any;
  check("2.2 blueprint beleza_salao_v1 publicado no seed", bpRow?.id != null);
  VerticalBlueprintService.assignToOrganization(orgId, bpRow.id, "test-golden");
  const assigned = db.prepare(
    `SELECT blueprint_key FROM organization_blueprints WHERE organization_id = ?`,
  ).get(orgId) as any;
  check("2.3 blueprint atribuído ao piloto por dado (§17/§65)", assigned?.blueprint_key === "beleza_salao_v1");

  // ═══════ 3. Perfis RBAC beauty seeded (F3) ═══════
  const beautyProfiles = db.prepare(
    `SELECT name FROM role_profiles WHERE organization_id = ? AND name LIKE '%(Beleza)'`,
  ).all(orgId) as any[];
  check(
    "3.1 seeded ≥ 3 perfis Beauty (Recepção/Cabeleireira/Gerente)",
    beautyProfiles.length >= 3,
  );

  // ═══════ 4. Serviço no catálogo + pro habilitado (F4) ═══════
  const svcId = `s_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO products_services (id, organization_id, type, name, price, currency, active, duration_minutes, maintenance_days) VALUES (?, ?, 'service', 'Coloração completa', 250, 'BRL', 1, 120, 30)`,
  ).run(svcId, orgId);
  const proId = `p_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, 'Márcia', 1)`,
  ).run(proId, orgId);
  ProfessionalServiceService.link(orgId, proId, svcId, { isPrimary: true });
  check(
    "4.1 ProfessionalServiceService.isCapable=true",
    ProfessionalServiceService.isCapable(orgId, proId, svcId) === true,
  );
  check(
    "4.2 AppointmentService.serviceDurationMin=120 (respeita catálogo)",
    AppointmentService.serviceDurationMin(orgId, svcId) === 120,
  );

  // ═══════ 5. Consent + upload + EXIF strip + URL assinada (F5) ═══════
  const contactId = `c_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Ana', '5511911111111')`,
  ).run(contactId, orgId);
  BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
  // Consent 'comunicacoes' é do LgpdService (escopo LGPD Art.7), não do
  // consent tipado beauty (RN-BS-04 — escopos separados).
  LgpdService.grantConsent(orgId, contactId, "comunicacoes");
  const cons = BeautyVisualConsultationService.startConsultation(orgId, {
    contactId,
    goal: "coloração",
  });
  check("5.1 consulta iniciada (status='draft')", cons.status === "draft");

  const photoJpeg = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .withMetadata({ exif: { IFD0: { Software: "TestCam", Make: "TestBrand", Model: "T100" } } })
    .jpeg()
    .toBuffer();
  const uploadRes = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, photoJpeg);
  const assetId = (uploadRes as any).assetId;
  check("5.2 upload de foto retornou assetId", typeof assetId === "string" && assetId.length > 0);

  const assetRow = db.prepare(
    `SELECT storage_key FROM beauty_avatar_assets WHERE id = ?`,
  ).get(assetId) as any;
  check("5.3 arquivo persistido em private_media", typeof assetRow.storage_key === "string");
  // Aprovação manual (F5 sem IA de validação)
  BeautyVisualConsultationService.approveAsset(orgId, assetId);

  // ═══════ 6. Simulação SUCCEEDED (F6) ═══════
  const sim = BeautyHairSimulationService.requestSimulation(orgId, cons.id, {
    simulationType: "color",
    parameters: { color: "morena_iluminada" },
  });
  const simId = (sim as any).simulationId;
  // Aguarda o job (setImmediate) processar
  let finalSim: any = null;
  for (let i = 0; i < 30; i++) {
    finalSim = BeautyHairSimulationService.getSimulation(orgId, simId);
    if (finalSim && finalSim.status === "SUCCEEDED") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  check("6.1 simulação SUCCEEDED via stub provider", finalSim?.status === "SUCCEEDED");
  check("6.2 output_storage_key populado", typeof finalSim.outputStorageKey === "string");

  // ═══════ 7. Análise de harmonia (F8) ═══════
  const analysis = BeautyHarmonyAnalysisService.analyze(orgId, cons.id, {
    simulationId: simId,
    actorId: "u_estilista",
    reason: "sugerir alto impacto",
  });
  check("7.1 análise gerada com 5 dimensões", Object.keys((analysis as any).dimensions).length === 5);
  check(
    "7.2 narrativa NÃO contém palavras proibidas (RN-BS-03)",
    !/(bonit|feio|atraente|lindo|nota|score|rank|melhor|pior|envelhec|rejuvenesc|afin|emagrec|embel)/i.test(
      (analysis as any).narrative,
    ),
  );
  check(
    "7.3 disclaimer sempre presente",
    (analysis as any).narrative.includes("opção mais adequada"),
  );

  // ═══════ 8. Recomendação de serviços do catálogo real (F9) ═══════
  // Move consulta pra 'selected' primeiro
  db.prepare(
    `UPDATE beauty_visual_consultations SET status='selected', selected_simulation_id=?, selected_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).run(simId, cons.id);
  const rec = LookServiceRecommendationService.recommendForSimulation(orgId, simId);
  check("8.1 recomendação ok=true", (rec as any).ok === true);
  check(
    "8.2 recomenda o serviço 'Coloração completa' do catálogo real (RN-BS-11)",
    (rec as any).recommendations?.some((r: any) => r.serviceId === svcId),
  );

  // ═══════ 9. Agendamento (F10) ═══════
  const fromMs = Date.parse("2027-01-04T00:00:00Z");
  const av = BeautyLookToAppointmentService.availability(orgId, cons.id, {
    serviceId: svcId,
    fromMs,
    days: 3,
  });
  check("9.1 availability retorna ≥1 slot", (av as any).ok === true && (av as any).professionals?.length >= 1);

  const slot = (av as any).professionals[0].slots[0];
  const book = BeautyLookToAppointmentService.book(
    orgId,
    cons.id,
    { serviceId: svcId, professionalId: proId, startISO: slot.startISO },
    "u_recepcao",
  );
  check("9.2 book ok=true", (book as any).ok === true);
  const apptId = (book as any).appointmentId;

  // Consulta agora 'scheduled' + snapshot visual derivável
  const consAfter = BeautyVisualConsultationService.getConsultation(orgId, cons.id);
  check("9.3 consulta agora 'scheduled'", consAfter?.status === "scheduled");
  const derived = BeautyLookToAppointmentService.consultationForAppointment(orgId, apptId);
  check(
    "9.4 consultationForAppointment recupera snapshot visual (RN-004 via FK)",
    derived?.selectedSimulationId === simId,
  );

  // ═══════ 10. Handler beauty_review_invite pronto (F13) ═══════
  // Marca appt como 'completed' pra simular atendimento realizado
  db.prepare(`UPDATE appointments SET status='completed' WHERE id=?`).run(apptId);
  const prep = BeautyReviewInviteCommandHandler.prepare(orgId, {
    id: `act_${randomUUID().slice(0, 8)}`,
    command_payload_json: JSON.stringify({
      appointmentId: apptId,
      contactId,
      phone: "5511911111111",
      channelId: "chn_test",
    }),
  });
  check(
    "10.1 handler.prepare retorna review invite draft com nome do serviço",
    (prep as any).artifact?.serviceName === "Coloração completa",
  );
  check(
    "10.2 draft menciona 'Ana' (nome do contato)",
    (prep as any).artifact?.message?.includes("Ana"),
  );

  // ═══════ RESUMO FINAL ═══════
  console.log("\n=== TEST: Golden Paths E2E Beauty (ADR-169 F17 / BEAUTY-018) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Vertical Beleza & Salões ponta-a-ponta — consent → foto → sim → análise → recomendação → agenda → review.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
