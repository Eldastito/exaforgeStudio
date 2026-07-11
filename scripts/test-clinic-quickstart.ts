/**
 * TESTE — Módulo Clínica Fase A: Pack Saúde 2.0 + RBAC do Quick-Start (ADR-080)
 * ----------------------------------------------------------------------------
 * Prova, offline e em banco temporário, que:
 *   - o pack "saude" cria 5 áreas clínicas e 7 cadências (com os gatilhos novos);
 *   - as flags clinic_* são aplicadas em organization_settings;
 *   - a idempotência por nome não duplica ao reaplicar;
 *   - o setup é isolado por organização;
 *   - o middleware requireRole bloqueia 'agent' e libera owner/admin no /apply.
 *
 * Uso:  npm run test:clinic-quickstart
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-quickstart-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-quickstart-1234567890";
process.env.SKIP_FAQ_EMBED = "1"; // sem rede: aplicamos com skipFaq

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

function fakeRes() {
  const state: { statusCode?: number; body?: any } = {};
  const res: any = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: any) { state.body = body; return res; },
  };
  return { res, state };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");
  const { requireRole } = await import("../src/server/middleware/auth.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    return orgId;
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Aplicar o pack saude (skipFaq: sem rede) ----
  const rep = await OnboardingTemplateService.applyPack(A, "saude", { skipFaq: true });
  check("Pack saúde cria 5 áreas clínicas", rep.areas.created === 5);
  check("Pack saúde cria 7 cadências", rep.cadences.created === 7);
  check("Automações aplicadas (inclui clinic_*)", rep.automations.applied >= 6);

  const areaNames = db.prepare("SELECT name FROM service_areas WHERE organization_id = ? ORDER BY position").all(A).map((r: any) => r.name);
  check("Área 'Convênios e Autorizações' existe", areaNames.includes("Convênios e Autorizações"));
  check("Área 'Coordenação de Agenda' existe", areaNames.includes("Coordenação de Agenda"));

  const triggers = db.prepare("SELECT trigger_stage FROM cadences WHERE organization_id = ?").all(A).map((r: any) => r.trigger_stage);
  for (const t of ["autorizacao_pendente", "autorizacao_aprovada", "autorizacao_negada", "documentacao_pendente", "retorno_recomendado"]) {
    check(`Cadência com gatilho ${t} criada`, triggers.includes(t));
  }

  const s = db.prepare("SELECT clinic_overrun_alert_enabled, clinic_overrun_warning_minutes, clinic_authorization_enabled, clinic_print_agenda_enabled, clinic_professional_portal_enabled FROM organization_settings WHERE organization_id = ?").get(A) as any;
  check("Flag clinic_overrun_alert_enabled = 1", s.clinic_overrun_alert_enabled === 1);
  check("Flag clinic_overrun_warning_minutes = 15", s.clinic_overrun_warning_minutes === 15);
  check("Flag clinic_professional_portal_enabled = 1", s.clinic_professional_portal_enabled === 1);

  // ---- 2. Idempotência: reaplicar não duplica ----
  const rep2 = await OnboardingTemplateService.applyPack(A, "saude", { skipFaq: true });
  check("Reaplicar não cria áreas novas", rep2.areas.created === 0 && rep2.areas.skipped === 5);
  check("Reaplicar não cria cadências novas", rep2.cadences.created === 0 && rep2.cadences.skipped === 7);
  check("Nº de áreas permanece 5", (db.prepare("SELECT COUNT(*) n FROM service_areas WHERE organization_id = ?").get(A) as any).n === 5);

  // ---- 3. Isolamento por organização ----
  check("Org B não recebeu áreas de A", (db.prepare("SELECT COUNT(*) n FROM service_areas WHERE organization_id = ?").get(B) as any).n === 0);

  // ---- 4. RBAC do Quick-Start (middleware requireRole) ----
  const mw = requireRole("owner", "admin");
  function callAs(role: string): number {
    const { res, state } = fakeRes();
    let nexted = false;
    mw({ user: { role } } as any, res, () => { nexted = true; });
    return nexted ? 200 : (state.statusCode || 0);
  }
  check("requireRole libera owner", callAs("owner") === 200);
  check("requireRole libera admin", callAs("admin") === 200);
  check("requireRole bloqueia agent (403)", callAs("agent") === 403);

  console.log("\n=== Módulo Clínica — Pack Saúde 2.0 + RBAC (ADR-080, Fase A) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
