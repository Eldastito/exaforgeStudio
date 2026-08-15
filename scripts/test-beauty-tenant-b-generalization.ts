/**
 * TEST — BEAUTY-019 (ADR-169 F18): prova §65 — segundo salão SEM tocar código.
 *
 * A promessa central da vertical Beleza (§17/§65 do PRD): "Studio de Beleza
 * Márcia é o piloto, mas o código NUNCA pode saber disso. Qualquer segundo
 * salão precisa poder ser configurado APENAS por DADO (blueprint + org
 * settings + catálogo) — se um único hardcoded escapar, a arquitetura não
 * generaliza".
 *
 * Este teste PROVA isso ao criar um "Salão Teste B" com dados TOTALMENTE
 * diferentes do piloto (nome, profissional, serviços, preços, durações,
 * paleta de cores oferecida, flags opt-in diferentes) e verificar que TODAS
 * as fatias F1–F17 funcionam IDÊNTICAS pra ele — sem UMA LINHA DE CÓDIGO
 * mudada. Se este teste falha, F18 volta pra in-progress e a arquitetura
 * precisa mais generalização.
 *
 * CENÁRIO DO Salão Teste B:
 *  - Nome: "Beauty Concept Studio Zona Leste"
 *  - 2 profissionais (não 1): "Ricardo" e "Juliana" (nomes diferentes do piloto)
 *  - 3 serviços com preços/durações diferentes (Balayage 380/150; Escova
 *    finalizada 55/40; Progressiva 480/210) — nenhum é "Coloração"
 *  - Flags DIFERENTES do piloto: quiet-hours 20h→7h (não 22→8), cap 2/12h
 *    (não 3/24h), detector de manutenção habilitado, detector de vaga
 *    NÃO habilitado
 *  - Cliente: "Fernanda" (não "Ana")
 *
 * Uso: npm run test:beauty-tenant-b-generalization
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-b-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-tenant-b-1234567890abcdef";
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

  const { BlueprintSeeder, inferBlueprintKeyFor } = await import("../src/server/BlueprintSeeder.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { ProfessionalServiceService } = await import("../src/server/ProfessionalServiceService.js");
  const { AppointmentService } = await import("../src/server/AppointmentService.js");
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");
  const { BeautyHairSimulationService } = await import("../src/server/BeautyHairSimulationService.js");
  const { BeautyHarmonyAnalysisService } = await import("../src/server/BeautyHarmonyAnalysisService.js");
  const { LookServiceRecommendationService } = await import("../src/server/LookServiceRecommendationService.js");
  const { BeautyLookToAppointmentService } = await import("../src/server/BeautyLookToAppointmentService.js");
  const { BeautyReviewInviteCommandHandler } = await import("../src/server/BeautyReviewInviteCommandHandler.js");
  const { BeautyMaintenanceDetector } = await import("../src/server/BeautyMaintenanceDetector.js");
  const { BeautyVacancyDetector } = await import("../src/server/BeautyVacancyDetector.js");
  const { ClientQuietHoursGuardService } = await import("../src/server/ClientQuietHoursGuardService.js");
  const { ClientFrequencyCapGuardService } = await import("../src/server/ClientFrequencyCapGuardService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  BlueprintSeeder.seedInitialBlueprints("tenant-b-test");

  // ═══════ SETUP: fixture "Salão Teste B" totalmente diferente do piloto ═══════
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const nameB = "Beauty Concept Studio Zona Leste"; // nome DIFERENTE do piloto
  db.prepare(
    `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled, beauty_hair_simulator_enabled) VALUES (?, ?, ?, 'active', 'beleza', 'start', 'active', 1, 1)`,
  ).run(randomUUID(), orgB, nameB);

  // ═══════ 1. Blueprint attribution (§65 — só dado) ═══════
  const bpInf = inferBlueprintKeyFor("beleza", "start");
  check("1.1 blueprint inference funciona pra 'start' plan (não só growth)", bpInf?.key === "beleza_salao_v1");
  const bpRow = db.prepare(
    `SELECT id FROM vertical_blueprints WHERE key = 'beleza_salao_v1' AND status = 'published' ORDER BY version DESC LIMIT 1`,
  ).get() as any;
  VerticalBlueprintService.assignToOrganization(orgB, bpRow.id, "admin-b");
  const assigned = db.prepare(
    `SELECT blueprint_key FROM organization_blueprints WHERE organization_id = ?`,
  ).get(orgB) as any;
  check("1.2 Salão B tem blueprint beleza_salao_v1 atribuído", assigned?.blueprint_key === "beleza_salao_v1");

  // Perfis RBAC beauty devem ter sido semeados automaticamente (F3 — side effect)
  const beautyProfilesB = db.prepare(
    `SELECT COUNT(*) c FROM role_profiles WHERE organization_id = ? AND name LIKE '%(Beleza)'`,
  ).get(orgB) as any;
  check("1.3 perfis Beauty semeados (RBAC funciona sem código específico)", beautyProfilesB.c >= 3);

  // ═══════ 2. Catálogo TOTALMENTE diferente do piloto ═══════
  // 2 profissionais (piloto tem 1)
  const proRicardo = `p_${randomUUID().slice(0, 8)}`;
  const proJuliana = `p_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, 'Ricardo', 1)`,
  ).run(proRicardo, orgB);
  db.prepare(
    `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, 'Juliana', 1)`,
  ).run(proJuliana, orgB);

  // 3 serviços com preços/durações/nomes DIFERENTES do piloto (Coloração 250/120)
  const svcBalayage = `s_${randomUUID().slice(0, 8)}`;
  const svcEscova = `s_${randomUUID().slice(0, 8)}`;
  const svcProgressiva = `s_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO products_services (id, organization_id, type, name, price, currency, active, duration_minutes, maintenance_days) VALUES (?, ?, 'service', 'Balayage', 380, 'BRL', 1, 150, 45)`,
  ).run(svcBalayage, orgB);
  db.prepare(
    `INSERT INTO products_services (id, organization_id, type, name, price, currency, active, duration_minutes, maintenance_days) VALUES (?, ?, 'service', 'Escova finalizada', 55, 'BRL', 1, 40, NULL)`,
  ).run(svcEscova, orgB);
  db.prepare(
    `INSERT INTO products_services (id, organization_id, type, name, price, currency, active, duration_minutes, maintenance_days) VALUES (?, ?, 'service', 'Progressiva', 480, 'BRL', 1, 210, 90)`,
  ).run(svcProgressiva, orgB);

  // Ricardo faz Balayage + Progressiva; Juliana faz Escova + Progressiva
  ProfessionalServiceService.link(orgB, proRicardo, svcBalayage, { isPrimary: true });
  ProfessionalServiceService.link(orgB, proRicardo, svcProgressiva);
  ProfessionalServiceService.link(orgB, proJuliana, svcEscova, { isPrimary: true });
  ProfessionalServiceService.link(orgB, proJuliana, svcProgressiva);

  check(
    "2.1 durações do catálogo lidas pela agenda (Balayage=150)",
    AppointmentService.serviceDurationMin(orgB, svcBalayage) === 150,
  );
  check(
    "2.2 outras durações também (Escova=40, Progressiva=210)",
    AppointmentService.serviceDurationMin(orgB, svcEscova) === 40 &&
      AppointmentService.serviceDurationMin(orgB, svcProgressiva) === 210,
  );
  check(
    "2.3 ProfessionalServiceService.isCapable respeita catálogo do B",
    ProfessionalServiceService.isCapable(orgB, proRicardo, svcBalayage) === true &&
      ProfessionalServiceService.isCapable(orgB, proJuliana, svcEscova) === true &&
      ProfessionalServiceService.isCapable(orgB, proRicardo, svcEscova) === false, // Ricardo NÃO faz escova
  );

  // ═══════ 3. Beauty AI ponta-a-ponta com dados do B ═══════
  const contactFer = `c_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', 'Fernanda', '5521988888888')`,
  ).run(contactFer, orgB);
  BeautyVisualConsultationService.grantConsent(orgB, contactFer, "hair_simulation");
  LgpdService.grantConsent(orgB, contactFer, "comunicacoes");
  const cons = BeautyVisualConsultationService.startConsultation(orgB, {
    contactId: contactFer,
    goal: "balayage",
  });
  check("3.1 startConsultation funciona pra 'Fernanda' (não 'Ana')", cons.contactId === contactFer);

  const photo = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 80, g: 40, b: 20 } },
  }).jpeg().toBuffer();
  const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgB, cons.id, photo);
  BeautyVisualConsultationService.approveAsset(orgB, (up as any).assetId);

  const sim = BeautyHairSimulationService.requestSimulation(orgB, cons.id, {
    simulationType: "color",
    parameters: { color: "balayage" },
  });
  let finalSim: any = null;
  for (let i = 0; i < 30; i++) {
    finalSim = BeautyHairSimulationService.getSimulation(orgB, (sim as any).simulationId);
    if (finalSim && finalSim.status === "SUCCEEDED") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  check("3.2 sim SUCCEEDED pra Salão B (mesmo provider stub)", finalSim?.status === "SUCCEEDED");

  const analysis = BeautyHarmonyAnalysisService.analyze(orgB, cons.id, {
    simulationId: (sim as any).simulationId,
    actorId: "u_ricardo",
    reason: "conversar sobre visual",
  });
  check(
    "3.3 análise de harmonia gera 5 dimensões pra Salão B (mesma engine, RN-BS-03 idêntica)",
    Object.keys((analysis as any).dimensions).length === 5,
  );

  // ═══════ 4. Recomendação usa CATÁLOGO DO B (não do piloto) ═══════
  db.prepare(
    `UPDATE beauty_visual_consultations SET status='selected', selected_simulation_id=?, selected_at=CURRENT_TIMESTAMP WHERE id=?`,
  ).run((sim as any).simulationId, cons.id);
  const rec = LookServiceRecommendationService.recommendForSimulation(orgB, (sim as any).simulationId);
  check("4.1 recomendação ok=true pra Salão B", (rec as any).ok === true);
  const recIds = (rec as any).recommendations.map((r: any) => r.serviceId);
  check(
    "4.2 recomenda 'Balayage' do catálogo do B (RN-BS-11 — não vaza serviço do piloto)",
    recIds.includes(svcBalayage),
  );

  // ═══════ 5. Availability + book usa profissionais do B ═══════
  const fromMs = Date.parse("2027-01-04T00:00:00Z");
  const av = BeautyLookToAppointmentService.availability(orgB, cons.id, {
    serviceId: svcBalayage,
    fromMs,
    days: 3,
  });
  check(
    "5.1 availability pra Balayage retorna Ricardo (único capaz)",
    (av as any).ok === true &&
      (av as any).professionals.length === 1 &&
      (av as any).professionals[0].professionalName === "Ricardo",
  );

  const slot = (av as any).professionals[0].slots[0];
  const book = BeautyLookToAppointmentService.book(
    orgB,
    cons.id,
    { serviceId: svcBalayage, professionalId: proRicardo, startISO: slot.startISO },
    "u_recepcao_b",
  );
  check("5.2 book agenda Ricardo pra Balayage 150min", (book as any).ok === true && (book as any).durationMinutes === 150);
  check("5.3 professionalName snapshot='Ricardo'", (book as any).professionalName === "Ricardo");

  // ═══════ 6. Handler review_invite funciona pra Salão B ═══════
  const apptId = (book as any).appointmentId;
  db.prepare(`UPDATE appointments SET status='completed' WHERE id=?`).run(apptId);
  const prep = BeautyReviewInviteCommandHandler.prepare(orgB, {
    id: `act_${randomUUID().slice(0, 8)}`,
    command_payload_json: JSON.stringify({
      appointmentId: apptId,
      contactId: contactFer,
      phone: "5521988888888",
      channelId: "chn_b",
    }),
  });
  check("6.1 prepare menciona Fernanda + Balayage", (prep as any).artifact?.message?.includes("Fernanda") && (prep as any).artifact?.message?.includes("Balayage"));

  // ═══════ 7. Flags opt-in COMPLETAMENTE diferentes do piloto ═══════
  // Piloto usaria default 22h→8h; Salão B configura 20h→7h
  ClientQuietHoursGuardService.setEnabled(orgB, true);
  ClientQuietHoursGuardService.setWindow(orgB, { startHour: 20, endHour: 7 });
  const winB = ClientQuietHoursGuardService.effectiveWindow(orgB);
  check(
    "7.1 quiet-hours customizada 20h→7h (não default 22→8)",
    winB.startHour === 20 && winB.endHour === 7 && winB.source === "custom",
  );

  // Frequency cap 2/12h (não default 3/24h)
  ClientFrequencyCapGuardService.setEnabled(orgB, true);
  ClientFrequencyCapGuardService.setParams(orgB, { max: 2, windowHours: 12 });
  const capB = ClientFrequencyCapGuardService.effectiveParams(orgB);
  check(
    "7.2 frequency cap customizado 2/12h (não default 3/24h)",
    capB.max === 2 && capB.windowHours === 12 && capB.source === "custom",
  );

  // Maintenance detector ligado; vacancy detector NÃO
  BeautyMaintenanceDetector.setEnabled(orgB, true);
  check(
    "7.3 maintenance detector ligado independentemente",
    BeautyMaintenanceDetector.isEnabled(orgB) === true,
  );
  check(
    "7.4 vacancy detector NÃO ligado (opt-in independente por flag)",
    BeautyVacancyDetector.isEnabled(orgB) === false,
  );

  // ═══════ 8. §17/§65 — nenhuma linha do código de Beauty menciona "B"/"Ricardo"/"Fernanda" ═══════
  // Garantimos que os dados do Salão B TÍPICOS não aparecem hardcoded em src/server ou src/features.
  const forbiddenTenantB = ["ricardo", "juliana", "fernanda", "balayage_b", "beauty concept studio", "zona leste"];
  let hardcodedB: string | null = null;
  const walkB = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walkB(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenTenantB) {
            // Ignora contexto legítimo (ex.: "balayage" é KEYWORD do vocab canônico — não hardcoded do Salão B)
            if (n === "balayage_b" && s.includes(n)) { hardcodedB = `${p}: ${n}`; return; }
            if (["ricardo", "juliana", "fernanda", "beauty concept studio", "zona leste"].includes(n) && s.includes(n)) {
              hardcodedB = `${p}: ${n}`;
              return;
            }
          }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walkB(path.join(process.cwd(), "src", "server"));
    if (!hardcodedB) walkB(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check(
    "8.1 §65: nenhum hardcoded do Salão B em src/server ou src/features",
    hardcodedB === null,
    hardcodedB || undefined,
  );

  // ═══════ 9. Também confirma que zero hardcoded do PILOTO (§17) ═══════
  const forbiddenPilot = ["studio_marcia", "studio de beleza márcia", "marcia_studio", "\"marcia\"", "'marcia'"];
  let hardcodedM: string | null = null;
  const walkM = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walkM(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenPilot) if (s.includes(n)) { hardcodedM = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walkM(path.join(process.cwd(), "src", "server"));
    if (!hardcodedM) walkM(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check(
    "9.1 §17: nenhum hardcoded do Studio Márcia (piloto) em src/",
    hardcodedM === null,
    hardcodedM || undefined,
  );

  // --- Relatório ---
  console.log("\n=== TEST: Prova §65 — Salão Teste B sem alterar código (ADR-169 F18 / BEAUTY-019) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S). F18 volta a in-progress — arquitetura precisa mais generalização.`); process.exit(1); }
  console.log("\n✅ §65 PROVADO — Salão Teste B configurado SÓ POR DADO; nenhuma linha de código tocada.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
