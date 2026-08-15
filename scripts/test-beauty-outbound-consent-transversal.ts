/**
 * TEST — BEAUTY-011a (ADR-169 F5-transversal-A): consent LGPD `comunicacoes`
 * como gate transversal no SINK canônico `MessageProviderService.sendMessage`.
 *
 * Prova o guardrail RN-BS-04 aplicado de forma UNIVERSAL: pra QUALQUER envio
 * outbound (WA Cloud, Evolution, Instagram, disparado por Cadence/Playbook/
 * Reminder/Radar/... — os 30+ callers de sendMessage no repo), quando o dono
 * liga `outbound_consent_required=1`, o guard consulta o consent do contato
 * ANTES do disparo. Sem consent → OutboundBlockedError com code tipado.
 *
 * Checks-âncora:
 *  - Flag OFF (default) → SEMPRE PERMITE (0-regressão dura pras 30+ callers).
 *  - Flag ON + contato sem consent → BLOQUEIA (throw OutboundBlockedError).
 *  - Flag ON + contato COM consent → PERMITE.
 *  - Flag ON + identifier sem contato cadastrado → PERMITE (comunicação de
 *    sistema; consent LGPD não se aplica).
 *  - Revoke consent APÓS grant → volta a bloquear (leitura live, não cache).
 *  - Cross-tenant DURO: consent da orgB NÃO libera envio da orgA.
 *  - OutboundBlockedError.code === "outbound_blocked:consent_missing".
 *  - Não escreve consent, não muta contact_consents, não cria signal (pure).
 *
 * NÃO fazemos fetch real de rede — o guard é a única coisa que roda antes.
 * Se o guard permite, o teste corta antes do provider fetchar (o teste NÃO
 * levanta um servidor mock; só valida a DECISÃO). Isso é OK: a lógica do
 * gate está isolada em OutboundConsentGuardService (testável puro).
 *
 * Uso: npm run test:beauty-outbound-consent-transversal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-outbound-consent-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-outbound-consent-1234567890abcdef";

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
    OutboundConsentGuardService,
    OutboundBlockedError,
    OUTBOUND_CONSENT_SCOPE,
  } = await import("../src/server/OutboundConsentGuardService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
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
  const seedChannel = (orgId: string, provider = "whatsapp_cloud", status = "active") => {
    const id = `chn_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, name, provider, identifier, token_encrypted, status) VALUES (?, ?, 'canal-teste', ?, '5511999999999', 'dummy-token', ?)`,
    ).run(id, orgId, provider, status);
    return id;
  };

  // ===== 1. Constantes =====
  check(
    "OUTBOUND_CONSENT_SCOPE === 'comunicacoes' (RN-BS-04, LgpdService default)",
    OUTBOUND_CONSENT_SCOPE === "comunicacoes",
  );

  // ===== 2. Flag padrão OFF =====
  const orgA = seedOrg("Salão A");
  check(
    "isEnabled(org sem flag ligada) → false (default 0-regressão)",
    OutboundConsentGuardService.isEnabled(orgA) === false,
  );

  const anaId = seedContact(orgA, "Ana", "5511911111111");
  const decOff = OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  check(
    "evaluate() com flag off → allow=true, reason='flag_off'",
    decOff.allow === true && (decOff as any).reason === "flag_off",
  );

  // Sem flag, um contato SEM consent também deve passar (0-regressão).
  const decOffSemConsent = OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  check(
    "evaluate() com flag off — mesmo contato sem consent → allow=true",
    decOffSemConsent.allow === true,
  );

  // ===== 3. Liga a flag =====
  OutboundConsentGuardService.setEnabled(orgA, true);
  check(
    "setEnabled(true) → isEnabled=true",
    OutboundConsentGuardService.isEnabled(orgA) === true,
  );

  // Sem consent → bloqueia
  const decBloq = OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  check(
    "evaluate() com flag ON + contato sem consent → allow=false",
    decBloq.allow === false,
  );
  check(
    "evaluate() bloqueia com reason='consent_missing'",
    (decBloq as any).reason === "consent_missing",
  );
  check(
    "evaluate() bloqueado inclui contactId + contactName",
    (decBloq as any).contactId === anaId && (decBloq as any).contactName === "Ana",
  );

  // ===== 4. Consent ativo → permite =====
  LgpdService.grantConsent(orgA, anaId, OUTBOUND_CONSENT_SCOPE);
  const decOk = OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  check(
    "evaluate() com consent 'comunicacoes' ativo → allow=true",
    decOk.allow === true && (decOk as any).reason === "consent_active",
  );

  // Outro escopo NÃO conta (RN-BS-04 escopos separados) — testa com contato NOVO
  const biaId = seedContact(orgA, "Bia", "5511922222222");
  LgpdService.grantConsent(orgA, biaId, "marketing");
  const decBia = OutboundConsentGuardService.evaluate(orgA, "5511922222222");
  check(
    "consent 'marketing' NÃO libera 'comunicacoes' (RN-BS-04 escopos separados)",
    decBia.allow === false && (decBia as any).reason === "consent_missing",
  );

  // ===== 5. Revoga → volta a bloquear (leitura live) =====
  LgpdService.revokeConsent(orgA, anaId, OUTBOUND_CONSENT_SCOPE);
  const decRevoke = OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  check(
    "após revokeConsent → volta a bloquear (leitura live, não cache)",
    decRevoke.allow === false && (decRevoke as any).reason === "consent_missing",
  );

  // ===== 6. Identifier sem contato → permite (sistema/broadcast) =====
  const decSemContact = OutboundConsentGuardService.evaluate(orgA, "5511999888777");
  check(
    "evaluate() com identifier sem contato cadastrado → allow=true, reason='unknown_contact'",
    decSemContact.allow === true && (decSemContact as any).reason === "unknown_contact",
  );

  // ===== 7. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  OutboundConsentGuardService.setEnabled(orgB, true);
  const carlaOrgB = seedContact(orgB, "Carla", "5511933333333");
  LgpdService.grantConsent(orgB, carlaOrgB, OUTBOUND_CONSENT_SCOPE);
  // Consent de Carla é da orgB. Um envio da orgA pro mesmo identifier da orgB
  // NÃO deve enxergar o contato — cada org tem seus contatos.
  const decCross = OutboundConsentGuardService.evaluate(orgA, "5511933333333");
  check(
    "cross-tenant: consent da orgB NÃO libera envio da orgA (identifier alheio → unknown_contact na orgA)",
    decCross.allow === true && (decCross as any).reason === "unknown_contact",
  );
  // Mesmo identifier COMO CONTATO da orgA sem consent → bloqueia
  const anaOrgADup = seedContact(orgA, "Ana Dup", "5511933333333");
  const decCrossOwn = OutboundConsentGuardService.evaluate(orgA, "5511933333333");
  check(
    "cross-tenant: mesmo identifier agora cadastrado na orgA (sem consent na orgA) → bloqueia",
    decCrossOwn.allow === false && (decCrossOwn as any).reason === "consent_missing",
  );
  check(
    "cross-tenant: contactId no bloqueio é da orgA, não da orgB",
    (decCrossOwn as any).contactId === anaOrgADup,
  );

  // ===== 8. OutboundBlockedError code =====
  const e = new OutboundBlockedError("consent_missing", { contactId: "x", contactName: "y" });
  check(
    "OutboundBlockedError.code === 'outbound_blocked:consent_missing'",
    e.code === "outbound_blocked:consent_missing",
  );
  check(
    "OutboundBlockedError.name === 'OutboundBlockedError' (pra caller detectar)",
    e.name === "OutboundBlockedError",
  );
  check(
    "OutboundBlockedError mensagem em pt-BR humana",
    e.message.includes("bloqueado") && e.message.includes("comunicacoes"),
  );

  // ===== 9. Integração real com MessageProviderService.sendMessage =====
  // A ideia: com flag OFF, o sendMessage vai adiante e tenta fetchar o provider
  // (que quebra com erro de rede/token — mas NÃO é OutboundBlockedError).
  // Com flag ON + sem consent, o sendMessage QUEBRA no guard ANTES do fetch.
  const chnA = seedChannel(orgA);
  OutboundConsentGuardService.setEnabled(orgA, true); // (já estava, mas garante)

  let capturedErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnA, "5511911111111", "Oi!");
  } catch (err: any) {
    capturedErr = err;
  }
  check(
    "sendMessage(chnA, identifier bloqueado) LANÇA erro",
    capturedErr != null,
  );
  check(
    "erro lançado é OutboundBlockedError",
    capturedErr && capturedErr.name === "OutboundBlockedError",
  );
  check(
    "erro.code === 'outbound_blocked:consent_missing'",
    capturedErr && capturedErr.code === "outbound_blocked:consent_missing",
  );

  // Concede consent → sendMessage passa do guard e cai no fetch (que quebra
  // por outro motivo — não é o guard).
  LgpdService.grantConsent(orgA, anaId, OUTBOUND_CONSENT_SCOPE);
  let passedGuardErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnA, "5511911111111", "Oi de novo!");
  } catch (err: any) {
    passedGuardErr = err;
  }
  // Passou do guard: erro (se houver) NÃO é OutboundBlockedError.
  check(
    "após grantConsent, sendMessage NÃO lança OutboundBlockedError (passou do guard)",
    !passedGuardErr || passedGuardErr.name !== "OutboundBlockedError",
  );

  // Com flag OFF em outra org, sendMessage passa direto do guard
  const orgC = seedOrg("Salão C");
  const chnC = seedChannel(orgC);
  // Contato sem consent NA orgC + flag OFF → passa
  seedContact(orgC, "Denise", "5511944444444");
  let orgCErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnC, "5511944444444", "Oi orgC!");
  } catch (err: any) {
    orgCErr = err;
  }
  check(
    "orgC com flag OFF: sendMessage NÃO lança OutboundBlockedError (0-regressão)",
    !orgCErr || orgCErr.name !== "OutboundBlockedError",
  );

  // ===== 10. Read-only: guard NÃO muta contact_consents =====
  const consentCountBefore = (
    db.prepare(`SELECT COUNT(*) c FROM contact_consents`).get() as any
  ).c;
  OutboundConsentGuardService.evaluate(orgA, "5511911111111");
  OutboundConsentGuardService.evaluate(orgA, "5511999888777");
  OutboundConsentGuardService.evaluate(orgA, "identifier_qualquer");
  const consentCountAfter = (
    db.prepare(`SELECT COUNT(*) c FROM contact_consents`).get() as any
  ).c;
  check(
    "guard NÃO escreve consent (read-only puro)",
    consentCountBefore === consentCountAfter,
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
  console.log("\n=== TEST: Consent LGPD transversal no sink outbound (ADR-169 F5-transversal-A) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Gate LGPD transversal ligado ao sink canônico — aditivo, opt-in, 0-regressão.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
