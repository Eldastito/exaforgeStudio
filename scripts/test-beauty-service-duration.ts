/**
 * TEST — BEAUTY-004 parte 1 (ADR-169 F4): duração do serviço lida pela agenda.
 *
 * Prova que `AppointmentService.create` passa a calcular o `scheduled_end` pela
 * duração REAL do serviço (`products_services.duration_minutes`) quando um
 * `productServiceId` é passado — resolvendo o gap #1 da auditoria F0 (a coluna
 * era escrita pelo `POST /api/products` desde sempre mas IGNORADA pelos motores
 * de agenda; "corte = 45min" ia direto pro slot da org de 60min).
 *
 * Guardrails:
 *  1. Precedência: (a) `scheduledEnd` explícito do caller > (b) duração do
 *     serviço (F4) > (c) slot da org (fallback legado — 0-regressão).
 *  2. Multi-tenant duro: produto de OUTRA org é ignorado (cai no slot da org).
 *  3. `duration_minutes` NULL/0/negativo → cai no slot da org (RN-BS-11 nunca
 *     inventa; sem prova, usa o default).
 *  4. `serviceDurationMin` público: útil pra outros motores (fatias futuras).
 *  5. Regressão dura: fluxo antigo sem `productServiceId` continua funcionando
 *     idêntico (slot da org). Grava `product_service_id` no INSERT quando
 *     passado (comportamento pré-existente).
 *
 * Uso: npm run test:beauty-service-duration
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-dur-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-dur-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const { AppointmentService } = await import("../src/server/AppointmentService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, agenda_open_hour, agenda_close_hour, agenda_slot_minutes, agenda_days, agenda_capacity) VALUES (?, ?, 'X', 'active', 8, 18, 60, '1,2,3,4,5,6', 1)`,
    ).run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name = "Cliente") => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, `${orgId}:${id}`);
    return id;
  };
  const seedService = (orgId: string, name: string, durationMinutes: number | null) => {
    const id = `s_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, currency, active, duration_minutes) VALUES (?, ?, 'service', ?, '', 0, 'BRL', 1, ?)`,
    ).run(id, orgId, name, durationMinutes);
    return id;
  };
  const durationMinOf = (row: any): number => {
    const start = AppointmentService.ms(row.scheduled_start)!;
    const end = AppointmentService.ms(row.scheduled_end)!;
    return Math.round((end - start) / 60000);
  };

  // ===== 1. serviceDurationMin isolado =====
  const orgA = seedOrg();
  const corte = seedService(orgA, "Corte de cabelo", 45);
  const coloracao = seedService(orgA, "Coloração", 180);
  const semDur = seedService(orgA, "Serviço sem duração", null);
  const durZero = seedService(orgA, "Serviço duração zero", 0);
  const durNeg = seedService(orgA, "Serviço duração negativa", -30);
  const produto = seedProduct(db, orgA, "Shampoo (produto)", 60);

  check("serviceDurationMin(corte)=45", AppointmentService.serviceDurationMin(orgA, corte) === 45);
  check("serviceDurationMin(coloracao)=180", AppointmentService.serviceDurationMin(orgA, coloracao) === 180);
  check("serviceDurationMin(semDur)=null (duration_minutes NULL cai no fallback)", AppointmentService.serviceDurationMin(orgA, semDur) === null);
  check("serviceDurationMin(durZero)=null (0 é ignorado, RN-BS-11)", AppointmentService.serviceDurationMin(orgA, durZero) === null);
  check("serviceDurationMin(durNeg)=null (<0 é ignorado)", AppointmentService.serviceDurationMin(orgA, durNeg) === null);
  check("serviceDurationMin(produto físico)=60 (agnóstico ao type — read-only sobre products_services)",
    AppointmentService.serviceDurationMin(orgA, produto) === 60);
  check("serviceDurationMin(null)=null", AppointmentService.serviceDurationMin(orgA, null) === null);
  check("serviceDurationMin(undefined)=null", AppointmentService.serviceDurationMin(orgA, undefined) === null);

  // Multi-tenant duro
  const orgB = seedOrg();
  check("serviceDurationMin(orgA, servicoB)=null (produto de OUTRA org é ignorado)",
    AppointmentService.serviceDurationMin(orgB, corte) === null);

  // ===== 2. create() usa duração do serviço quando presente =====
  const contactA = seedContact(orgA, "Ana");

  const aptCorte = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Corte de cabelo — Ana",
    scheduledStart: "2026-03-10T14:00:00-03:00",
    productServiceId: corte,
  }, null);
  check("apt(corte) gravou product_service_id", aptCorte.product_service_id === corte);
  check("apt(corte) tem duração = 45min (não 60min do slot da org)",
    durationMinOf(aptCorte) === 45, `duração=${durationMinOf(aptCorte)}`);

  const aptColor = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Coloração — Ana",
    scheduledStart: "2026-03-11T14:00:00-03:00",
    productServiceId: coloracao,
  }, null);
  check("apt(coloração) tem duração = 180min",
    durationMinOf(aptColor) === 180, `duração=${durationMinOf(aptColor)}`);

  // ===== 3. Fallback: sem productServiceId, usa slot da org =====
  const aptSemServ = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Consulta sem serviço",
    scheduledStart: "2026-03-12T14:00:00-03:00",
  }, null);
  check("apt sem productServiceId usa slot da org (60min — 0-regressão)",
    durationMinOf(aptSemServ) === 60, `duração=${durationMinOf(aptSemServ)}`);
  check("apt sem productServiceId grava product_service_id=null", aptSemServ.product_service_id === null);

  // ===== 4. Fallback: serviço sem duration_minutes usa slot da org =====
  const aptSemDur = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Serviço sem duração",
    scheduledStart: "2026-03-13T14:00:00-03:00",
    productServiceId: semDur,
  }, null);
  check("apt(serviço sem duration_minutes) usa slot da org (60min)",
    durationMinOf(aptSemDur) === 60, `duração=${durationMinOf(aptSemDur)}`);
  check("apt(serviço sem duração) ainda grava product_service_id", aptSemDur.product_service_id === semDur);

  const aptDurZero = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Serviço duração 0",
    scheduledStart: "2026-03-14T14:00:00-03:00",
    productServiceId: durZero,
  }, null);
  check("apt(duration_minutes=0) usa slot da org (60min)",
    durationMinOf(aptDurZero) === 60);

  // ===== 5. scheduledEnd explícito TEM PRECEDÊNCIA sobre duração do serviço =====
  const aptCustomEnd = AppointmentService.create(orgA, {
    contactId: contactA,
    title: "Corte com fim explícito",
    scheduledStart: "2026-03-15T14:00:00-03:00",
    scheduledEnd: "2026-03-15T14:30:00-03:00",  // 30min, override do 45min do serviço
    productServiceId: corte,
  }, null);
  check("apt com scheduledEnd explícito USA o fim explícito (30min), mesmo com serviço de 45min",
    durationMinOf(aptCustomEnd) === 30, `duração=${durationMinOf(aptCustomEnd)}`);

  // ===== 6. Multi-tenant: produto de OUTRA org não afeta cálculo =====
  const contactB = seedContact(orgB, "Bia");
  const aptCross = AppointmentService.create(orgB, {
    contactId: contactB,
    title: "Fake beauty — Bia",
    scheduledStart: "2026-03-16T14:00:00-03:00",
    productServiceId: corte,  // <- serviço da orgA, passado pra orgB
  }, null);
  check("apt cross-tenant: productServiceId de orgA é ignorado por orgB — usa slot (60min)",
    durationMinOf(aptCross) === 60, `duração=${durationMinOf(aptCross)}`);
  // O INSERT ainda grava o id (o insert não valida cross-tenant, só o cálculo
  // da duração). Isso preserva a semântica pré-F4 do INSERT — só o SLOT muda.
  check("apt cross-tenant: product_service_id ainda foi gravado (não é FK enforced)",
    aptCross.product_service_id === corte);

  // ===== 7. Regressão do parque: slot custom da org =====
  const orgC = seedOrg();
  db.prepare(
    "UPDATE organization_settings SET agenda_slot_minutes = 90 WHERE organization_id = ?",
  ).run(orgC);
  const contactC = seedContact(orgC, "Cesar");
  const aptSlotCustom = AppointmentService.create(orgC, {
    contactId: contactC,
    title: "Sem serviço em org com slot 90",
    scheduledStart: "2026-03-17T14:00:00-03:00",
  }, null);
  check("apt sem serviço em org com slot=90 usa 90min",
    durationMinOf(aptSlotCustom) === 90, `duração=${durationMinOf(aptSlotCustom)}`);

  // ===== 8. Regressão: campos essenciais permanecem =====
  check("apt(corte).title preservado", aptCorte.title === "Corte de cabelo — Ana");
  check("apt(corte).contact_id preservado", aptCorte.contact_id === contactA);
  check("apt(corte).status default = pending", aptCorte.status === "pending");
  check("apt(corte).organization_id = orgA", aptCorte.organization_id === orgA);

  // --- Relatório ---
  console.log("\n=== TEST: Duração do serviço lida pela agenda (ADR-169 F4 / BEAUTY-004 parte 1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ AppointmentService.create passa a respeitar duration_minutes do serviço.");
}

function seedProduct(db: any, orgId: string, name: string, durationMinutes: number) {
  const id = `p_${(globalThis.crypto as any).randomUUID().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO products_services (id, organization_id, type, name, description, price, currency, active, duration_minutes) VALUES (?, ?, 'product', ?, '', 0, 'BRL', 1, ?)`,
  ).run(id, orgId, name, durationMinutes);
  return id;
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
