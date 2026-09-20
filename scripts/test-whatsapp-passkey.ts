/**
 * TESTE — F5 do PRD Conexão WhatsApp (20/09/2026): PASSKEY como etapa, não erro.
 * -----------------------------------------------------------------------------
 * Falha crítica nº 1 do PRD (confirmada na F0 + fonte 0.7.2): quando a conta é
 * direcionada a passkey, o GetQr devolve passkeyStage + passkeyCode +
 * passkeyOpenUrl (instance_service.go:99-101,457-463; TTL ~5 min) — e o
 * ZapFlow capturava só o estágio, DESCARTAVA link/código e convertia a etapa
 * válida em erro mandando o operador pro Manager.
 *
 * Prova, offline (fetch global stubado com a resposta REAL do provedor):
 *  - GetQr com cerimônia ativa → ok:true, state 'awaiting_passkey', com
 *    stage/code/openUrl (SUCESSO PENDENTE — nunca ok:false);
 *  - canal fica status 'awaiting_passkey' e a resposta do provision carrega o
 *    passkey; o audit NUNCA carrega o código nem a URL;
 *  - servidor sem PASSKEY_PUBLIC_URL (<SET_PASSKEY_PUBLIC_URL>) →
 *    misconfigured:true e SEM openUrl (não entrega link quebrado);
 *  - refresh (novo provision) reusa a MESMA instância — não duplica canal;
 *  - ChannelStateService trata 'awaiting_passkey' como pareamento, não erro;
 *  - QR normal segue byte-idêntico (0-regressão).
 *
 * Uso: npm run test:whatsapp-passkey
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-passkey-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-passkey-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Modo do provedor stubado: 'passkey' | 'passkey_nourl' | 'qr'.
let providerMode: "passkey" | "passkey_nourl" | "qr" = "passkey";
function jsonResp(body: any, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u.includes("/instance/all")) return jsonResp({ data: [] });
  if (u.includes("/instance/create")) return jsonResp({ message: "success", data: { token: "tok-inst", id: "id-1" } });
  if (u.includes("/instance/qr")) {
    // Formato REAL do evolution-go 0.7.2 com cerimônia de passkey ativa.
    if (providerMode === "passkey") return jsonResp({ message: "success", data: { passkeyStage: "confirmation", passkeyCode: "482-115", passkeyOpenUrl: "https://public-evo.test/passkey-ceremony/tok123" } });
    if (providerMode === "passkey_nourl") return jsonResp({ message: "success", data: { passkeyStage: "challenge", passkeyOpenUrl: "<SET_PASSKEY_PUBLIC_URL>" } });
    return jsonResp({ message: "success", data: { qrcode: "data:image/png;base64,QRDATA", code: "2@abc" } });
  }
  return jsonResp({});
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { EvolutionService } = await import("../src/server/EvolutionService.js");
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { ChannelStateService } = await import("../src/server/ChannelStateService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);

  // ── 1) EvolutionService: cerimônia ativa = SUCESSO PENDENTE, nunca erro. ──
  const e1 = await EvolutionService.provision("inst_passkey_a");
  check("1.1 ok:true (antes era ok:false 'conclua pelo manager')", e1.ok === true, JSON.stringify({ ok: e1.ok, error: e1.error }));
  check("1.2 state 'awaiting_passkey'", e1.state === "awaiting_passkey", e1.state);
  check("1.3 stage + code + openUrl capturados (antes descartados)", e1.passkey?.stage === "confirmation" && e1.passkey?.code === "482-115" && e1.passkey?.openUrl === "https://public-evo.test/passkey-ceremony/tok123", JSON.stringify(e1.passkey));
  check("1.4 misconfigured:false com URL válida", e1.passkey?.misconfigured === false, String(e1.passkey?.misconfigured));

  // ── 2) Provisionamento: canal 'awaiting_passkey' + resposta com a etapa. ──
  const r2 = await Svc.provision(A, "u1", { mode: "new" });
  check("2.1 provision ok com passkey na resposta", r2.ok === true && r2.passkey?.code === "482-115", JSON.stringify({ ok: r2.ok, pk: !!r2.passkey }));
  const ch = db.prepare(`SELECT status FROM channels WHERE organization_id = ? AND id = ?`).get(A, String(r2.channelId)) as any;
  check("2.2 canal fica status 'awaiting_passkey'", ch?.status === "awaiting_passkey", ch?.status);
  // Segredo curto NUNCA em log/audit: nenhuma linha de auditoria carrega o código nem a URL.
  const leaks = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND (metadata_json LIKE '%482-115%' OR metadata_json LIKE '%passkey-ceremony%')`).get(A) as any;
  check("2.3 código/URL da passkey NUNCA no audit", Number(leaks?.n) === 0, `linhas com vazamento: ${leaks?.n}`);
  const stage = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND metadata_json LIKE '%passkeyStage%'`).get(A) as any;
  check("2.4 o ESTÁGIO (não-segredo) fica auditado", Number(stage?.n) >= 1, String(stage?.n));

  // ── 3) Refresh não duplica instância/canal. ──
  const r3 = await Svc.provision(A, "u1", { mode: "new" });
  const nCh = (db.prepare(`SELECT COUNT(*) n FROM channels WHERE organization_id = ?`).get(A) as any).n;
  check("3.1 refresh reusa a MESMA instância (1 canal só)", r3.ok === true && Number(nCh) === 1 && r3.instanceName === r2.instanceName, `canais=${nCh}`);

  // ── 4) Máquina de estados: passkey é PAREAMENTO, não erro. ──
  const st = ChannelStateService.state(A, String(r2.channelId));
  check("4.1 session = awaiting_pairing (mesma dimensão do QR)", st?.session === "awaiting_pairing", JSON.stringify(st?.session));

  // ── 5) Servidor sem PASSKEY_PUBLIC_URL: honesto, sem link quebrado. ──
  providerMode = "passkey_nourl";
  const e5 = await EvolutionService.provision("inst_passkey_b");
  check("5.1 <SET_PASSKEY_PUBLIC_URL> → misconfigured:true", e5.ok === true && e5.passkey?.misconfigured === true, JSON.stringify(e5.passkey));
  check("5.2 openUrl NÃO é entregue quebrada", e5.passkey?.openUrl === undefined, String(e5.passkey?.openUrl));

  // ── 6) 0-regressão: QR normal segue igual. ──
  providerMode = "qr";
  const e6 = await EvolutionService.provision("inst_qr_c");
  check("6.1 QR flui como antes (qrBase64, sem passkey)", e6.ok === true && String(e6.qrBase64 || "").startsWith("data:image") && !e6.passkey, JSON.stringify({ qr: !!e6.qrBase64, pk: !!e6.passkey }));

  (globalThis as any).fetch = origFetch;

  console.log("\n=== TEST: F5 — passkey como etapa (nunca erro) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
