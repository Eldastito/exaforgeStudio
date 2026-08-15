/**
 * TEST — BEAUTY-013 (ADR-169 F12): detector de manutenção publica sinal
 * `beauty:maintenance_due:{contactId}:{serviceId}` na espinha canônica.
 *
 * Segundo tijolo do Beauty Autopilot em SHADOW. F12 SÓ DETECTA — a ação
 * (oferecer retorno) é fatia futura via `DecisionAction→ApprovalPolicy→
 * CommandExecutor` (handler `beauty_maintenance_offer`), freada pelos 3
 * gates da F5-transversal.
 *
 * Checks-âncora:
 *  - Flag OFF (default) → sweep zero.
 *  - Serviço COM maintenance_days=30 + appt de 45d atrás sem futuro → publica.
 *  - Mesmo caso mas COM appointment futuro do mesmo par → NÃO publica.
 *  - Serviço sem maintenance_days (NULL) → NÃO publica.
 *  - Serviço com maintenance_days=90 e appt de 30d → NÃO publica (dentro).
 *  - Appointment 'cancelled'/'no_show' → ignora (não conta como "última visita").
 *  - Dedupe: 2 sweeps mesmo estado → 1 sinal (idempotência).
 *  - contactName null sem consent; 'Ana' com consent comunicacoes.
 *  - Cross-tenant DURO.
 *  - pass() ignora flag OFF.
 *
 * Uso: npm run test:beauty-maintenance-detector
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-maint-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-maint-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const { BeautyMaintenanceDetector } = await import("../src/server/BeautyMaintenanceDetector.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  const seedOrg = (name = "Salão X") => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, ?, 'active', 'beleza')`,
    ).run(randomUUID(), orgId, name);
    return orgId;
  };
  const seedContact = (orgId: string, name = "Ana") => {
    const id = `c_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, `${orgId}:${id}`);
    return id;
  };
  const seedService = (
    orgId: string,
    name: string,
    opts: { maintenanceDays?: number | null; duration?: number } = {},
  ) => {
    const id = `s_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, price, currency, active, duration_minutes, maintenance_days)
       VALUES (?, ?, 'service', ?, 100, 'BRL', 1, ?, ?)`,
    ).run(id, orgId, name, opts.duration ?? 60, opts.maintenanceDays ?? null);
    return id;
  };
  const seedAppt = (
    orgId: string,
    contactId: string,
    serviceId: string,
    scheduledStart: Date,
    status: string | null = null,
  ) => {
    const id = `a_${randomUUID().slice(0, 8)}`;
    const endMs = scheduledStart.getTime() + 60 * 60000;
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, product_service_id, title, scheduled_start, scheduled_end, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, contactId, serviceId, "Atendimento", scheduledStart.toISOString(), new Date(endMs).toISOString(), status);
    return id;
  };

  const now = new Date();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600 * 1000);
  const daysFromNow = (d: number) => new Date(now.getTime() + d * 24 * 3600 * 1000);

  // ===== 1. Flag OFF default (0-regressão) =====
  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");
  const svcColoracao = seedService(orgA, "Coloração", { maintenanceDays: 30 });
  seedAppt(orgA, anaId, svcColoracao, daysAgo(45)); // 45d atrás
  check(
    "isEnabled(nova org) === false",
    BeautyMaintenanceDetector.isEnabled(orgA) === false,
  );
  const off = BeautyMaintenanceDetector.sweep(orgA);
  check("flag OFF: sweep zero", off.detected === 0 && off.publishedSignalIds.length === 0);
  check(
    "flag OFF: nenhum sinal criado",
    (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND signal_type='maintenance_due'`).get(orgA) as any).c === 0,
  );

  // ===== 2. Liga a flag → detecta =====
  BeautyMaintenanceDetector.setEnabled(orgA, true);
  const first = BeautyMaintenanceDetector.sweep(orgA);
  check("primeira sweep detecta 1", first.detected === 1);
  const sig = db.prepare(`SELECT * FROM business_signals WHERE id=?`).get(first.publishedSignalIds[0]) as any;
  check("signal.domain='beauty'", sig.domain === "beauty");
  check("signal.signal_type='maintenance_due'", sig.signal_type === "maintenance_due");
  check(
    "signal.dedupe_key formato correto",
    sig.dedupe_key === `beauty:maintenance_due:${anaId}:${svcColoracao}`,
  );
  check("signal.severity='attention'", sig.severity === "attention");
  check("signal.basis='fact'", sig.basis === "fact");
  check("signal.subject_type='contact'", sig.subject_type === "contact");
  check("signal.subject_id=ana", sig.subject_id === anaId);
  check("signal.source_entity_type='appointment'", sig.source_entity_type === "appointment");

  const ev = JSON.parse(sig.evidence_json);
  check("evidence.productServiceId=svcColoracao", ev.productServiceId === svcColoracao);
  check("evidence.serviceName='Coloração'", ev.serviceName === "Coloração");
  check("evidence.maintenanceDays=30", ev.maintenanceDays === 30);
  check("evidence.daysSinceLast >= 45", ev.daysSinceLast >= 45);
  check(
    "evidence.contactName=null (sem consent comunicacoes)",
    ev.contactName === null,
  );

  // ===== 3. Consent comunicacoes → contactName aparece =====
  LgpdService.grantConsent(orgA, anaId, "comunicacoes");
  BeautyMaintenanceDetector.sweep(orgA);
  const sig2 = db.prepare(`SELECT evidence_json FROM business_signals WHERE dedupe_key=?`).get(sig.dedupe_key) as any;
  check(
    "após consent comunicacoes → evidence.contactName='Ana'",
    JSON.parse(sig2.evidence_json).contactName === "Ana",
  );

  // ===== 4. Dedupe idempotente =====
  const second = BeautyMaintenanceDetector.sweep(orgA);
  check("segunda sweep detected=0", second.detected === 0);
  check("segunda sweep deduped=1", second.deduped === 1);
  check(
    "total de sinais permanece 1",
    (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE dedupe_key=?`).get(sig.dedupe_key) as any).c === 1,
  );

  // ===== 5. Serviço COM appointment FUTURO do mesmo par → NÃO publica =====
  const biaId = seedContact(orgA, "Bia");
  seedAppt(orgA, biaId, svcColoracao, daysAgo(45)); // passado > janela
  seedAppt(orgA, biaId, svcColoracao, daysFromNow(3)); // futuro — deve suprimir
  const sw3 = BeautyMaintenanceDetector.sweep(orgA);
  const sigBia = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE dedupe_key=?`)
    .get(`beauty:maintenance_due:${biaId}:${svcColoracao}`) as any;
  check(
    "par (contato, serviço) com appointment FUTURO → NÃO publica",
    sigBia.c === 0,
  );

  // ===== 6. Serviço sem maintenance_days NULL → NÃO publica =====
  const svcSemJanela = seedService(orgA, "Escova", { maintenanceDays: null });
  const carlaId = seedContact(orgA, "Carla");
  seedAppt(orgA, carlaId, svcSemJanela, daysAgo(90));
  BeautyMaintenanceDetector.sweep(orgA);
  const sigCarla = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE subject_id=? AND signal_type='maintenance_due'`)
    .get(carlaId) as any;
  check(
    "serviço sem maintenance_days → NÃO publica",
    sigCarla.c === 0,
  );

  // ===== 7. Dentro da janela → NÃO publica =====
  const svcLonga = seedService(orgA, "Alisamento", { maintenanceDays: 90 });
  const denId = seedContact(orgA, "Denise");
  seedAppt(orgA, denId, svcLonga, daysAgo(30)); // dentro dos 90d
  BeautyMaintenanceDetector.sweep(orgA);
  const sigDen = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE subject_id=? AND signal_type='maintenance_due'`)
    .get(denId) as any;
  check(
    "appointment dentro da janela (30d < 90d) → NÃO publica",
    sigDen.c === 0,
  );

  // ===== 8. Status cancelled/no_show ignorado =====
  const elzaId = seedContact(orgA, "Elza");
  seedAppt(orgA, elzaId, svcColoracao, daysAgo(45), "cancelled");
  seedAppt(orgA, elzaId, svcColoracao, daysAgo(45), "no_show");
  BeautyMaintenanceDetector.sweep(orgA);
  const sigElza = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE subject_id=?`)
    .get(elzaId) as any;
  check(
    "appointments cancelled/no_show → detector ignora → não publica",
    sigElza.c === 0,
  );

  // ===== 9. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  BeautyMaintenanceDetector.setEnabled(orgB, true);
  const svcB = seedService(orgB, "Corte B", { maintenanceDays: 30 });
  const gabB = seedContact(orgB, "Gabi");
  seedAppt(orgB, gabB, svcB, daysAgo(45));
  const beforeB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  // sweep orgA NÃO cria sinal em orgB
  BeautyMaintenanceDetector.sweep(orgA);
  const afterB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  check("sweep de orgA NÃO cria sinal em orgB", beforeB === afterB);
  const sweepB = BeautyMaintenanceDetector.sweep(orgB);
  check("sweep de orgB detecta suas próprias", sweepB.detected === 1);

  // ===== 10. pass() ignora flag OFF =====
  const orgC = seedOrg("Salão C"); // flag OFF
  const helC = seedContact(orgC, "Helena");
  const svcC = seedService(orgC, "Serviço C", { maintenanceDays: 30 });
  seedAppt(orgC, helC, svcC, daysAgo(45));
  BeautyMaintenanceDetector.pass();
  const sigC = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgC) as any).c;
  check("pass() NÃO detecta orgC (flag OFF)", sigC === 0);

  // ===== 11. Zero hardcoded Studio Márcia =====
  const forbiddenNeedles = [
    "studio_marcia",
    "studio de beleza márcia",
    "marcia_studio",
    "\"marcia\"",
    "'marcia'",
  ];
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
  console.log("\n=== TEST: Detector de manutenção beauty (ADR-169 F12 / BEAUTY-013) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Detector de manutenção publica sinal na espinha canônica com dedupe — segundo tijolo do Beauty Autopilot.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
