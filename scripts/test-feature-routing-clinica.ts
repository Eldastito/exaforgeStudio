/**
 * TEST — F6.3b (RF-08 §F6.3 / CA-03): guardas de finalidade do domínio CLÍNICA.
 *
 * Prova, offline (tmp db, fetch/sender stubados — sem rede), que:
 *  A. um produtor real de clínica (ClinicReminderService — lembrete de consulta)
 *     envia declarando a finalidade "agenda" pelo caminho default (sem sender
 *     injetado) — antes o binding do sink não passava por ele;
 *  B. no sink, desligar "agenda" bloqueia lembretes SEM afetar "clinica"/
 *     "atendimento"; e desligar "clinica" bloqueia documentos SEM afetar
 *     "agenda" — isolamento por finalidade nos dois sentidos (CA-03); finalidade
 *     sem binding passa (0-regressão).
 *
 * Mapa desta fatia: agenda = Reminder/Vacancy/FollowUp · clinica = Guide/
 * Document/Addendum · gestao = MonthlyReport (relatório financeiro ao gestor).
 *
 * Uso: npm run test:feature-routing-clinica
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-feat-clin-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-feat-clin-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService, OutboundFeatureDisabledError } = await import("../src/server/ChannelBindingService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // ══ PARTE B (sink REAL): isolamento agenda × clinica ══
  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'n', 'n', 'connected', 'tok')`).run(id, org); return id; };
  const bind = (org: string, ch: string, feature: string, inbound: number, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, ch, feature, inbound, outbound);

  let fetchCalls = 0;
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };
  const sendTry = async (ch: string, feature: string) => { fetchCalls = 0; let blocked = false; try { await MessageProviderService.sendMessage(ch, "5521999", "x", { feature }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; } return { blocked, sent: fetchCalls > 0 }; };

  // Org 1: agenda desligada, clinica/atendimento ligadas.
  const O1 = `org1_${randomUUID().slice(0, 6)}`; mkOrg(O1); const c1 = mkChannel(O1);
  bind(O1, c1, "agenda", 1, 0); bind(O1, c1, "clinica", 1, 1); bind(O1, c1, "atendimento", 1, 1);
  check("B.1 agenda desligada → lembrete bloqueado", (await sendTry(c1, "agenda")).blocked === true);
  check("B.2 CA-03: clinica livre no mesmo canal", (await sendTry(c1, "clinica")).sent === true);
  check("B.3 CA-03: atendimento livre no mesmo canal", (await sendTry(c1, "atendimento")).sent === true);
  check("B.4 finalidade sem binding (gestao) → passa (0-regressão)", (await sendTry(c1, "gestao")).sent === true);

  // Org 2: clinica desligada, agenda ligada → isolamento no sentido oposto.
  const O2 = `org2_${randomUUID().slice(0, 6)}`; mkOrg(O2); const c2 = mkChannel(O2);
  bind(O2, c2, "clinica", 1, 0); bind(O2, c2, "agenda", 1, 1);
  check("B.5 clinica desligada → documento bloqueado", (await sendTry(c2, "clinica")).blocked === true);
  check("B.6 CA-03: agenda livre (clinica desligada não afeta)", (await sendTry(c2, "agenda")).sent === true);
  (globalThis as any).fetch = origFetch;

  // ══ PARTE A: produtor real de clínica declara 'agenda' ══
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  const captured: Array<{ feature: string | undefined }> = [];
  (MessageProviderService as any).sendMessage = async (_ch: string, _to: string, _text: string, opts?: any) => { captured.push({ feature: opts?.feature }); return `wamid.${randomUUID().slice(0, 8)}`; };

  const orgId = `org_clin_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_reminder_hours, clinic_second_reminder_enabled) VALUES (?, ?, 'Clínica', 'active', 24, 0)`).run(randomUUID(), orgId);
  const channelId = `ch_${orgId}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', 'Canal', 'wa', 'connected')`).run(channelId, orgId);
  const patient = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Ana', '5511988887777')`).run(patient, orgId, channelId);
  const actorId = `user_${orgId}`;
  const dra = ClinicAgendaService.createProfessional(orgId, { name: "Dra. Bia" }, actorId);
  const withinISO = new Date(Date.now() + 24 * 3600_000 + 5 * 60_000).toISOString();
  const apt = ClinicAgendaService.createAppointment(orgId, { contactId: patient, title: "Consulta", scheduledStart: withinISO, professionalId: dra.id, durationMinutes: 30 }, actorId);
  LgpdService.grantConsent(orgId, patient, "comunicacoes", { actorId });

  const r = await ClinicReminderService.sendForAppointment(orgId, apt.id); // SEM sender → caminho default
  check("A.1 lembrete enviou (status sent)", r?.status === "sent" && captured.length === 1);
  check("A.2 o lembrete declara finalidade 'agenda'", captured[0]?.feature === "agenda");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} feature-routing-clinica: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
