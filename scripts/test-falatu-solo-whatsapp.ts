/**
 * TEST — ADR-154 Fatia 4.1: Evolution dedicada por org Solo + onboarding QR.
 *
 * Cobre:
 * - Schema: coluna whatsapp_instance_kind existe em organization_settings
 *   (default 'shared').
 * - EvolutionService.instanceNameForOrg: determinístico, prefixo falatu_solo_.
 * - EvolutionService.getConfig: retorna null sem ENV; carrega quando presente.
 * - EvolutionService.createInstance: cria e devolve token; se já existe, reusa.
 *   Stub fetch → verifica URL + apikey header + payload correto.
 * - EvolutionService.connectAndGetQr: obtém QR (Go pattern + legacy fallback).
 *
 * - FalaTuSoloWhatsAppService.assertSoloOrg: throw se org sem blueprint;
 *   throw se blueprint mode='suite'.
 * - FalaTuSoloWhatsAppService.provision (SUCESSO):
 *   - Seta whatsapp_instance_kind='dedicated' na org.
 *   - Cria linha em channels com kind='internal' (roteia pro FalaTu).
 *   - Chama Evolution (create + QR).
 *   - Retorna qrBase64 no result.
 *   - Audit FALATU_SOLO_WHATSAPP_PROVISIONED gravado.
 * - FalaTuSoloWhatsAppService.provision (IDEMPOTENTE): 2ª chamada reusa canal,
 *   não duplica linha em channels.
 * - FalaTuSoloWhatsAppService.provision (SEM CONFIG ENV): retorna ok:false
 *   com error legível — MAS ainda seta o flag na org (intenção declarada).
 * - FalaTuSoloWhatsAppService.provision (NÃO SOLO): rejeita org suíte.
 *
 * - Onboarding standalone (POST /api/onboarding-solo) provisiona best-effort:
 *   sem ENV Evolution → 201 com whatsapp.provisionError; com ENV mock stub →
 *   201 com whatsapp.qrBase64.
 *
 * - Rota POST /api/falatu-solo/whatsapp/provision: 401 sem auth (indireto via
 *   requireAuth); org suíte → 403; solo → 200 com QR.
 * - Rota GET /api/falatu-solo/whatsapp/status: kind='shared' pré-provision;
 *   kind='dedicated' + connected=false + hasQr=true pós-provision.
 *
 * - Multi-tenant: provision org A não interfere na org B (instanceName
 *   determinístico impede colisão; canal isolado por organization_id).
 *
 * - webhookProcessor: canal com kind='internal' criado pelo provision roteia
 *   mensagem pro FalaTuWhatsAppService.handle (não pro Coordenador).
 *
 * Uso: npm run test:falatu-solo-whatsapp
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-solo-wa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-solo-wa-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// ---------- Fetch stub helpers ----------

interface Captured { url: string; init: any }
let capturedCalls: Captured[] = [];
const realFetch = globalThis.fetch;

function stubFetch(responder: (url: string, init: any) => any) {
  capturedCalls = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    capturedCalls.push({ url: String(url), init: init || {} });
    const r = responder(String(url), init || {});
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body || {})),
      json: async () => r.body || {},
    } as any;
  };
}
function restoreFetch() { (globalThis as any).fetch = realFetch; }

// Responder padrão pra Evolution: /instance/all vazio, /instance/create ok
// com token. F4.1c: Evolution GO real usa /instance/qr (sem /api/v1); mantenho
// /api/v1/instance/qr também no stub porque o service tenta os dois em ordem
// (compat com builds antigas do padrão Go).
function evolutionOkResponder(): (url: string, init: any) => any {
  return (url: string) => {
    if (url.endsWith("/instance/all")) return { body: { data: [] } };
    if (url.endsWith("/instance/create")) return { body: { data: { token: "evo_token_abc" }, qrcode: null } };
    // Evolution GO real: /instance/qr (endpoint canônico do build atual)
    if (url.endsWith("/instance/qr")) return { body: { base64: "PNGBASE64_QR_STUB" } };
    if (url.includes("/api/v1/instance/qr")) return { body: { base64: "PNGBASE64_QR_STUB" } };
    if (url.includes("/webhook/set/")) return { body: {} };
    if (url.endsWith("/instance/connect")) return { body: {} };
    if (url.includes("/instance/connect/")) return { body: {} };
    return { body: {} };
  };
}

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
  check("1.1 coluna whatsapp_instance_kind existe em organization_settings", cols.includes("whatsapp_instance_kind"));

  // ===== 2. EvolutionService.instanceNameForOrg =====
  const orgIdA = "org_a1b2c3d4";
  const orgIdB = "org_e5f6g7h8";
  check("2.1 instanceNameForOrg é determinístico com prefixo", EvolutionService.instanceNameForOrg(orgIdA) === "falatu_solo_org_a1b2c3d4");
  check("2.2 instanceNameForOrg dá nomes DIFERENTES pra orgs diferentes", EvolutionService.instanceNameForOrg(orgIdA) !== EvolutionService.instanceNameForOrg(orgIdB));

  let threw = false;
  try { EvolutionService.instanceNameForOrg(""); } catch { threw = true; }
  check("2.3 instanceNameForOrg('') throw", threw);

  // ===== 3. EvolutionService.getConfig =====
  const originalBase = process.env.EVOLUTION_BASE_URL;
  const originalKey = process.env.EVOLUTION_API_KEY;
  delete process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_API_KEY;
  check("3.1 getConfig() retorna null sem ENV", EvolutionService.getConfig() === null);
  process.env.EVOLUTION_BASE_URL = "https://evo.example.com/";
  process.env.EVOLUTION_API_KEY = "K123";
  const cfg = EvolutionService.getConfig();
  check("3.2 getConfig() com ENV retorna baseUrl sem trailing slash", cfg?.baseUrl === "https://evo.example.com");
  check("3.3 getConfig() carrega apiKey do env", cfg?.apiKey === "K123");
  check("3.4 getConfig() monta webhookUrl a partir do APP_URL", (cfg?.webhookUrl || "").endsWith("/api/webhooks/evolution"));

  // ===== 4. createInstance — nova instância =====
  stubFetch(evolutionOkResponder());
  const created = await EvolutionService.createInstance("falatu_solo_test1");
  restoreFetch();
  check("4.1 createInstance ok", created.ok === true);
  check("4.2 createInstance devolveu token", created.token === "evo_token_abc");
  check("4.3 fez POST /instance/create", capturedCalls.some((c) => c.url.endsWith("/instance/create") && c.init?.method === "POST"));
  // F4.1d: Evolution GO exige `token` no payload — sem ele volta "400 token is required"
  const createCall = capturedCalls.find((c) => c.url.endsWith("/instance/create"));
  const createBody = createCall?.init?.body ? JSON.parse(String(createCall.init.body)) : {};
  check("4.3b payload contém `token` (Evolution GO)", typeof createBody.token === "string" && createBody.token.length >= 8);
  check("4.4 header apikey enviado", capturedCalls.some((c) => c.init?.headers?.apikey === "K123"));

  // ===== 5. createInstance — instância já existe (dedup via /instance/all) =====
  stubFetch((url: string) => {
    if (url.endsWith("/instance/all")) return { body: { data: [{ name: "falatu_solo_existing", token: "reused_token" }] } };
    return { body: {} };
  });
  const reused = await EvolutionService.createInstance("falatu_solo_existing");
  restoreFetch();
  check("5.1 createInstance detecta existente via /instance/all", reused.ok === true && reused.alreadyExists === true);
  check("5.2 createInstance reusa token existente", reused.token === "reused_token");

  // ===== 6. connectAndGetQr =====
  stubFetch(evolutionOkResponder());
  const qrResult = await EvolutionService.connectAndGetQr("falatu_solo_test2", "TOK");
  restoreFetch();
  check("6.1 connectAndGetQr ok", qrResult.ok === true);
  check("6.2 connectAndGetQr devolve base64 formatado data:image/png", (qrResult.qrBase64 || "").startsWith("data:image/png;base64,"));
  // F4.1c: prioridade agora é /instance/qr (Evolution GO real). O de /api/v1
  // fica como fallback pra builds mais velhas.
  check("6.3 chamou /instance/qr (Evolution GO real)", capturedCalls.some((c) => c.url.endsWith("/instance/qr")));

  // ===== 7. FalaTuSoloWhatsAppService.assertSoloOrg =====
  const orgSoloId = "org_" + randomUUID().substring(0, 8);
  const orgSuiteId = "org_" + randomUUID().substring(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSoloId, "Solo Test");
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSuiteId, "Suite Test");

  // Aplica falatu_solo na org Solo
  const soloBp = VerticalBlueprintService.getLatestPublished("falatu_solo");
  if (!soloBp) throw new Error("falatu_solo blueprint não seedado");
  VerticalBlueprintService.assignToOrganization(orgSoloId, soloBp.id, "test");

  // Aplica um suíte na org Suite
  const moda = VerticalBlueprintService.getLatestPublished("moda_loja_unica");
  if (!moda) throw new Error("moda_loja_unica não seedado");
  VerticalBlueprintService.assignToOrganization(orgSuiteId, moda.id, "test");

  threw = false;
  try { FalaTuSoloWhatsAppService.assertSoloOrg(orgSoloId); } catch { threw = true; }
  check("7.1 assertSoloOrg(orgSolo) NÃO throw", !threw);

  threw = false; let msg = "";
  try { FalaTuSoloWhatsAppService.assertSoloOrg(orgSuiteId); } catch (e: any) { threw = true; msg = e.message; }
  check("7.2 assertSoloOrg(orgSuite) throw", threw);
  check("7.3 mensagem cita 'solo'", /solo/i.test(msg));

  threw = false;
  try { FalaTuSoloWhatsAppService.assertSoloOrg("org_nada"); } catch { threw = true; }
  check("7.4 assertSoloOrg(org inexistente) throw", threw);

  // ===== 8. provision — SUCESSO =====
  stubFetch(evolutionOkResponder());
  const prov1 = await FalaTuSoloWhatsAppService.provision(orgSoloId, "user_test");
  restoreFetch();
  check("8.1 provision ok", prov1.ok === true);
  check("8.2 provision devolve qrBase64", (prov1.qrBase64 || "").startsWith("data:image/png;base64,"));
  check("8.3 provision devolve channelId", !!prov1.channelId);
  check("8.4 provision devolve instanceName determinístico", prov1.instanceName === EvolutionService.instanceNameForOrg(orgSoloId));

  const orgRow = db.prepare(`SELECT whatsapp_instance_kind FROM organization_settings WHERE organization_id = ?`).get(orgSoloId) as any;
  check("8.5 whatsapp_instance_kind='dedicated' setado", orgRow?.whatsapp_instance_kind === "dedicated");

  const channelRow = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(prov1.channelId) as any;
  check("8.6 canal criado com kind='internal'", channelRow?.kind === "internal");
  check("8.7 canal criado com provider='evolution'", channelRow?.provider === "evolution");
  check("8.8 canal identifier == instanceName", channelRow?.identifier === prov1.instanceName);
  check("8.9 canal isolado por organization_id", channelRow?.organization_id === orgSoloId);
  check("8.10 canal status='awaiting_qr'", channelRow?.status === "awaiting_qr");

  const audit = db.prepare(`SELECT * FROM auth_audit_logs WHERE event_type = 'FALATU_SOLO_WHATSAPP_PROVISIONED' AND organization_id = ?`).get(orgSoloId) as any;
  check("8.11 audit FALATU_SOLO_WHATSAPP_PROVISIONED gravado", !!audit);

  // ===== 9. provision — IDEMPOTENTE =====
  stubFetch(evolutionOkResponder());
  const prov2 = await FalaTuSoloWhatsAppService.provision(orgSoloId, "user_test");
  restoreFetch();
  check("9.1 2ª provision ok", prov2.ok === true);
  check("9.2 2ª provision reusa MESMO channelId", prov2.channelId === prov1.channelId);
  const channelCount = (db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE organization_id = ? AND provider = 'evolution'`).get(orgSoloId) as any).n;
  check("9.3 NÃO duplica canal (count = 1)", channelCount === 1);

  // ===== 10. provision — NÃO SOLO (org suíte) =====
  const provSuite = await FalaTuSoloWhatsAppService.provision(orgSuiteId, "user_x");
  check("10.1 provision org suíte → ok:false", provSuite.ok === false);
  check("10.2 error cita 'solo'", /solo/i.test(provSuite.error || ""));
  const suiteChan = db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE organization_id = ?`).get(orgSuiteId) as any;
  check("10.3 org suíte NÃO ganhou canal", suiteChan.n === 0);
  const suiteKind = db.prepare(`SELECT whatsapp_instance_kind FROM organization_settings WHERE organization_id = ?`).get(orgSuiteId) as any;
  check("10.4 org suíte segue kind='shared'", suiteKind?.whatsapp_instance_kind === "shared" || suiteKind?.whatsapp_instance_kind === null);

  // ===== 11. provision — SEM CONFIG ENV (fallback best-effort no onboarding) =====
  delete process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_API_KEY;
  const orgSolo2 = "org_" + randomUUID().substring(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSolo2, "Solo2");
  VerticalBlueprintService.assignToOrganization(orgSolo2, soloBp.id, "test");
  const provNoCfg = await FalaTuSoloWhatsAppService.provision(orgSolo2, "user_z");
  check("11.1 sem ENV → ok:false com error legível", provNoCfg.ok === false && /Evolution|configurados/i.test(provNoCfg.error || ""));
  const orgFlag = db.prepare(`SELECT whatsapp_instance_kind FROM organization_settings WHERE organization_id = ?`).get(orgSolo2) as any;
  check("11.2 flag whatsapp_instance_kind='dedicated' AINDA foi setado (intenção)", orgFlag?.whatsapp_instance_kind === "dedicated");
  const auditFail = db.prepare(`SELECT * FROM auth_audit_logs WHERE event_type = 'FALATU_SOLO_WHATSAPP_PROVISION_FAILED' AND organization_id = ?`).get(orgSolo2) as any;
  check("11.3 audit FALATU_SOLO_WHATSAPP_PROVISION_FAILED gravado", !!auditFail);
  process.env.EVOLUTION_BASE_URL = "https://evo.example.com";
  process.env.EVOLUTION_API_KEY = "K123";

  // ===== 12. getStatus =====
  const orgFresh = "org_" + randomUUID().substring(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgFresh, "Fresh");
  const stFresh = FalaTuSoloWhatsAppService.getStatus(orgFresh);
  check("12.1 status org nova: kind='shared', connected=false, hasQr=false", stFresh.kind === "shared" && !stFresh.connected && !stFresh.hasQr);

  const stSolo = FalaTuSoloWhatsAppService.getStatus(orgSoloId);
  check("12.2 status org Solo provisionada: kind='dedicated'", stSolo.kind === "dedicated");
  check("12.3 status org Solo: instanceName correto", stSolo.instanceName === EvolutionService.instanceNameForOrg(orgSoloId));
  check("12.4 status org Solo: hasQr=true (status='awaiting_qr' != 'connected')", stSolo.hasQr === true);
  check("12.5 status org Solo: connected=false até canal ficar 'connected'", stSolo.connected === false);

  // Simula pareamento (webhook connection.update: status='connected')
  db.prepare(`UPDATE channels SET status='connected' WHERE id = ?`).run(prov1.channelId);
  const stConnected = FalaTuSoloWhatsAppService.getStatus(orgSoloId);
  check("12.6 pós-pareamento: connected=true, hasQr=false", stConnected.connected === true && stConnected.hasQr === false);

  // ===== 13. Multi-tenant: instância determinística por org, sem colisão =====
  const orgSoloC = "org_" + randomUUID().substring(0, 8);
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, ?, 'active')`).run(orgSoloC, "SoloC");
  VerticalBlueprintService.assignToOrganization(orgSoloC, soloBp.id, "test");
  stubFetch(evolutionOkResponder());
  const provC = await FalaTuSoloWhatsAppService.provision(orgSoloC, "user_c");
  restoreFetch();
  check("13.1 org C provisiona ok", provC.ok === true);
  check("13.2 instanceName org C != instanceName org Solo A", provC.instanceName !== prov1.instanceName);
  check("13.3 channels org C não vaza pra org Solo A", (db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE organization_id = ? AND identifier = ?`).get(orgSoloId, provC.instanceName) as any).n === 0);

  // ===== 14. Onboarding standalone (best-effort provision embutido) =====
  // 14a) Sem ENV Evolution: cadastro deve terminar com 201 + provisionError
  const onboardingSoloRoutes = (await import("../src/server/routes/onboardingSolo.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/onboarding-solo", onboardingSoloRoutes);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  async function post(pathP: string, body: any) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        port, path: pathP, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let out: any = null; try { out = JSON.parse(raw); } catch { out = raw; }
          resolve({ status: res.statusCode || 0, body: out });
        });
      });
      req.on("error", reject);
      req.write(data); req.end();
    });
  }

  delete process.env.EVOLUTION_BASE_URL;
  delete process.env.EVOLUTION_API_KEY;
  const email14a = `sa-${randomUUID().slice(0, 6)}@t.com`;
  const r14a = await post("/api/onboarding-solo", {
    name: "Solo A", email: email14a, password: "senha1234ABC", blueprintKey: "falatu_solo",
  });
  check("14.1 onboarding sem ENV Evolution → 201 (não derruba cadastro)", r14a.status === 201);
  check("14.2 onboarding sem ENV: body.whatsapp.provisionError presente", !!r14a.body?.whatsapp?.provisionError);
  const orgAId = r14a.body.organizationId;
  const kindA = db.prepare(`SELECT whatsapp_instance_kind FROM organization_settings WHERE organization_id = ?`).get(orgAId) as any;
  check("14.3 onboarding sem ENV: flag 'dedicated' AINDA aplicada", kindA?.whatsapp_instance_kind === "dedicated");

  // 14b) Com ENV mock: 201 + whatsapp.qrBase64
  process.env.EVOLUTION_BASE_URL = "https://evo.example.com";
  process.env.EVOLUTION_API_KEY = "K123";
  stubFetch(evolutionOkResponder());
  const email14b = `sb-${randomUUID().slice(0, 6)}@t.com`;
  const r14b = await post("/api/onboarding-solo", {
    name: "Solo B", email: email14b, password: "senha1234ABC", blueprintKey: "falatu_solo",
  });
  restoreFetch();
  check("14.4 onboarding com Evolution mock → 201", r14b.status === 201);
  check("14.5 onboarding com Evolution: whatsapp.qrBase64 presente", !!r14b.body?.whatsapp?.qrBase64);
  check("14.6 onboarding com Evolution: whatsapp.instanceName determinístico", r14b.body?.whatsapp?.instanceName === EvolutionService.instanceNameForOrg(r14b.body.organizationId));
  check("14.7 onboarding com Evolution: channelId retornado", !!r14b.body?.whatsapp?.channelId);
  const chB = db.prepare(`SELECT kind, status FROM channels WHERE id = ?`).get(r14b.body.whatsapp.channelId) as any;
  check("14.8 canal criado kind='internal'", chB?.kind === "internal");

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // ===== 15. Rotas /api/falatu-solo/whatsapp (JWT real, requireAuth+requireRole) =====
  const jwt = (await import("jsonwebtoken")).default;
  const { JWT_SECRET } = await import("../src/server/config/secret.js");
  function tokenFor(orgId: string, userId: string, role: string): string {
    return jwt.sign({ userId, organizationId: orgId, role, email: `${userId}@t.com` }, JWT_SECRET as string);
  }
  const falatuSoloWaRoutes = (await import("../src/server/routes/falatuSoloWhatsapp.js")).default;
  const app2 = express();
  app2.use(express.json());
  app2.use("/api/falatu-solo/whatsapp", falatuSoloWaRoutes);
  const s2 = http.createServer(app2);
  await new Promise<void>((resolve) => s2.listen(0, resolve));
  const port2 = (s2.address() as any).port;

  async function req(pathP: string, method: string, headers: Record<string, string> = {}, body?: any) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r2 = http.request({
        port: port2, path: pathP, method,
        headers: { "Content-Type": "application/json", ...headers, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let out: any = null; try { out = JSON.parse(raw); } catch { out = raw; }
          resolve({ status: res.statusCode || 0, body: out });
        });
      });
      r2.on("error", reject);
      if (data) r2.write(data);
      r2.end();
    });
  }

  // 15a) Sem auth → 401
  const noAuth = await req("/api/falatu-solo/whatsapp/provision", "POST");
  check("15.1 sem auth → 401", noAuth.status === 401);

  // 15b) Auth mas role != owner → 403
  const notOwner = await req("/api/falatu-solo/whatsapp/provision", "POST", {
    authorization: `Bearer ${tokenFor(orgSoloId, "u1", "atendente")}`,
  });
  check("15.2 role != owner → 403", notOwner.status === 403);

  // 15c) Owner de org suíte → 403 (não-solo)
  const suiteOwner = await req("/api/falatu-solo/whatsapp/provision", "POST", {
    authorization: `Bearer ${tokenFor(orgSuiteId, "u2", "owner")}`,
  });
  check("15.3 owner de org suíte → 403", suiteOwner.status === 403);

  // 15d) Owner mas org sem blueprint solo → 403
  const soloOk = await req("/api/falatu-solo/whatsapp/provision", "POST", {
    authorization: `Bearer ${tokenFor(orgFresh, "u3", "owner")}`,
  });
  check("15.4 owner mas org sem blueprint solo → 403", soloOk.status === 403);

  // Torna orgFresh solo e re-tenta
  VerticalBlueprintService.assignToOrganization(orgFresh, soloBp.id, "test");
  stubFetch(evolutionOkResponder());
  const soloReal = await req("/api/falatu-solo/whatsapp/provision", "POST", {
    authorization: `Bearer ${tokenFor(orgFresh, "u3", "owner")}`,
  });
  restoreFetch();
  check("15.5 owner + org solo → 200", soloReal.status === 200);
  check("15.6 200 devolve ok:true + qrBase64", soloReal.body?.ok === true && !!soloReal.body?.qrBase64);
  check("15.7 200 devolve instanceName determinístico", soloReal.body?.instanceName === EvolutionService.instanceNameForOrg(orgFresh));

  // 15e) GET /status auth necessário
  const statusNoAuth = await req("/api/falatu-solo/whatsapp/status", "GET");
  check("15.8 GET /status sem auth → 401", statusNoAuth.status === 401);

  const statusOk = await req("/api/falatu-solo/whatsapp/status", "GET", {
    authorization: `Bearer ${tokenFor(orgFresh, "u3", "owner")}`,
  });
  check("15.9 GET /status: 200 com kind='dedicated'", statusOk.status === 200 && statusOk.body?.kind === "dedicated");

  const statusSuite = await req("/api/falatu-solo/whatsapp/status", "GET", {
    authorization: `Bearer ${tokenFor(orgSuiteId, "u2", "owner")}`,
  });
  check("15.10 GET /status org suíte: kind='shared'", statusSuite.status === 200 && (statusSuite.body?.kind === "shared" || statusSuite.body?.kind === undefined));

  await new Promise<void>((resolve) => s2.close(() => resolve()));

  // ===== 16. webhookProcessor: canal kind='internal' criado pelo provision
  //          roteia mensagem pro FalaTu (não pro Coordenador) =====
  const { processIncomingMessage } = await import("../src/server/webhookProcessor.js");
  const { FalaTuWhatsAppService } = await import("../src/server/FalaTuWhatsAppService.js");
  let falatuCalled = false;
  let falatuArgs: any = null;
  const realHandle = FalaTuWhatsAppService.handle;
  (FalaTuWhatsAppService as any).handle = async (orgId: string, sender: string, text: string) => {
    falatuCalled = true; falatuArgs = { orgId, sender, text };
    return { handled: true, reply: "ok" };
  };
  try {
    // Precisamos setar org com owner pra passar no fallback single-tenant do webhookProcessor,
    // OU garantir que o canal já existe (que é o nosso caso — provisionado).
    db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, 'X', ?, 'x', 'owner', 'active')`)
      .run("uW", orgSoloId, `owner-${orgSoloId}@t.com`);
    await processIncomingMessage({
      channelId: null,
      organizationId: null,
      identifier: EvolutionService.instanceNameForOrg(orgSoloId),
      provider: "evolution",
      senderId: "5511999",
      text: "anota comprei pão",
    }, null);
  } finally {
    (FalaTuWhatsAppService as any).handle = realHandle;
  }
  check("16.1 webhook rotea canal kind='internal' pro FalaTuWhatsAppService.handle", falatuCalled);
  check("16.2 FalaTu recebe orgId correto (da instância dedicada)", falatuArgs?.orgId === orgSoloId);

  // ===== Encerramento =====
  process.env.EVOLUTION_BASE_URL = originalBase || "";
  process.env.EVOLUTION_API_KEY = originalKey || "";

  const passed = results.length - failures;
  console.log(`\n=== TEST FALATU SOLO WHATSAPP (ADR-154 F4.1) ===`);
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
