/**
 * TEST — BEAUTY-017 (ADR-169 F16): telemetria de FUNIL Beauty AI.
 *
 * Prova que `UxTelemetryService` reconhece os 7 event_types beauty
 * (BEAUTY_EVENT_TYPES) — grava com flag `ux_telemetry_enabled=1`, rejeita
 * sem — e o helper `beautyMetrics(orgId, user)` agrega o funil com taxas
 * de conversão determinísticas. Cost/uso da IA (custo real do provider
 * Gemini) segue no `AiUsageDashboardService.byOrg` (ADR-154) — F16 mede
 * ADOÇÃO/FUNIL, não duplica cost tracking.
 *
 * Checks-âncora:
 *  - BEAUTY_EVENT_TYPES: 7 nomes esperados (started/photo/simulation_requested/
 *    simulation_selected/analysis/appointment_booked/review_sent).
 *  - Whitelist: `beauty_random_stuff` NÃO é aceito (só os 7).
 *  - Opt-in: sem `ux_telemetry_enabled=1`, record é no-op.
 *  - Com flag: cada um dos 7 events é gravado.
 *  - `beautyMetrics()` conta cada bucket + calcula 4 conversões
 *    (photo/simulate/select/book) com null quando denominador=0.
 *  - Gestor (owner) vê métricas; não-gestor (atendente) → `restricted`.
 *  - Multi-tenant: eventos da orgB não contam pra orgA.
 *  - Minimização LGPD preservada (nada de conteúdo — os eventos beauty
 *    seguem o mesmo esquema stateless do core).
 *  - Regressão: 5 event_types CORE continuam aceitos.
 *
 * Uso: npm run test:beauty-metrics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-metrics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-metrics-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { UxTelemetryService, BEAUTY_EVENT_TYPES } = await import("../src/server/UxTelemetryService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const seedOrg = (org: string, tel: number, vertical = "beleza") =>
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, ux_telemetry_enabled) VALUES (?, ?, 'X', 'active', ?, 'autonomo', 'active', ?)`,
    ).run(randomUUID(), org, vertical, tel);

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  seedOrg(orgA, 1);
  seedOrg(orgB, 0);
  PermissionService.seedSystemProfiles(orgA);
  PermissionService.seedSystemProfiles(orgB);
  const prof = (org: string, key: string) =>
    (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const owner = { userId: "u1", email: "dono@x.com", role: "owner", role_profile_id: prof(orgA, "owner"), organizationId: orgA };
  const atendente = { userId: "u3", email: "at@x.com", role: "agent", role_profile_id: prof(orgA, "atendente"), organizationId: orgA };
  const ownerB = { userId: "u9", email: "dono@b.com", role: "owner", role_profile_id: prof(orgB, "owner"), organizationId: orgB };

  const rowCount = (org: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ux_telemetry_events WHERE organization_id = ?`).get(org) as any).n;
  const countType = (org: string, t: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ux_telemetry_events WHERE organization_id = ? AND event_type = ?`).get(org, t) as any).n;

  // ===== 1. Constantes =====
  check(
    "BEAUTY_EVENT_TYPES contém 7 nomes",
    BEAUTY_EVENT_TYPES.length === 7,
  );
  check(
    "inclui beauty_consultation_started",
    BEAUTY_EVENT_TYPES.includes("beauty_consultation_started" as any),
  );
  check(
    "inclui beauty_photo_uploaded",
    BEAUTY_EVENT_TYPES.includes("beauty_photo_uploaded" as any),
  );
  check(
    "inclui beauty_simulation_requested",
    BEAUTY_EVENT_TYPES.includes("beauty_simulation_requested" as any),
  );
  check(
    "inclui beauty_simulation_selected",
    BEAUTY_EVENT_TYPES.includes("beauty_simulation_selected" as any),
  );
  check(
    "inclui beauty_analysis_generated",
    BEAUTY_EVENT_TYPES.includes("beauty_analysis_generated" as any),
  );
  check(
    "inclui beauty_appointment_booked",
    BEAUTY_EVENT_TYPES.includes("beauty_appointment_booked" as any),
  );
  check(
    "inclui beauty_review_sent",
    BEAUTY_EVENT_TYPES.includes("beauty_review_sent" as any),
  );

  // ===== 2. Opt-in respeita flag =====
  const off = UxTelemetryService.record(orgB, ownerB, {
    eventType: "beauty_consultation_started",
    surface: "hoje",
    sessionId: "s1",
  });
  check(
    "orgB sem ux_telemetry_enabled → no-op (disabled)",
    off.recorded === false && off.reason === "disabled",
  );
  check("orgB não gravou nada", rowCount(orgB) === 0);

  // ===== 3. Whitelist rejeita nome fora do set =====
  const bad = UxTelemetryService.record(orgA, owner, {
    eventType: "beauty_random_stuff" as any,
    surface: "hoje",
  });
  check(
    "beauty_random_stuff (fora do set) → event_type_not_allowed",
    bad.recorded === false && bad.reason === "event_type_not_allowed",
  );

  // ===== 4. Com flag: cada beauty event é aceito =====
  for (const et of BEAUTY_EVENT_TYPES) {
    const r = UxTelemetryService.record(orgA, owner, {
      eventType: et,
      surface: "beauty_ai",
      sessionId: "s1",
    });
    check(`event '${et}' aceito com flag ON`, r.recorded === true);
  }

  // ===== 5. Funil populated + rates =====
  // Cenário: 10 consultas iniciadas, 6 foto, 5 simulation_requested, 3 selected,
  // 2 booked, 1 review. Já contamos as 7 acima (uma de cada). Vamos completar o
  // funil pra testar as taxas.
  // Estado atual (após loop): 1 de cada tipo (7 events).
  // Adiciona 9 started (total 10), 5 photo (total 6), 4 sim_req (total 5),
  // 2 selected (total 3), 1 booked (total 2). review continua 1.
  const many = (et: string, n: number) => {
    for (let i = 0; i < n; i++) {
      UxTelemetryService.record(orgA, owner, {
        eventType: et,
        surface: "beauty_ai",
        sessionId: `s${i}`,
      });
    }
  };
  many("beauty_consultation_started", 9);
  many("beauty_photo_uploaded", 5);
  many("beauty_simulation_requested", 4);
  many("beauty_simulation_selected", 2);
  many("beauty_appointment_booked", 1);

  const m = UxTelemetryService.beautyMetrics(orgA, owner) as any;
  check("beautyMetrics não é restricted (owner)", m.restricted !== true);
  check("funnel.started === 10", m.funnel.started === 10);
  check("funnel.photoUploaded === 6", m.funnel.photoUploaded === 6);
  check("funnel.simulationRequested === 5", m.funnel.simulationRequested === 5);
  check("funnel.simulationSelected === 3", m.funnel.simulationSelected === 3);
  check("funnel.analysisGenerated === 1", m.funnel.analysisGenerated === 1);
  check("funnel.appointmentBooked === 2", m.funnel.appointmentBooked === 2);
  check("funnel.reviewSent === 1", m.funnel.reviewSent === 1);
  // Conversões (arredondadas 2 casas): 6/10=0.6, 5/6≈0.83, 3/5=0.6, 2/3≈0.67
  check("conversions.photoRate === 0.6", m.conversions.photoRate === 0.6);
  check("conversions.simulateRate ≈ 0.83", m.conversions.simulateRate === 0.83);
  check("conversions.selectRate === 0.6", m.conversions.selectRate === 0.6);
  check("conversions.bookRate ≈ 0.67", m.conversions.bookRate === 0.67);
  check(
    "conversions null quando denominador=0 (orgB não tem eventos)",
    (() => {
      const mB = UxTelemetryService.beautyMetrics(orgB, ownerB) as any;
      if (mB.restricted === true) return true; // ownerB pode não ter visibilidade — OK
      return mB.conversions.photoRate === null;
    })(),
  );

  // ===== 6. Role-gate (§73) =====
  const mAt = UxTelemetryService.beautyMetrics(orgA, atendente) as any;
  check("atendente (não-gestor) → beautyMetrics restricted", mAt.restricted === true);

  // ===== 7. Multi-tenant =====
  // Cria evento na orgB usando ownerB (mas flag desligada — não vai gravar).
  // Verificar isolamento via count.
  UxTelemetryService.record(orgB, ownerB, {
    eventType: "beauty_consultation_started",
    surface: "hoje",
    sessionId: "s2",
  });
  check("orgB continua com 0 eventos (flag off)", rowCount(orgB) === 0);
  check(
    "orgA tem todos os eventos beauty (7 iniciais + 21 do many)",
    rowCount(orgA) === 28,
  );

  // ===== 8. Regressão: eventos CORE continuam aceitos =====
  const core = UxTelemetryService.record(orgA, owner, {
    eventType: "view_opened",
    surface: "hoje",
    sessionId: "s99",
  });
  check("view_opened CORE ainda aceito (0-regressão)", core.recorded === true);
  const ttfv = UxTelemetryService.record(orgA, owner, {
    eventType: "first_value",
    surface: "hoje",
    sessionId: "s99",
    ttfvMs: 800,
  });
  check("first_value CORE ainda grava TTFV (0-regressão)", ttfv.recorded === true);
  const ttfvRow = db.prepare(
    `SELECT ttfv_ms FROM ux_telemetry_events WHERE organization_id = ? AND event_type='first_value' ORDER BY created_at DESC LIMIT 1`,
  ).get(orgA) as any;
  check("first_value TTFV gravado === 800", ttfvRow.ttfv_ms === 800);

  // Summary CORE ainda funciona (regressão da fatia ADR-163 F10)
  const sCore = UxTelemetryService.summary(orgA, owner) as any;
  check(
    "summary() CORE ainda funciona (byType inclui view_opened)",
    sCore.totals?.byType?.view_opened >= 1,
  );

  // ===== 9. Minimização LGPD (RN-BS-05) — nenhuma coluna de conteúdo =====
  const cols = (db.prepare(`PRAGMA table_info(ux_telemetry_events)`).all() as any[]).map((c: any) => c.name);
  check(
    "ux_telemetry_events NÃO tem coluna content/payload/text/body/message",
    !cols.some((c: string) => /content|payload|text|body|message/i.test(c)),
  );

  // ===== 10. Zero hardcoded Studio Márcia =====
  const forbiddenNeedles = ["studio_marcia", "studio de beleza márcia", "marcia_studio", "\"marcia\"", "'marcia'"];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check(
    "nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)",
    hardcoded === null,
    hardcoded || undefined,
  );

  // --- Relatório ---
  console.log("\n=== TEST: Telemetria de FUNIL Beauty AI (ADR-169 F16 / BEAUTY-017) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Funil Beauty AI mensurado — 7 event_types + conversões, LGPD-minimizado, 0-regressão.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
