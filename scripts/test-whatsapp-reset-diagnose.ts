/**
 * TESTE — 16/09/2026: reset explícito + diagnóstico + contrato real evolution-go.
 * ------------------------------------------------------------------------------
 * Fatia motivada pelo 2º relato do dono ("QR continua sem aparecer") + print do
 * manager (instâncias existem, todas close). Prova, offline (fetch stubado):
 *   - RESET (a cura da F1.3 que nunca teve rota/botão): acha o id no provedor,
 *     apaga+recria+QR, atualiza o canal, audita; instância inexistente no
 *     provedor → cai no provision (criar do zero é o reset possível);
 *   - DIAGNÓSTICO token-safe: config → alcance → instâncias → a da org existe?
 *     NUNCA vaza apiKey nem a URL completa; sem env → honesto;
 *   - LOGOUT corrigido contra o fonte real (DELETE /instance/logout com o
 *     TOKEN DA INSTÂNCIA no header apikey — antes: path com nome + chave
 *     global = 404/401 sempre);
 *   - PASSKEY honesto: GetQr devolvendo passkeyStage → erro explica o fluxo
 *     WebAuthn em vez de "QR vazio".
 *
 * Uso:  npm run test:whatsapp-reset-diagnose
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reset-diag-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-reset-diag-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "GLOBAL-ADMIN-KEY"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Provedor stubado com estado controlável + gravação das chamadas.
let providerInstances: Array<{ name: string; id: string; token: string }> = [];
let qrMode: "qr" | "passkey" | "empty400" = "qr";
// Logs simulados da instância (4º relato: o motivo real do QR vazio vive aqui).
let providerLogs: Array<{ timestamp: string; level: string; message: string }> = [];
const calls: Array<{ method: string; url: string; apikey?: string }> = [];
function jsonResp(body: any, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    const u = String(url);
    calls.push({ method: opts?.method || "GET", url: u, apikey: opts?.headers?.apikey });
    if (u.includes("/instance/all")) return jsonResp({ message: "success", data: providerInstances });
    if (u.includes("/instance/delete/")) return jsonResp({ message: "success" });
    if (u.includes("/instance/create")) return jsonResp({ data: { token: "created-tok", id: "created-id" } });
    if (u.endsWith("/instance/logout")) {
      const inst = providerInstances.find(i => i.token === opts?.headers?.apikey);
      return inst ? jsonResp({ message: "success" }) : jsonResp({ error: "unauthorized" }, false, 401);
    }
    if (u.includes("/instance/logs/")) return jsonResp(providerLogs);
    if (u.includes("/instance/qr")) {
      if (qrMode === "passkey") return jsonResp({ message: "success", data: { passkeyStage: "started" } });
      if (qrMode === "empty400") return jsonResp({ error: "no QR code available. Please wait a moment and try again" }, false, 400);
      return jsonResp({ message: "success", data: { qrcode: "data:image/png;base64,QRNEW" } });
    }
    return jsonResp({});
  };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { EvolutionService } = await import("../src/server/EvolutionService.js");
  const restore = installFetch();

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const chId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'ExaForge', 'ExaForge', 'disconnected')`).run(chId, A);

  // ── 1) RESET com instância existente no provedor: delete pelo id + recreate + QR. ──
  providerInstances = [{ name: "ExaForge", id: "exa-id-1", token: "exa-tok-1" }];
  const r1 = await Svc.reset(A, "owner1");
  check("1.1 reset ok + QR novo", r1.ok === true && !!r1.qrBase64 && r1.qrBase64.includes("QRNEW"));
  check("1.2 apagou a instância ZUMBI pelo id certo", calls.some(c => c.method === "DELETE" && c.url.includes("/instance/delete/exa-id-1")));
  check("1.3 canal atualizado pra awaiting_qr", (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chId) as any)?.status === "awaiting_qr");
  const audit1 = db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'WHATSAPP_INSTANCE_RESET'`).get(A) as any;
  check("1.4 reset auditado", Number(audit1?.c || 0) >= 1);

  // ── 2) RESET sem instância no provedor → provision (criar do zero). ──
  providerInstances = [];
  calls.length = 0;
  const r2 = await Svc.reset(A, "owner1");
  check("2.1 sem instância no provedor → cria do zero e devolve QR", r2.ok === true && !!r2.qrBase64);
  check("2.2 nenhum delete disparado (nada a apagar)", !calls.some(c => c.method === "DELETE" && c.url.includes("/instance/delete/")));

  // ── 3) DIAGNÓSTICO token-safe. ──
  providerInstances = [{ name: "ExaForge", id: "exa-id-1", token: "exa-tok-1" }];
  const d = await Svc.diagnose(A);
  check("3.1 config presente reportada", d.configured?.evolutionBaseUrl === true && d.configured?.evolutionApiKey === true);
  check("3.2 provedor acessível com latência", d.reachable?.ok === true && typeof d.reachable.latencyMs === "number");
  check("3.3 instâncias contadas + a da org localizada", d.instancesInProvider === 1 && d.orgInstance?.existsInProvider === true, JSON.stringify(d.orgInstance));
  const dump = JSON.stringify(d);
  check("3.4 NUNCA vaza a apiKey nem a URL completa", !dump.includes("GLOBAL-ADMIN-KEY") && !dump.includes("https://ev.test"));
  check("3.5 host mascarado presente", d.providerHost === "ev.test");

  // ── 4) DIAGNÓSTICO sem env → honesto. ──
  const oldUrl = process.env.EVOLUTION_BASE_URL; delete process.env.EVOLUTION_BASE_URL;
  const d2 = await Svc.diagnose(A);
  check("4.1 sem EVOLUTION_BASE_URL → configured false + motivo claro", d2.configured?.evolutionBaseUrl === false && /não configurados/.test(d2.reachable?.error || ""));
  process.env.EVOLUTION_BASE_URL = oldUrl;

  // ── 5) LOGOUT corrigido (contrato real): token DA INSTÂNCIA no header. ──
  calls.length = 0;
  const okLogout = await EvolutionService.logoutInstance("ExaForge");
  check("5.1 logout aceito com o TOKEN da instância (não a chave global)", okLogout === true);
  const logoutCall = calls.find(c => c.url.endsWith("/instance/logout") && c.method === "DELETE");
  check("5.2 DELETE /instance/logout com apikey=<token da instância>", logoutCall?.apikey === "exa-tok-1", logoutCall?.apikey);

  // ── 6) PASSKEY honesto. F5 do PRD Conexão WhatsApp (20/09/2026): passkey
  //      deixou de ser ERRO e virou SUCESSO PENDENTE (awaiting_passkey) — o
  //      operador conclui a etapa no ZapFlow, não no Manager. Cobertura
  //      completa da etapa em test:whatsapp-passkey. ──
  qrMode = "passkey";
  const r6 = await EvolutionService.connectAndGetQr("ExaForge", "exa-tok-1");
  check("6.1 passkeyStage → awaiting_passkey (etapa, nunca mais erro)", r6.ok === true && r6.state === "awaiting_passkey" && r6.passkey?.stage === "started", JSON.stringify({ ok: r6.ok, state: r6.state, stage: r6.passkey?.stage }));
  qrMode = "qr";

  // ── 7) 3º relato ("não está nem criando"): o ERRO REAL do provision falho
  //      fica visível no diagnóstico (lastProvisionError da auditoria). ──
  const { logAuthEvent } = await import("../src/server/auditLog.js");
  logAuthEvent(A, "u1", "u1", "WHATSAPP_PROVISION_FAILED", { instanceName: "ExaForge", error: "Evolution 401: invalid global api key" });
  const d3 = await Svc.diagnose(A);
  check("7.1 diagnóstico surfaça o último erro real de provisionamento", /Evolution 401/.test(d3.lastProvisionError?.error || ""), JSON.stringify(d3.lastProvisionError));
  check("7.2 erro surfaçado ainda é token-safe", !JSON.stringify(d3).includes("GLOBAL-ADMIN-KEY"));

  // ── 8) 4º relato ("criou a instância mas o QR não sai"): o diagnóstico traz
  //      os LOGS da instância do provedor — é lá que o evolution-go conta por
  //      que a sessão whatsmeow não gerou QR (Connect() morre em goroutine). ──
  providerLogs = [
    { timestamp: "2026-09-16T17:48:40Z", level: "INFO", message: "[exa-id-1] Starting client" },
    { timestamp: "2026-09-16T17:48:45Z", level: "ERROR", message: "[exa-id-1] Failed to connect: websocket dial timeout (apikey GLOBAL-ADMIN-KEY)" },
  ];
  const d4 = await Svc.diagnose(A);
  check("8.1 diagnóstico traz providerLogs da instância", Array.isArray(d4.providerLogs) && d4.providerLogs.length === 2, JSON.stringify(d4.providerLogs));
  check("8.2 log de erro presente com o motivo real", d4.providerLogs?.some((l: any) => /Failed to connect/.test(l.message)));
  check("8.3 segredo REDIGIDO nos logs surfaçados", !JSON.stringify(d4.providerLogs).includes("GLOBAL-ADMIN-KEY"));

  // ── 9) QR vazio agora carrega o PORQUÊ: corpo do 400 do provedor + último
  //      log de erro da instância (antes: só "Evolution retornou vazio"). ──
  qrMode = "empty400";
  const r9 = await EvolutionService.connectAndGetQr("ExaForge", "exa-tok-1", undefined, "exa-id-1");
  check("9.1 erro carrega a resposta do provedor (corpo do 400)", r9.ok === false && /no QR code available/.test(r9.error || ""), r9.error);
  check("9.2 erro carrega o último log de ERRO da instância", /Failed to connect/.test(r9.error || ""), r9.error);
  check("9.3 needsReset sinalizado (instanceId presente)", r9.needsReset === true);
  check("9.4 segredo redigido também no erro", !(r9.error || "").includes("GLOBAL-ADMIN-KEY"));
  qrMode = "qr";

  restore();
  console.log("\n=== TEST: Reset + diagnóstico + contrato real (16/09) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
