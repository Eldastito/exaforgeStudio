/**
 * TEST — ADR-154 Fatia 4.2: falatu_reply_mode + bypass no webhookProcessor.
 *
 * PROVA o guardrail RN-154 (duro): org Solo com Evolution dedicado +
 * `falatu_reply_mode='trigger_only'` NUNCA gera outbound quando o FalaTu
 * não capturou o gatilho — Controller/Coordenador/Diretor IA todos ficam
 * BYPASSED. Assistente pessoal não intervém na vida do dono do número.
 *
 * Ao mesmo tempo, PROVA retrocompat: org suíte (kind='shared') OU org com
 * `falatu_reply_mode='always'` seguem 100% do fluxo antigo — Controller
 * e Coordenador continuam funcionando.
 *
 * Cobre:
 *  1. Schema: coluna falatu_reply_mode existe, default='always'.
 *  2. provision (F4.1) seta falatu_reply_mode='trigger_only' junto com
 *     whatsapp_instance_kind='dedicated' (pacote atômico do Solo).
 *  3. Org suíte fresh: falatu_reply_mode='always' automático.
 *  4. webhookProcessor — cenário SILÊNCIO:
 *     - Solo (dedicated + trigger_only), FalaTu NÃO handles → return.
 *     - GestorCommandService NÃO chamado.
 *     - CoordenadorService.handleInbound NÃO chamado.
 *     - Zero MessageProviderService.sendMessage disparado.
 *  5. webhookProcessor — cenário FalaTu handles em Solo → reply normal.
 *  6. webhookProcessor — cenário RETROCOMPAT suíte:
 *     - Suíte (shared + always), FalaTu NÃO handles → Coordenador RODA.
 *  7. webhookProcessor — cenário EDGE: dedicated MAS reply_mode='always'
 *     (dono explicitamente reverteu). FalaTu NÃO handles → Coordenador
 *     RODA (bypass exige AMBOS os flags).
 *  8. webhookProcessor — cenário EDGE: shared MAS reply_mode='trigger_only'
 *     (deve ser impossível na prática — provision não faz isso). FalaTu
 *     NÃO handles → Coordenador RODA (guardrail: bypass exige dedicated).
 *
 * Uso: npm run test:falatu-trigger-only
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-triggeronly-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-triggeronly-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { EvolutionService } = await import("../src/server/EvolutionService.js");
  const { FalaTuSoloWhatsAppService } = await import("../src/server/FalaTuSoloWhatsAppService.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { BlueprintSeeder } = await import("../src/server/BlueprintSeeder.js");

  await new Promise((r) => setTimeout(r, 100));
  BlueprintSeeder.seedInitialBlueprints();

  // ===== 1. Schema =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c: any) => c.name);
  check("1.1 coluna falatu_reply_mode existe", cols.includes("falatu_reply_mode"));

  const testOrgDefault = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(testOrgDefault, "Default Check");
  const defaultRow = db.prepare(`SELECT falatu_reply_mode FROM organization_settings WHERE organization_id = ?`).get(testOrgDefault) as any;
  check("1.2 default falatu_reply_mode='always' (retrocompat)", defaultRow?.falatu_reply_mode === "always");

  // ===== 2. provision (F4.1) seta 'trigger_only' junto com 'dedicated' =====
  const orgSoloId = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSoloId, "Solo Prov");
  const soloBp = VerticalBlueprintService.getLatestPublished("falatu_solo");
  if (!soloBp) throw new Error("falatu_solo não seedado");
  VerticalBlueprintService.assignToOrganization(orgSoloId, soloBp.id, "test");

  // Stub fetch para o provision (não vai bater na Evolution real)
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any) => ({
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    text: async () => "{}",
    json: async () => {
      if (String(url).endsWith("/instance/all")) return { data: [] };
      if (String(url).endsWith("/instance/create")) return { data: { token: "tok" } };
      // F4.1c: /instance/qr (Evolution GO real) tem prioridade sobre /api/v1/instance/qr.
      if (String(url).endsWith("/instance/qr")) return { base64: "QR" };
      if (String(url).includes("/api/v1/instance/qr")) return { base64: "QR" };
      return {};
    },
  } as any);
  process.env.EVOLUTION_BASE_URL = "https://evo.example.com";
  process.env.EVOLUTION_API_KEY = "K";

  const prov = await FalaTuSoloWhatsAppService.provision(orgSoloId, "user_prov");
  (globalThis as any).fetch = realFetch;
  check("2.1 provision ok", prov.ok === true);

  const orgSoloRow = db.prepare(`SELECT whatsapp_instance_kind, falatu_reply_mode FROM organization_settings WHERE organization_id = ?`).get(orgSoloId) as any;
  check("2.2 provision seta whatsapp_instance_kind='dedicated'", orgSoloRow?.whatsapp_instance_kind === "dedicated");
  check("2.3 provision seta falatu_reply_mode='trigger_only'", orgSoloRow?.falatu_reply_mode === "trigger_only");

  // ===== 3. Org suíte fresh mantém 'always' =====
  const orgSuiteId = "org_" + randomUUID().slice(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSuiteId, "Suite");
  const orgSuiteRow = db.prepare(`SELECT whatsapp_instance_kind, falatu_reply_mode FROM organization_settings WHERE organization_id = ?`).get(orgSuiteId) as any;
  check("3.1 org suíte fresh: kind='shared' + reply_mode='always' (defaults)", orgSuiteRow?.whatsapp_instance_kind === "shared" && orgSuiteRow?.falatu_reply_mode === "always");

  // ===== 4-8. webhookProcessor: cenários com spies em FalaTu/Gestor/Coordenador/Message =====
  const { processIncomingMessage } = await import("../src/server/webhookProcessor.js");
  const { FalaTuWhatsAppService } = await import("../src/server/FalaTuWhatsAppService.js");
  const { GestorCommandService } = await import("../src/server/GestorCommandService.js");
  const { CoordenadorService } = await import("../src/server/CoordenadorService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Guarda os originais
  const realFalatu = FalaTuWhatsAppService.handle;
  const realGestor = GestorCommandService.handle;
  const realShouldRoute = GestorCommandService.shouldRoute;
  const realCoord = CoordenadorService.handleInbound;
  const realSend = MessageProviderService.sendMessage;

  // Counters
  let falatuCalls = 0;
  let falatuShouldHandle = false;
  let gestorHandleCalls = 0;
  let coordCalls = 0;
  let sendCalls: { channelId: string; to: string; text: string }[] = [];

  function resetCounters() {
    falatuCalls = 0; gestorHandleCalls = 0; coordCalls = 0; sendCalls = [];
  }

  (FalaTuWhatsAppService as any).handle = async (_o: string, _s: string, _t: string) => {
    falatuCalls++;
    return falatuShouldHandle ? { handled: true, reply: "captured!" } : { handled: false };
  };
  (GestorCommandService as any).handle = (_o: string, _s: string, _t: string) => {
    gestorHandleCalls++;
    return { intent: "none", reply: "" };
  };
  (GestorCommandService as any).shouldRoute = (_g: any) => false; // não roteia Controller
  (CoordenadorService as any).handleInbound = async (_o: string, _c: string, _s: string, _t: string) => {
    coordCalls++;
  };
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    sendCalls.push({ channelId, to, text });
    return "msg_" + randomUUID();
  };

  // Precisa de um "owner" de cada org pra fallback single-tenant do webhookProcessor
  // (na verdade nem cai lá porque criamos canal antes). Cria só por segurança.
  db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, 'x', ?, 'x', 'owner', 'active')`)
    .run("uSolo", orgSoloId, `o-${orgSoloId}@t.com`);
  db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, 'x', ?, 'x', 'owner', 'active')`)
    .run("uSuite", orgSuiteId, `o-${orgSuiteId}@t.com`);

  // Canal interno da suíte (pra que kind='internal' dispare, precisa existir)
  const suiteChanId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, kind, name, identifier, status) VALUES (?, ?, 'evolution', 'internal', 'Interno Suite', 'evo_suite_default', 'connected')`)
    .run(suiteChanId, orgSuiteId);

  // ===== 4. Cenário SILÊNCIO: Solo, FalaTu NÃO handles =====
  resetCounters();
  falatuShouldHandle = false;
  await processIncomingMessage({
    channelId: null,
    organizationId: null,
    identifier: EvolutionService.instanceNameForOrg(orgSoloId),
    provider: "evolution",
    senderId: "5511777",
    text: "oi tudo bem?", // não é gatilho
  }, null);

  check("4.1 Solo + no-gatilho: FalaTu FOI chamado (tentou capturar)", falatuCalls === 1);
  check("4.2 Solo + no-gatilho + SILÊNCIO: GestorCommandService.handle NÃO chamado", gestorHandleCalls === 0);
  check("4.3 Solo + no-gatilho + SILÊNCIO: CoordenadorService.handleInbound NÃO chamado", coordCalls === 0);
  check("4.4 Solo + no-gatilho + SILÊNCIO: ZERO outbound (sendMessage não chamado)", sendCalls.length === 0);

  // ===== 5. Cenário Solo, FalaTu handles → reply normal =====
  resetCounters();
  falatuShouldHandle = true;
  await processIncomingMessage({
    channelId: null,
    organizationId: null,
    identifier: EvolutionService.instanceNameForOrg(orgSoloId),
    provider: "evolution",
    senderId: "5511777",
    text: "anota comprei pão",
  }, null);
  check("5.1 Solo + gatilho: FalaTu FOI chamado", falatuCalls === 1);
  check("5.2 Solo + gatilho: reply do FalaTu enviado (1 sendMessage)", sendCalls.length === 1);
  check("5.3 Solo + gatilho: reply é o texto do FalaTu", sendCalls[0]?.text === "captured!");
  check("5.4 Solo + gatilho: Coordenador NÃO chamado (curto-circuito do FalaTu handled)", coordCalls === 0);

  // ===== 6. Cenário RETROCOMPAT: SUÍTE (shared+always), FalaTu NÃO handles =====
  resetCounters();
  falatuShouldHandle = false;
  await processIncomingMessage({
    channelId: null,
    organizationId: null,
    identifier: "evo_suite_default",
    provider: "evolution",
    senderId: "5522888",
    text: "quanto vendi hoje?",
  }, null);
  check("6.1 Suíte + no-gatilho: FalaTu FOI chamado (padrão canal interno)", falatuCalls === 1);
  check("6.2 RETROCOMPAT suíte + no-gatilho: GestorCommandService.handle FOI chamado", gestorHandleCalls === 1);
  check("6.3 RETROCOMPAT suíte + no-gatilho: CoordenadorService.handleInbound FOI chamado (Gestor não roteou)", coordCalls === 1);

  // ===== 7. Cenário EDGE: dedicated MAS reply_mode='always' (dono reverteu) =====
  // Fluxo teoricamente possível se o dono da org Solo alterar via
  // FalaTuSettingsView (Fase 3) — então o bypass NÃO deve rodar.
  db.prepare(`UPDATE organization_settings SET falatu_reply_mode = 'always' WHERE organization_id = ?`).run(orgSoloId);
  resetCounters();
  falatuShouldHandle = false;
  await processIncomingMessage({
    channelId: null,
    organizationId: null,
    identifier: EvolutionService.instanceNameForOrg(orgSoloId),
    provider: "evolution",
    senderId: "5511777",
    text: "e agora?",
  }, null);
  check("7.1 dedicated+always + no-gatilho: FalaTu chamado", falatuCalls === 1);
  check("7.2 dedicated+always + no-gatilho: Coordenador CHAMADO (bypass exige AMBOS)", coordCalls === 1);
  // Restaura pra 'trigger_only' pro cenário 8 (senão contamina)
  db.prepare(`UPDATE organization_settings SET falatu_reply_mode = 'trigger_only' WHERE organization_id = ?`).run(orgSoloId);

  // ===== 8. Cenário EDGE: shared MAS reply_mode='trigger_only' (impossível na
  //          prática — provision NUNCA faz — mas defensivamente o guardrail
  //          exige dedicated pra bypassar). =====
  db.prepare(`UPDATE organization_settings SET falatu_reply_mode = 'trigger_only' WHERE organization_id = ?`).run(orgSuiteId);
  // whatsapp_instance_kind da suíte segue 'shared' (default)
  resetCounters();
  falatuShouldHandle = false;
  await processIncomingMessage({
    channelId: null,
    organizationId: null,
    identifier: "evo_suite_default",
    provider: "evolution",
    senderId: "5522888",
    text: "opa!",
  }, null);
  check("8.1 shared+trigger_only + no-gatilho: FalaTu chamado", falatuCalls === 1);
  check("8.2 shared+trigger_only + no-gatilho: Coordenador CHAMADO (bypass exige dedicated)", coordCalls === 1);

  // ===== 9. Multi-tenant: bypass da org Solo A não vaza pra suíte B =====
  // Retorna orgSolo pra dedicated+trigger_only pra double-check isolamento
  db.prepare(`UPDATE organization_settings SET whatsapp_instance_kind = 'dedicated', falatu_reply_mode = 'trigger_only' WHERE organization_id = ?`).run(orgSoloId);
  db.prepare(`UPDATE organization_settings SET whatsapp_instance_kind = 'shared', falatu_reply_mode = 'always' WHERE organization_id = ?`).run(orgSuiteId);

  resetCounters();
  falatuShouldHandle = false;
  // Solo primeiro (deve silenciar)
  await processIncomingMessage({
    channelId: null, organizationId: null,
    identifier: EvolutionService.instanceNameForOrg(orgSoloId),
    provider: "evolution", senderId: "5511777", text: "oi",
  }, null);
  const soloSilentBefore = coordCalls === 0 && sendCalls.length === 0;

  // Suíte depois (deve rodar Coordenador)
  await processIncomingMessage({
    channelId: null, organizationId: null,
    identifier: "evo_suite_default",
    provider: "evolution", senderId: "5522888", text: "oi",
  }, null);
  const suiteRanAfter = coordCalls === 1;

  check("9.1 Solo silenciou (pré-suíte)", soloSilentBefore);
  check("9.2 Suíte rodou Coordenador (pós-Solo) — isolamento intacto", suiteRanAfter);

  // Restaura originais
  (FalaTuWhatsAppService as any).handle = realFalatu;
  (GestorCommandService as any).handle = realGestor;
  (GestorCommandService as any).shouldRoute = realShouldRoute;
  (CoordenadorService as any).handleInbound = realCoord;
  (MessageProviderService as any).sendMessage = realSend;

  const passed = results.length - failures;
  console.log(`\n=== TEST FALATU TRIGGER-ONLY (ADR-154 F4.2) ===`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  console.log(`\n${passed}/${results.length} passed (${failures} failed)\n`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
