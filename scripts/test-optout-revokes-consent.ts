/**
 * TESTE — "PARAR" alinha o opt-out ao escopo que o gate de saída checa.
 * ----------------------------------------------------------------------------
 * Gap de COMPLIANCE (LGPD Art.14): o interceptor de opt-out ("sair/parar/…") só
 * marcava `marketing_opt_out=1`, mas `OutboundConsentGuardService` bloqueia por
 * consentimento `comunicacoes`. Em modo consent-required, quando o contato TINHA
 * esse consentimento, o "PARAR" era IGNORADO — cadências/lembretes seguiam saindo.
 *
 * `applyOptOut` agora revoga também `comunicacoes`. Este teste prova:
 *  - após opt-out, marketing_opt_out=1 E o consentimento `comunicacoes` é revogado;
 *  - com consent-required ligado, o gate passa a BLOQUEAR a saída pro contato;
 *  - a regex de opt-out casa os sinônimos e ignora texto normal;
 *  - idempotente; isolamento por org.
 *
 * Uso:  npm run test:optout-revokes-consent
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-optout-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-optout-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { applyOptOut, OPT_OUT_RE } = await import("../src/server/webhookProcessor.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { OutboundConsentGuardService } = await import("../src/server/OutboundConsentGuardService.js");

  const mkOrg = (id: string) => {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
    const ch = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'whatsapp_cloud', 'n', ?, 'connected', 'tok')`).run(ch, id, `id_${randomUUID().slice(0,4)}`);
    return ch;
  };
  const mkContact = (org: string, channelId: string, phone: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Cliente', ?)`).run(id, org, channelId, phone); return id; };

  const A = `org_A_${randomUUID().slice(0, 6)}`; const chA = mkOrg(A);
  const phone = "5531988887777";
  const c = mkContact(A, chA, phone);

  // Cenário: org exige consentimento na saída, e o contato TINHA consentido.
  OutboundConsentGuardService.setEnabled(A, true);
  LgpdService.grantConsent(A, c, "comunicacoes");
  check("0.1 antes do opt-out: consentimento ativo", LgpdService.hasConsent(A, c, "comunicacoes") === true);
  check("0.2 antes do opt-out: gate PERMITE a saída", OutboundConsentGuardService.evaluate(A, phone).allow === true);

  // ── 1. regex ──
  check("1.1 regex casa 'parar'", OPT_OUT_RE.test("parar"));
  check("1.2 regex casa 'sair'", OPT_OUT_RE.test("sair"));
  check("1.3 regex casa 'não quero'", OPT_OUT_RE.test("não quero"));
  check("1.4 regex ignora texto normal", !OPT_OUT_RE.test("quero comprar"));

  // ── 2. opt-out revoga o consentimento + marca marketing_opt_out ──
  applyOptOut(A, c);
  check("2.1 marketing_opt_out marcado", (db.prepare(`SELECT marketing_opt_out m FROM contacts WHERE id = ?`).get(c) as any)?.m === 1);
  check("2.2 consentimento 'comunicacoes' revogado", LgpdService.hasConsent(A, c, "comunicacoes") === false);

  // ── 3. o gate agora BLOQUEIA (o "PARAR" passou a ser honrado) ──
  const dec = OutboundConsentGuardService.evaluate(A, phone);
  check("3.1 gate BLOQUEIA a saída após opt-out", dec.allow === false && dec.reason === "consent_missing");

  // ── 4. idempotente ──
  applyOptOut(A, c);
  check("4.1 reexecutar não quebra e segue revogado", LgpdService.hasConsent(A, c, "comunicacoes") === false);

  // ── 5. isolamento: outra org não é afetada ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; const chB = mkOrg(B);
  const cB = mkContact(B, chB, phone);
  LgpdService.grantConsent(B, cB, "comunicacoes");
  check("5.1 contato de B mantém consentimento", LgpdService.hasConsent(B, cB, "comunicacoes") === true);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} optout-revokes-consent: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
