/**
 * TEST — BEAUTY-011c (ADR-169 F5-transversal-C): cap de frequência transversal
 * no SINK canônico `MessageProviderService.sendMessage`.
 *
 * Terceiro guard no MESMO sink, depois de consent (F5-A) e quiet-hours (F5-B).
 * Prova o freio anti-spam: se um contato já recebeu N mensagens do sistema
 * na última janela de H horas, o próximo envio é RECUSADO — cobre "várias
 * regras disparando pra mesma pessoa em sequência".
 *
 * Checks-âncora:
 *  - Flag OFF (default) → SEMPRE PERMITE + NÃO REGISTRA (não suja o log).
 *  - Flag ON: 0..N-1 envios permitem; o Nº bloqueia.
 *  - Janela: envio antigo (fora de H horas) NÃO conta.
 *  - Cap custom respeitado; null volta ao default (3, 24h).
 *  - Cross-tenant: log da orgB não conta pra orgA.
 *  - Unknown contact: permite e NÃO registra (comunicação de sistema).
 *  - OutboundFrequencyCapError shape correto (code/name/used/cap/windowHours).
 *  - Integração REAL: sendMessage bloqueia após atingir o cap.
 *  - Read-only: evaluate NÃO grava; record grava só quando allow.
 *
 * Uso: npm run test:beauty-frequency-cap-transversal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-freqcap-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-freqcap-1234567890abcdef";

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
    ClientFrequencyCapGuardService,
    OutboundFrequencyCapError,
    CLIENT_FREQ_DEFAULT_MAX,
    CLIENT_FREQ_DEFAULT_WINDOW_HOURS,
  } = await import("../src/server/ClientFrequencyCapGuardService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  const seedOrg = (name = "Salão X") => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`,
    ).run(randomUUID(), orgId, name);
    return orgId;
  };
  const seedContact = (orgId: string, name: string, identifier: string) => {
    const id = `c_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, identifier);
    return id;
  };
  const seedChannel = (orgId: string) => {
    const id = `chn_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, name, provider, identifier, token_encrypted, status) VALUES (?, ?, 'canal', 'whatsapp_cloud', '5511999999999', 'dummy', 'active')`,
    ).run(id, orgId);
    return id;
  };
  // Insere linha direto no log (simula envios passados sem passar pelo sink)
  const seedSentLog = (orgId: string, contactId: string, sentAt: Date) => {
    db.prepare(
      `INSERT INTO outbound_send_log (id, organization_id, contact_id, sent_at) VALUES (?, ?, ?, ?)`,
    ).run(randomUUID(), orgId, contactId, sentAt.toISOString());
  };

  // ===== 1. Constantes =====
  check(`CLIENT_FREQ_DEFAULT_MAX === 3`, CLIENT_FREQ_DEFAULT_MAX === 3);
  check(`CLIENT_FREQ_DEFAULT_WINDOW_HOURS === 24`, CLIENT_FREQ_DEFAULT_WINDOW_HOURS === 24);

  // ===== 2. Flag OFF default (0-regressão) =====
  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana", "5511911111111");
  check(
    "isEnabled(nova org) === false (default 0-regressão)",
    ClientFrequencyCapGuardService.isEnabled(orgA) === false,
  );
  // Mesmo com log cheio, flag OFF → permite
  for (let i = 0; i < 10; i++) seedSentLog(orgA, anaId, new Date());
  const decOff = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check(
    "flag OFF + log cheio → allow=true, reason='flag_off'",
    decOff.allow === true && (decOff as any).reason === "flag_off",
  );

  // Record com flag OFF NÃO escreve (não suja o log)
  const beforeOff = (db.prepare(`SELECT COUNT(*) c FROM outbound_send_log WHERE contact_id=?`).get(anaId) as any).c;
  ClientFrequencyCapGuardService.record(orgA, "5511911111111");
  const afterOff = (db.prepare(`SELECT COUNT(*) c FROM outbound_send_log WHERE contact_id=?`).get(anaId) as any).c;
  check("record com flag OFF NÃO escreve (não suja o log)", beforeOff === afterOff);

  // Limpa log da Ana pros próximos testes
  db.prepare(`DELETE FROM outbound_send_log WHERE contact_id=?`).run(anaId);

  // ===== 3. Liga a flag → default 3/24h =====
  ClientFrequencyCapGuardService.setEnabled(orgA, true);
  check(
    "setEnabled(true) → isEnabled=true",
    ClientFrequencyCapGuardService.isEnabled(orgA) === true,
  );
  const eff = ClientFrequencyCapGuardService.effectiveParams(orgA);
  check(
    "effectiveParams sem custom → default 3/24h source=default",
    eff.max === 3 && eff.windowHours === 24 && eff.source === "default",
  );

  // 3 envios permitidos, 4º bloqueia
  for (let i = 0; i < 3; i++) {
    const d = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
    check(
      `envio #${i + 1} de 3 → allow=true (under_cap), used=${i}`,
      d.allow === true && (d as any).reason === "under_cap" && (d as any).used === i,
    );
    ClientFrequencyCapGuardService.record(orgA, "5511911111111");
  }
  const dBloq = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check(
    "envio #4 → allow=false, reason='cap_exceeded'",
    dBloq.allow === false && (dBloq as any).reason === "cap_exceeded",
  );
  check("bloqueio inclui used=3, cap=3, windowHours=24", (dBloq as any).used === 3 && (dBloq as any).cap === 3 && (dBloq as any).windowHours === 24);
  check("bloqueio inclui contactId=Ana", (dBloq as any).contactId === anaId);
  check("bloqueio inclui contactName='Ana'", (dBloq as any).contactName === "Ana");

  // ===== 4. Envio antigo (fora da janela) NÃO conta =====
  db.prepare(`DELETE FROM outbound_send_log WHERE contact_id=?`).run(anaId);
  // 3 envios de 25h atrás (fora da janela de 24h)
  const antigo = new Date(Date.now() - 25 * 3600 * 1000);
  for (let i = 0; i < 3; i++) seedSentLog(orgA, anaId, antigo);
  const decAntigo = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check(
    "3 envios de 25h atrás NÃO contam (fora da janela de 24h) → allow=true, used=0",
    decAntigo.allow === true && (decAntigo as any).used === 0,
  );

  // Envios recentes E antigos: só recentes contam
  db.prepare(`DELETE FROM outbound_send_log WHERE contact_id=?`).run(anaId);
  seedSentLog(orgA, anaId, new Date(Date.now() - 25 * 3600 * 1000));
  seedSentLog(orgA, anaId, new Date(Date.now() - 1 * 3600 * 1000));
  seedSentLog(orgA, anaId, new Date(Date.now() - 30 * 60 * 1000));
  const decMix = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check(
    "3 envios (1 antigo + 2 recentes) → used=2 (só recentes contam)",
    (decMix as any).used === 2 && decMix.allow === true,
  );

  // ===== 5. Custom params respeitados =====
  ClientFrequencyCapGuardService.setParams(orgA, { max: 1, windowHours: 1 });
  const eff2 = ClientFrequencyCapGuardService.effectiveParams(orgA);
  check(
    "setParams(1, 1) → source='custom', max=1, windowHours=1",
    eff2.max === 1 && eff2.windowHours === 1 && eff2.source === "custom",
  );

  // Limpa; 1 envio → 2º bloqueia
  db.prepare(`DELETE FROM outbound_send_log WHERE contact_id=?`).run(anaId);
  const d1st = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check("cap custom 1: envio #1 permite", d1st.allow === true);
  ClientFrequencyCapGuardService.record(orgA, "5511911111111");
  const d2nd = ClientFrequencyCapGuardService.evaluate(orgA, "5511911111111");
  check(
    "cap custom 1: envio #2 bloqueia",
    d2nd.allow === false && (d2nd as any).reason === "cap_exceeded",
  );

  // null volta ao default
  ClientFrequencyCapGuardService.setParams(orgA, { max: null, windowHours: null });
  const effBack = ClientFrequencyCapGuardService.effectiveParams(orgA);
  check(
    "setParams(null, null) → volta ao default 3/24h source=default",
    effBack.max === 3 && effBack.windowHours === 24 && effBack.source === "default",
  );

  // ===== 6. Validação =====
  let threwZero = false;
  try { ClientFrequencyCapGuardService.setParams(orgA, { max: 0 }); } catch { threwZero = true; }
  check("setParams(max=0) lança (≥1 requerido)", threwZero);
  let threwNegW = false;
  try { ClientFrequencyCapGuardService.setParams(orgA, { windowHours: -5 }); } catch { threwNegW = true; }
  check("setParams(windowHours=-5) lança", threwNegW);

  // ===== 7. Unknown contact =====
  const decUnknown = ClientFrequencyCapGuardService.evaluate(orgA, "5511999888777");
  check(
    "identifier sem contato → allow=true, reason='unknown_contact'",
    decUnknown.allow === true && (decUnknown as any).reason === "unknown_contact",
  );
  const beforeUnknown = (db.prepare(`SELECT COUNT(*) c FROM outbound_send_log WHERE organization_id=?`).get(orgA) as any).c;
  ClientFrequencyCapGuardService.record(orgA, "5511999888777");
  const afterUnknown = (db.prepare(`SELECT COUNT(*) c FROM outbound_send_log WHERE organization_id=?`).get(orgA) as any).c;
  check("record com identifier sem contato NÃO escreve", beforeUnknown === afterUnknown);

  // ===== 8. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  ClientFrequencyCapGuardService.setEnabled(orgB, true);
  const biaB = seedContact(orgB, "Bia", "5511922222222");
  // 5 envios pro contato da orgB
  for (let i = 0; i < 5; i++) seedSentLog(orgB, biaB, new Date());
  // orgA (mesmo identifier existir na orgA como contato "Ana") não vê log da orgB
  const decCrossA = ClientFrequencyCapGuardService.evaluate(orgA, "5511922222222");
  check(
    "cross-tenant: identifier orgB → orgA vê unknown_contact (isolamento)",
    decCrossA.allow === true && (decCrossA as any).reason === "unknown_contact",
  );
  const decCrossB = ClientFrequencyCapGuardService.evaluate(orgB, "5511922222222");
  check(
    "cross-tenant: orgB conta os 5 envios da orgB → bloqueia",
    decCrossB.allow === false && (decCrossB as any).used === 5,
  );

  // ===== 9. OutboundFrequencyCapError shape =====
  const e = new OutboundFrequencyCapError(3, 3, 24, { contactId: "c_x", contactName: "Ana" });
  check(
    "OutboundFrequencyCapError.code === 'outbound_blocked:frequency_cap'",
    e.code === "outbound_blocked:frequency_cap",
  );
  check(
    "OutboundFrequencyCapError.name === 'OutboundFrequencyCapError'",
    e.name === "OutboundFrequencyCapError",
  );
  check(
    "OutboundFrequencyCapError carrega used/cap/windowHours",
    e.used === 3 && e.cap === 3 && e.windowHours === 24,
  );
  check(
    "OutboundFrequencyCapError mensagem em pt-BR humana",
    e.message.includes("bloqueado") && e.message.includes("3/3") && e.message.includes("24h"),
  );

  // ===== 10. Integração REAL com sendMessage =====
  // Cria org limpa, liga cap com max=1 pra facilitar. NÃO liga quiet-hours nem consent
  // (queremos isolar o teste do freq guard).
  const orgReal = seedOrg();
  const chnReal = seedChannel(orgReal);
  const carlaReal = seedContact(orgReal, "Carla", "5511933333333");
  ClientFrequencyCapGuardService.setEnabled(orgReal, true);
  ClientFrequencyCapGuardService.setParams(orgReal, { max: 1, windowHours: 24 });
  // Seed 1 send anterior — próximo envio já está no cap
  seedSentLog(orgReal, carlaReal, new Date());

  let freqErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnReal, "5511933333333", "Oi Carla!");
  } catch (err: any) {
    freqErr = err;
  }
  check("sendMessage com cap atingido LANÇA erro", freqErr != null);
  check(
    "erro lançado é OutboundFrequencyCapError",
    freqErr && freqErr.name === "OutboundFrequencyCapError",
  );
  check(
    "erro.code === 'outbound_blocked:frequency_cap'",
    freqErr && freqErr.code === "outbound_blocked:frequency_cap",
  );

  // Flag OFF em outra org → passa direto do guard
  const orgOff = seedOrg();
  const chnOff = seedChannel(orgOff);
  seedContact(orgOff, "Denise", "5511944444444");
  let offErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnOff, "5511944444444", "Oi!");
  } catch (err: any) {
    offErr = err;
  }
  check(
    "orgOff com flag OFF: sendMessage NÃO lança OutboundFrequencyCapError (0-regressão)",
    !offErr || offErr.name !== "OutboundFrequencyCapError",
  );

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
  console.log("\n=== TEST: Frequency cap transversal no sink outbound (ADR-169 F5-transversal-C) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Gate de frequency cap ligado ao sink canônico — freio anti-spam automático, aditivo, opt-in.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
