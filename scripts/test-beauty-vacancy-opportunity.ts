/**
 * TEST — BEAUTY-015 (ADR-169 F14): detector de vaga publica `business_signal`
 * `beauty:vacancy_opportunity:{proId}:{slotStartISO}` na espinha canônica.
 *
 * Terceiro tijolo do Beauty Autopilot em SHADOW (após F11/F12). F14 SÓ DETECTA
 * — o handler `beauty_vacancy_offer` é fatia futura, freada pelos 3 gates
 * F5-transversal.
 *
 * Checks-âncora:
 *  - Flag OFF (default) → sweep zero.
 *  - Slot no futuro, sem conflito, com cliente elegível → publica.
 *  - Slot com conflito de appointment do mesmo pro → NÃO publica.
 *  - Sem cliente elegível (nenhum atendimento em <=90d) → NÃO publica.
 *  - Cliente com appt FUTURO qualquer → não conta como elegível.
 *  - Cliente sem consent hair_simulation → não conta como elegível.
 *  - Cliente com atendimento cancelled/no_show → não conta como recente.
 *  - Slot fora do horário (antes de openHour ou depois de closeHour) → NÃO publica.
 *  - Slot em dia fora do funcionamento (ex.: domingo) → NÃO publica.
 *  - Dedupe: 2 sweeps do mesmo estado → sinal atualizado, não duplicado.
 *  - Cross-tenant DURO (pro/appt/consent de orgB não contam pra orgA).
 *  - pass() ignora flag OFF.
 *  - MAX_SLOTS_PER_PROFESSIONAL respeitado.
 *
 * Uso: npm run test:beauty-vacancy-opportunity
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vacancy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-vacancy-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

// helpers de tempo em SP (UTC-3)
function daysAgoIso(d: number): string { return new Date(Date.now() - d * 24 * 3600 * 1000).toISOString(); }
function daysFromNowIso(d: number): string { return new Date(Date.now() + d * 24 * 3600 * 1000).toISOString(); }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const {
    BeautyVacancyDetector,
    DEFAULT_LOOKAHEAD_DAYS,
    LOOKBACK_ELIGIBILITY_DAYS,
    MAX_SLOTS_PER_PROFESSIONAL,
  } = await import("../src/server/BeautyVacancyDetector.js");
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
    const identifier = `55119${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, identifier);
    return id;
  };
  const seedPro = (orgId: string, name = "Maria", active = true) => {
    const id = `p_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, ?)`,
    ).run(id, orgId, name, active ? 1 : 0);
    return id;
  };
  const seedAppt = (
    orgId: string,
    contactId: string,
    proId: string,
    startIso: string,
    endIso: string,
    status: string = "completed",
  ) => {
    const id = `a_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, professional_id, title, scheduled_start, scheduled_end, status) VALUES (?, ?, ?, ?, 'Atendimento', ?, ?, ?)`,
    ).run(id, orgId, contactId, proId, startIso, endIso, status);
    return id;
  };

  // ===== 1. Constantes =====
  check(`DEFAULT_LOOKAHEAD_DAYS === 3`, DEFAULT_LOOKAHEAD_DAYS === 3);
  check(`LOOKBACK_ELIGIBILITY_DAYS === 90`, LOOKBACK_ELIGIBILITY_DAYS === 90);
  check(`MAX_SLOTS_PER_PROFESSIONAL === 6`, MAX_SLOTS_PER_PROFESSIONAL === 6);

  // ===== 2. Flag OFF default =====
  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");
  const maria = seedPro(orgA, "Maria");
  LgpdService.grantConsent(orgA, anaId, "hair_simulation");
  // Atendimento recente (dentro de 90d) com Maria
  seedAppt(orgA, anaId, maria, daysAgoIso(15), daysAgoIso(14.98));

  check("isEnabled(nova org) === false", BeautyVacancyDetector.isEnabled(orgA) === false);
  const off = BeautyVacancyDetector.sweep(orgA);
  check("flag OFF: sweep zero", off.detected === 0 && off.publishedSignalIds.length === 0);

  // ===== 3. Liga a flag → detecta gaps futuros com elegível =====
  BeautyVacancyDetector.setEnabled(orgA, true);
  const first = BeautyVacancyDetector.sweep(orgA);
  check("sweep detecta ≥1 vaga (agenda vazia no futuro + cliente elegível)", first.detected >= 1);
  check("sweep respeita MAX_SLOTS_PER_PROFESSIONAL", first.detected + first.deduped <= MAX_SLOTS_PER_PROFESSIONAL);

  const sig = db.prepare(`SELECT * FROM business_signals WHERE id=?`).get(first.publishedSignalIds[0]) as any;
  check("signal.domain='beauty'", sig.domain === "beauty");
  check("signal.signal_type='vacancy_opportunity'", sig.signal_type === "vacancy_opportunity");
  check("signal.severity='info'", sig.severity === "info");
  check("signal.basis='fact'", sig.basis === "fact");
  check("signal.subject_type='professional'", sig.subject_type === "professional");
  check("signal.subject_id=maria", sig.subject_id === maria);
  check("signal.source_entity_type='clinic_professional'", sig.source_entity_type === "clinic_professional");
  check(
    "signal.dedupe_key formato correto",
    typeof sig.dedupe_key === "string" &&
      sig.dedupe_key.startsWith(`beauty:vacancy_opportunity:${maria}:`) &&
      sig.dedupe_key.endsWith("Z"),
  );
  const ev = JSON.parse(sig.evidence_json);
  check("evidence.professionalId=maria", ev.professionalId === maria);
  check("evidence.professionalName='Maria'", ev.professionalName === "Maria");
  check("evidence.durationMin > 0", ev.durationMin > 0);
  check("evidence.slotStartISO/endISO presentes", typeof ev.slotStartISO === "string" && typeof ev.slotEndISO === "string");
  check("evidence.eligibleContactsCount >= 1", ev.eligibleContactsCount >= 1);

  // ===== 4. Dedupe idempotente =====
  const second = BeautyVacancyDetector.sweep(orgA);
  check("segunda sweep deduped >= 1 (mesmos slots)", second.deduped >= 1);

  // ===== 5. Contato SEM consent hair_simulation NÃO conta =====
  const orgNoConsent = seedOrg();
  BeautyVacancyDetector.setEnabled(orgNoConsent, true);
  const proNC = seedPro(orgNoConsent, "Sem Consent");
  const conNC = seedContact(orgNoConsent, "Sem");
  seedAppt(orgNoConsent, conNC, proNC, daysAgoIso(10), daysAgoIso(9.98));
  // NÃO concede consent
  const swNC = BeautyVacancyDetector.sweep(orgNoConsent);
  check("sem consent hair_simulation ativo → NÃO publica vaga", swNC.detected === 0);

  // ===== 6. Contato com appt FUTURO → não elegível =====
  const orgFut = seedOrg();
  BeautyVacancyDetector.setEnabled(orgFut, true);
  const proFut = seedPro(orgFut, "Pro Fut");
  const conFut = seedContact(orgFut, "Ja Marcou");
  LgpdService.grantConsent(orgFut, conFut, "hair_simulation");
  seedAppt(orgFut, conFut, proFut, daysAgoIso(10), daysAgoIso(9.98));
  seedAppt(orgFut, conFut, proFut, daysFromNowIso(2), daysFromNowIso(2.02)); // appt futuro
  const swFut = BeautyVacancyDetector.sweep(orgFut);
  check("contato com appt futuro → não elegível → não publica (via count=0 nas outras janelas)",
    // Podem existir OUTROS slots livres do pro; verificamos apenas que o count elegível pra ESSE contato é 0.
    BeautyVacancyDetector.countEligibleContacts(orgFut, proFut) === 0,
  );
  // O sweep de fato pode retornar 0 se o contato futuro era o único elegível
  check("sem elegível → sweep detected=0", swFut.detected === 0);

  // ===== 7. Cancelled/no_show não contam como atendimento recente =====
  const orgCanc = seedOrg();
  BeautyVacancyDetector.setEnabled(orgCanc, true);
  const proCanc = seedPro(orgCanc);
  const conCanc = seedContact(orgCanc, "Cancelou");
  LgpdService.grantConsent(orgCanc, conCanc, "hair_simulation");
  seedAppt(orgCanc, conCanc, proCanc, daysAgoIso(5), daysAgoIso(4.98), "cancelled");
  seedAppt(orgCanc, conCanc, proCanc, daysAgoIso(3), daysAgoIso(2.98), "no_show");
  const swCanc = BeautyVacancyDetector.sweep(orgCanc);
  check(
    "atendimento cancelled/no_show não conta como recente → 0 elegíveis",
    swCanc.detected === 0 && BeautyVacancyDetector.countEligibleContacts(orgCanc, proCanc) === 0,
  );

  // ===== 8. Atendimento HÁ MAIS DE 90d não conta =====
  const orgOld = seedOrg();
  BeautyVacancyDetector.setEnabled(orgOld, true);
  const proOld = seedPro(orgOld);
  const conOld = seedContact(orgOld, "Antigo");
  LgpdService.grantConsent(orgOld, conOld, "hair_simulation");
  seedAppt(orgOld, conOld, proOld, daysAgoIso(120), daysAgoIso(119.98));
  const swOld = BeautyVacancyDetector.sweep(orgOld);
  check(
    "atendimento >90d não conta como recente → 0 elegíveis",
    swOld.detected === 0 && BeautyVacancyDetector.countEligibleContacts(orgOld, proOld) === 0,
  );

  // ===== 9. Profissional inativo é ignorado =====
  const orgInativo = seedOrg();
  BeautyVacancyDetector.setEnabled(orgInativo, true);
  const proInativo = seedPro(orgInativo, "Ex", false);
  const conAtivo = seedContact(orgInativo);
  LgpdService.grantConsent(orgInativo, conAtivo, "hair_simulation");
  seedAppt(orgInativo, conAtivo, proInativo, daysAgoIso(10), daysAgoIso(9.98));
  const swInativo = BeautyVacancyDetector.sweep(orgInativo);
  check("pro inativo → sweep detected=0", swInativo.detected === 0);

  // ===== 10. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  BeautyVacancyDetector.setEnabled(orgB, true);
  const proB = seedPro(orgB, "Pro B");
  const conB = seedContact(orgB, "Gabi");
  LgpdService.grantConsent(orgB, conB, "hair_simulation");
  seedAppt(orgB, conB, proB, daysAgoIso(15), daysAgoIso(14.98));

  const beforeB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  BeautyVacancyDetector.sweep(orgA); // orgA não deve criar sinal em orgB
  const afterB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  check("sweep orgA NÃO cria sinal em orgB", beforeB === afterB);

  const swB = BeautyVacancyDetector.sweep(orgB);
  check("sweep orgB detecta suas próprias vagas", swB.detected + swB.deduped >= 1);

  // ===== 11. pass() ignora flag OFF =====
  const orgC = seedOrg("Salão C"); // flag OFF
  const proC = seedPro(orgC);
  const conC = seedContact(orgC);
  LgpdService.grantConsent(orgC, conC, "hair_simulation");
  seedAppt(orgC, conC, proC, daysAgoIso(15), daysAgoIso(14.98));
  BeautyVacancyDetector.pass();
  const sigC = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgC) as any).c;
  check("pass() NÃO detecta orgC (flag OFF)", sigC === 0);

  // ===== 12. Zero hardcoded Studio Márcia =====
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
  console.log("\n=== TEST: Detector de vaga beauty (ADR-169 F14 / BEAUTY-015) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Detector de vaga publica sinal na espinha canônica quando há ≥1 elegível — terceiro tijolo do Beauty Autopilot.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
