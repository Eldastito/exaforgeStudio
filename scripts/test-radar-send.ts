/**
 * TESTE — Radar: envio do relatório pelo canal da própria organização
 * ------------------------------------------------------------------
 * Cobre os caminhos de VALIDAÇÃO de RadarService.sendReport — todos
 * alcançáveis SEM nenhuma chamada de rede de verdade (nenhum canal
 * WhatsApp/Google DE VERDADE conectado neste banco de teste; o único canal
 * "conectado" usado aqui tem provider='instagram', que MessageProviderService
 * já rejeita de propósito ANTES de tentar qualquer fetch — este script nunca
 * deve bater na Graph API/Google de verdade):
 *   - sem telefone/e-mail de contato na sessão -> rejeita ANTES de gerar o
 *     PDF (não teria pra onde ir, não vale a chamada de IA);
 *   - sem canal de WhatsApp conectado -> rejeita com mensagem clara;
 *   - sem conta Google conectada -> rejeita com mensagem clara (via
 *     GoogleOAuthService.gmailSend/getConnection, sem tentar rede);
 *   - contato E canal OK, mas URL relativa (APP_URL não configurada, S3
 *     desligado) -> rejeita ANTES de tentar enviar;
 *   - contato, canal E URL pública OK -> chega em MessageProviderService,
 *     que rejeita provedor não suportado sem nenhuma chamada de rede;
 *   - isolamento por organização continua valendo.
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:radar-send
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-send-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-radar-envio-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.APP_URL; // confirma que a validação de URL pública dispara

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RadarService } = await import("../src/server/RadarService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, "outro");
    const mods = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).enabled_modules);
    ModuleService.setModules(orgId, [...mods, "radar"]);
    return orgId;
  }

  function completeSession(orgId: string, contact: { phone?: string | null; email?: string | null }) {
    const template = (RadarService.listTemplates(orgId) as any[])[0];
    const session = RadarService.createSession(orgId, `actor_${orgId}`, {
      templateId: template.id, companyName: `Empresa ${orgId}`, contactPhone: contact.phone, contactEmail: contact.email,
    });
    const full = RadarService.getTemplateWithQuestions(orgId, template.id) as any;
    for (const q of full.questions) {
      RadarService.saveAnswer(orgId, session.id, `actor_${orgId}`, { questionId: q.id, value: "4", comment: "evidência" });
    }
    return RadarService.completeSession(orgId, session.id, `actor_${orgId}`) as any;
  }

  const orgA = seedOrg("A");

  // ---- Sem telefone nem e-mail: rejeita ANTES de gastar a geração do PDF ----
  const sessionNoContact = completeSession(orgA, {});
  let rejectedNoPhone = false, rejectedNoPhoneMsg = "";
  try { await RadarService.sendReport(orgA, sessionNoContact.id, "actor_A", "whatsapp"); }
  catch (e: any) { rejectedNoPhone = true; rejectedNoPhoneMsg = e.message; }
  check("Sem telefone de contato: rejeita com mensagem específica", rejectedNoPhone && /telefone/i.test(rejectedNoPhoneMsg), rejectedNoPhoneMsg);

  let rejectedNoEmail = false, rejectedNoEmailMsg = "";
  try { await RadarService.sendReport(orgA, sessionNoContact.id, "actor_A", "email"); }
  catch (e: any) { rejectedNoEmail = true; rejectedNoEmailMsg = e.message; }
  check("Sem e-mail de contato: rejeita com mensagem específica", rejectedNoEmail && /e-mail/i.test(rejectedNoEmailMsg), rejectedNoEmailMsg);

  const reportEventsAfterContactChecks = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_report_generated'`).all(orgA) as any[];
  check("Rejeição por falta de contato NÃO gera PDF (checa antes de gastar a chamada de IA)", reportEventsAfterContactChecks.length === 0, `eventos=${reportEventsAfterContactChecks.length}`);

  // ---- Contato OK, mas sem canal WhatsApp / conta Google conectados ----
  const sessionWithContact = completeSession(orgA, { phone: "5511999998888", email: "contato@empresa.com" });
  let rejectedNoChannel = false, rejectedNoChannelMsg = "";
  try { await RadarService.sendReport(orgA, sessionWithContact.id, "actor_A", "whatsapp"); }
  catch (e: any) { rejectedNoChannel = true; rejectedNoChannelMsg = e.message; }
  check("Contato OK, sem canal WhatsApp conectado: rejeita com mensagem clara", rejectedNoChannel && /canal/i.test(rejectedNoChannelMsg), rejectedNoChannelMsg);

  let rejectedNoGoogle = false, rejectedNoGoogleMsg = "";
  try { await RadarService.sendReport(orgA, sessionWithContact.id, "actor_A", "email"); }
  catch (e: any) { rejectedNoGoogle = true; rejectedNoGoogleMsg = e.message; }
  check("Contato OK, sem conta Google conectada: rejeita com mensagem clara (sem chamada de rede)",
    rejectedNoGoogle && /conectada/i.test(rejectedNoGoogleMsg), rejectedNoGoogleMsg);

  // ---- Conecta um canal "de mentira" (provider não suportado por sendDocument,
  // então mesmo se chegar lá não faz NENHUMA chamada de rede) — agora passa da
  // checagem de canal, mas ainda falta a URL pública (APP_URL) ----
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'instagram', 'Canal teste', 'id-teste', 'connected')`)
    .run(randomUUID(), orgA);
  let rejectedNoPublicUrl = false, rejectedNoPublicUrlMsg = "";
  try { await RadarService.sendReport(orgA, sessionWithContact.id, "actor_A", "whatsapp"); }
  catch (e: any) { rejectedNoPublicUrl = true; rejectedNoPublicUrlMsg = e.message; }
  check("Contato E canal OK, mas sem APP_URL: rejeita por link não-público", rejectedNoPublicUrl && /público/i.test(rejectedNoPublicUrlMsg), rejectedNoPublicUrlMsg);

  // ---- Configura APP_URL: passa de TODAS as validações do Radar e chega em
  // MessageProviderService, que rejeita o provedor 'instagram' sem tentar
  // nenhuma chamada de rede (confirma a integração ponta a ponta) ----
  process.env.APP_URL = "https://app.zappflow.exemplo.com.br";
  let rejectedUnsupportedProvider = false, rejectedUnsupportedProviderMsg = "";
  try { await RadarService.sendReport(orgA, sessionWithContact.id, "actor_A", "whatsapp"); }
  catch (e: any) { rejectedUnsupportedProvider = true; rejectedUnsupportedProviderMsg = e.message; }
  check("Passa por todas as validações do Radar e chega em MessageProviderService (provedor de teste rejeitado sem rede)",
    rejectedUnsupportedProvider && /suportad/i.test(rejectedUnsupportedProviderMsg), rejectedUnsupportedProviderMsg);

  const reportEventsAtEnd = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_report_generated'`).all(orgA) as any[];
  // Só as 2 tentativas que já tinham contato+canal/OAuth OK chegaram a gerar o
  // PDF (a rejeição por URL não-pública e a rejeição final em
  // MessageProviderService) — as 4 rejeições anteriores (sem contato, sem
  // canal, sem Google) pararam ANTES de gastar a chamada de IA.
  check("PDF só é gerado depois de passar pelas checagens de contato/canal", reportEventsAtEnd.length === 2, `eventos=${reportEventsAtEnd.length}`);

  const sentEvents = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_report_sent'`).all(orgA) as any[];
  check("Nenhuma tentativa (todas rejeitadas de propósito) registrou radar_report_sent", sentEvents.length === 0, `eventos=${sentEvents.length}`);

  // ---- Isolamento: organização B não alcança a sessão de A ----
  const orgB = seedOrg("B");
  let rejectedCrossOrg = false;
  try { await RadarService.sendReport(orgB, sessionWithContact.id, "actor_B", "whatsapp"); }
  catch { rejectedCrossOrg = true; }
  check("Organização B não consegue enviar o relatório de uma sessão de A", rejectedCrossOrg);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — RADAR: ENVIO DO RELATÓRIO (WHATSAPP/E-MAIL)");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 VALIDAÇÕES DE ENVIO CONFIRMADAS (sem nenhuma chamada de rede real).\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de envio:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
