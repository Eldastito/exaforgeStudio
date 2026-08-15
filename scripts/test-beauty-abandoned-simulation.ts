/**
 * TEST — BEAUTY-012 (ADR-169 F11): detector de simulação abandonada publica
 * na espinha canônica (`business_signals`) com dedupe.
 *
 * Primeiro tijolo do Beauty Autopilot em SHADOW. A F11 SÓ DETECTA — a fatia
 * futura F11-B "propor follow-up" passa por DecisionAction+ApprovalPolicy
 * (RN-BS-12: autopilot nunca vai direto pra GA) e será freada pelos 3 guards
 * da F5-transversal antes de disparar mensagem.
 *
 * Checks-âncora:
 *  - Flag OFF (default) → sweep retorna zero sem varrer.
 *  - Consulta 'ready' com sim SUCCEEDED > 24h sem select → publica.
 *  - Consulta 'ready' recente (< 24h) → NÃO publica.
 *  - Consulta com apenas sim PROCESSING/FAILED_FINAL → NÃO publica (só SUCCEEDED).
 *  - Consulta 'selected' → NÃO publica.
 *  - Consulta 'scheduled' → NÃO publica.
 *  - Dedupe: 2 sweeps do mesmo estado → 1 sinal atualizado, não 2.
 *  - Signal domain='beauty', signalType='abandoned_simulation',
 *    dedupeKey='beauty:abandoned_simulation:{consultationId}'.
 *  - Consent hair_simulation revogado após a sim → NÃO publica (leitura live).
 *  - Consent comunicacoes ativo → contactName no evidence; sem consent → null.
 *  - Cross-tenant DURO.
 *  - pass() varre todas as orgs habilitadas, ignora as não habilitadas.
 *  - setAfterHours custom respeitado; null volta ao default.
 *
 * Uso: npm run test:beauty-abandoned-simulation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-abandoned-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-abandoned-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const {
    AbandonedBeautySimulationDetector,
    ABANDONED_DEFAULT_AFTER_HOURS,
  } = await import("../src/server/AbandonedBeautySimulationDetector.js");
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
  const seedConsult = (
    orgId: string,
    contactId: string,
    status: string,
    createdAt: Date,
    selectedAt: Date | null = null,
  ) => {
    const id = `bv_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO beauty_visual_consultations (id, organization_id, contact_id, status, goal, selected_at, created_at)
       VALUES (?, ?, ?, ?, 'mechas', ?, ?)`,
    ).run(id, orgId, contactId, status, selectedAt ? selectedAt.toISOString() : null, createdAt.toISOString());
    return id;
  };
  const seedSim = (
    orgId: string,
    consultId: string,
    status: string,
  ) => {
    const id = `bs_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO beauty_visual_simulations
        (id, organization_id, consultation_id, avatar_id, simulation_type, provider_key, input_hash, status, completed_at)
       VALUES (?, ?, ?, 'av_x', 'color', 'stub', ?, ?, CURRENT_TIMESTAMP)`,
    ).run(id, orgId, consultId, `hash_${id}`, status);
    return id;
  };

  // ===== 1. Constantes =====
  check(
    "ABANDONED_DEFAULT_AFTER_HOURS === 24",
    ABANDONED_DEFAULT_AFTER_HOURS === 24,
  );

  // ===== 2. Flag OFF default (0-regressão) =====
  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");
  LgpdService.grantConsent(orgA, anaId, "hair_simulation");
  const consAntiga = seedConsult(orgA, anaId, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgA, consAntiga, "SUCCEEDED");

  check(
    "isEnabled(nova org) === false",
    AbandonedBeautySimulationDetector.isEnabled(orgA) === false,
  );
  const off = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "flag OFF: sweep retorna zero (detected=0, deduped=0)",
    off.detected === 0 && off.deduped === 0 && off.publishedSignalIds.length === 0,
  );
  const sigCountAfterOff = (
    db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='beauty'`).get(orgA) as any
  ).c;
  check("flag OFF: NÃO publicou sinal", sigCountAfterOff === 0);

  // ===== 3. Liga flag → detecta =====
  AbandonedBeautySimulationDetector.setEnabled(orgA, true);
  check(
    "setEnabled(true) → isEnabled=true",
    AbandonedBeautySimulationDetector.isEnabled(orgA) === true,
  );
  check(
    "effectiveAfterHours sem custom → 24",
    AbandonedBeautySimulationDetector.effectiveAfterHours(orgA) === 24,
  );

  const first = AbandonedBeautySimulationDetector.sweep(orgA);
  check("primeira sweep detecta 1", first.detected === 1);
  check("publishedSignalIds tem 1 id", first.publishedSignalIds.length === 1);

  const sig = db
    .prepare(`SELECT * FROM business_signals WHERE id = ?`)
    .get(first.publishedSignalIds[0]) as any;
  check("signal.domain === 'beauty'", sig.domain === "beauty");
  check("signal.signal_type === 'abandoned_simulation'", sig.signal_type === "abandoned_simulation");
  check(
    "signal.dedupe_key formato correto",
    sig.dedupe_key === `beauty:abandoned_simulation:${consAntiga}`,
  );
  check("signal.severity === 'attention'", sig.severity === "attention");
  check("signal.basis === 'fact'", sig.basis === "fact");
  check("signal.status === 'open'", sig.status === "open");
  check("signal.source_entity_type === 'beauty_visual_consultation'", sig.source_entity_type === "beauty_visual_consultation");
  check("signal.source_entity_id === consultationId", sig.source_entity_id === consAntiga);
  check("signal.subject_type === 'contact'", sig.subject_type === "contact");
  check("signal.subject_id === contactId (ana)", sig.subject_id === anaId);

  const ev = JSON.parse(sig.evidence_json);
  check("evidence.consultationId presente", ev.consultationId === consAntiga);
  check("evidence.contactId presente", ev.contactId === anaId);
  check("evidence.simulationId presente (aponta pra sim SUCCEEDED)", typeof ev.simulationId === "string" && ev.simulationId.startsWith("bs_"));
  check("evidence.goal === 'mechas'", ev.goal === "mechas");
  check("evidence.hoursSinceCreation >= 48", ev.hoursSinceCreation >= 48);
  check(
    "evidence.contactName === null (sem consent comunicacoes ainda)",
    ev.contactName === null,
  );

  // ===== 4. Dedupe: sweep de novo, MESMO sinal atualizado (não dobra) =====
  const second = AbandonedBeautySimulationDetector.sweep(orgA);
  check("segunda sweep detected=0", second.detected === 0);
  check("segunda sweep deduped=1", second.deduped === 1);
  const sigCount = (
    db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='beauty' AND signal_type='abandoned_simulation'`).get(orgA) as any
  ).c;
  check("total de sinais permanece 1 (idempotência)", sigCount === 1);

  // ===== 5. Consent comunicacoes ativo → contactName aparece =====
  LgpdService.grantConsent(orgA, anaId, "comunicacoes");
  AbandonedBeautySimulationDetector.sweep(orgA); // re-publish (deduped)
  const sig2 = db.prepare(`SELECT evidence_json FROM business_signals WHERE dedupe_key = ?`)
    .get(`beauty:abandoned_simulation:${consAntiga}`) as any;
  const ev2 = JSON.parse(sig2.evidence_json);
  check(
    "após consent comunicacoes → evidence.contactName='Ana'",
    ev2.contactName === "Ana",
  );

  // ===== 6. Consulta recente (< 24h) NÃO detecta =====
  const biaId = seedContact(orgA, "Bia");
  LgpdService.grantConsent(orgA, biaId, "hair_simulation");
  const consRecente = seedConsult(orgA, biaId, "ready", new Date(Date.now() - 3 * 3600 * 1000));
  seedSim(orgA, consRecente, "SUCCEEDED");
  const sweep3 = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "consulta recente (<24h) NÃO gera sinal novo",
    sweep3.detected === 0,
  );
  const sigCountBia = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE dedupe_key=?`)
    .get(`beauty:abandoned_simulation:${consRecente}`) as any).c;
  check("nenhum sinal pra consulta recente", sigCountBia === 0);

  // ===== 7. Consulta com sim PROCESSING (sem SUCCEEDED) NÃO detecta =====
  const carlaId = seedContact(orgA, "Carla");
  LgpdService.grantConsent(orgA, carlaId, "hair_simulation");
  const consProc = seedConsult(orgA, carlaId, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgA, consProc, "PROCESSING");
  const sweep4 = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "consulta com sim PROCESSING (sem SUCCEEDED) → não detecta",
    sweep4.detected === 0,
  );

  // ===== 8. Consulta FAILED_FINAL (sem SUCCEEDED) NÃO detecta =====
  const denId = seedContact(orgA, "Denise");
  LgpdService.grantConsent(orgA, denId, "hair_simulation");
  const consFail = seedConsult(orgA, denId, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgA, consFail, "FAILED_FINAL");
  const sweep5 = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "consulta com sim FAILED_FINAL (sem SUCCEEDED) → não detecta",
    sweep5.detected === 0,
  );

  // ===== 9. Consultas 'selected' e 'scheduled' NÃO detectam =====
  const elzaId = seedContact(orgA, "Elza");
  LgpdService.grantConsent(orgA, elzaId, "hair_simulation");
  const consSel = seedConsult(orgA, elzaId, "selected", new Date(Date.now() - 48 * 3600 * 1000), new Date(Date.now() - 24 * 3600 * 1000));
  seedSim(orgA, consSel, "SUCCEEDED");
  const consSch = seedConsult(orgA, elzaId, "scheduled", new Date(Date.now() - 48 * 3600 * 1000), new Date(Date.now() - 24 * 3600 * 1000));
  seedSim(orgA, consSch, "SUCCEEDED");
  const sweep6 = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "consulta 'selected'/'scheduled' NÃO detecta (0 novos)",
    sweep6.detected === 0,
  );

  // ===== 10. Consent hair_simulation REVOGADO → NÃO publica novo =====
  const felId = seedContact(orgA, "Fernanda");
  LgpdService.grantConsent(orgA, felId, "hair_simulation");
  const consFel = seedConsult(orgA, felId, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgA, consFel, "SUCCEEDED");
  LgpdService.revokeConsent(orgA, felId, "hair_simulation");
  const sweep7 = AbandonedBeautySimulationDetector.sweep(orgA);
  check(
    "consent hair_simulation revogado → skipped_consent_revoked=1",
    sweep7.skipped_consent_revoked === 1,
  );
  check(
    "consent revogado → sinal NÃO publicado",
    sweep7.detected === 0,
  );

  // ===== 11. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  AbandonedBeautySimulationDetector.setEnabled(orgB, true);
  const gabB = seedContact(orgB, "Gabi");
  LgpdService.grantConsent(orgB, gabB, "hair_simulation");
  const consBAntiga = seedConsult(orgB, gabB, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgB, consBAntiga, "SUCCEEDED");
  // sweep orgA NÃO gera sinal pra orgB
  const beforeB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  AbandonedBeautySimulationDetector.sweep(orgA);
  const afterB = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=?`).get(orgB) as any).c;
  check("sweep de orgA NÃO cria sinal em orgB", beforeB === afterB);
  const sweepB = AbandonedBeautySimulationDetector.sweep(orgB);
  check("sweep de orgB detecta consulta da orgB", sweepB.detected === 1);
  const sigOnlyB = (
    db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND signal_type='abandoned_simulation'`).get(orgB) as any
  ).c;
  check("orgB tem exatamente 1 sinal abandoned", sigOnlyB === 1);

  // ===== 12. pass() varre todas orgs habilitadas =====
  const orgC = seedOrg("Salão C"); // flag OFF
  const helC = seedContact(orgC, "Helena");
  LgpdService.grantConsent(orgC, helC, "hair_simulation");
  const consCAntiga = seedConsult(orgC, helC, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgC, consCAntiga, "SUCCEEDED");
  AbandonedBeautySimulationDetector.pass();
  const sigCountC = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND signal_type='abandoned_simulation'`).get(orgC) as any).c;
  check(
    "pass() NÃO detecta orgC (flag OFF, 0-regressão)",
    sigCountC === 0,
  );

  // ===== 13. Custom after hours =====
  AbandonedBeautySimulationDetector.setAfterHours(orgA, 72);
  check("effectiveAfterHours custom = 72", AbandonedBeautySimulationDetector.effectiveAfterHours(orgA) === 72);
  // Consulta de 48h atrás agora NÃO é abandonada (janela custom = 72h)
  const iviId = seedContact(orgA, "Ivi");
  LgpdService.grantConsent(orgA, iviId, "hair_simulation");
  const consIvi = seedConsult(orgA, iviId, "ready", new Date(Date.now() - 48 * 3600 * 1000));
  seedSim(orgA, consIvi, "SUCCEEDED");
  const sweep8 = AbandonedBeautySimulationDetector.sweep(orgA);
  // A consulta antiga do início continua > 72h? nao, era 48h. Deve ter 0 novos.
  const sigCountIvi = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE dedupe_key=?`).get(`beauty:abandoned_simulation:${consIvi}`) as any).c;
  check(
    "custom 72h: consulta de 48h NÃO detecta (fora da janela)",
    sigCountIvi === 0,
  );
  // Volta ao default
  AbandonedBeautySimulationDetector.setAfterHours(orgA, null);
  check(
    "setAfterHours(null) volta ao default 24",
    AbandonedBeautySimulationDetector.effectiveAfterHours(orgA) === 24,
  );

  let threwInvalid = false;
  try { AbandonedBeautySimulationDetector.setAfterHours(orgA, 0); } catch { threwInvalid = true; }
  check("setAfterHours(0) lança (≥1 requerido)", threwInvalid);

  // ===== 14. Zero hardcoded Studio Márcia =====
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
  console.log("\n=== TEST: Detector de simulação abandonada (ADR-169 F11 / BEAUTY-012) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Detector publica na espinha canônica (business_signals) com dedupe — pronto pra Beauty Autopilot em shadow.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
