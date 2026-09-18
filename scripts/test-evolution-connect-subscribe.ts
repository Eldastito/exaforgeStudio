/**
 * TEST — F1.4: a conexão consolidada (`EvolutionService`) assina os eventos do
 * webhook em MAIÚSCULO (PRD WhatsApp Unificado — achado A7).
 *
 * A rota legada `/api/evolution/instance/connect` (server.ts) passou a DELEGAR ao
 * `EvolutionService.provision`/`connectAndGetQr` em vez de reimplementar inline
 * com `subscribe: ["messages","connection"]` MINÚSCULO — que o Evolution GO
 * descarta em silêncio (o event_types.go valida case-sensitive), deixando a
 * instância SEM eventos. Este teste trava que o serviço consolidado assina
 * MESSAGE/CONNECTION/QRCODE (maiúsculo) e os eventos do webhook/set também.
 *
 * Uso: npm run test:evolution-connect-subscribe
 */
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const CFG = { baseUrl: "https://ev.test", apiKey: "admin-key", webhookUrl: "https://app.test/api/webhooks/evolution" };

function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}

async function main() {
  const { EvolutionService } = await import("../src/server/EvolutionService.js");

  // Captura os corpos enviados a /instance/connect e /webhook/set.
  const bodies: Record<string, any> = {};
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    const u = String(url);
    let parsed: any = null; try { parsed = opts?.body ? JSON.parse(opts.body) : null; } catch { /* noop */ }
    if (u.includes("/instance/connect") && !u.includes("/instance/connect/")) bodies.connect = parsed;
    if (u.includes("/webhook/set/")) bodies.webhookSet = parsed;
    if (u.includes("/instance/qr")) return jsonResp({ data: { qrcode: "data:image/png;base64,ZZZ" } });
    return jsonResp({});
  };

  const r = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-1");
  (globalThis as any).fetch = orig;

  // ── subscribe do /instance/connect em MAIÚSCULO ──
  const sub = bodies.connect?.subscribe || [];
  check("1.1 /instance/connect assina em MAIÚSCULO", Array.isArray(sub) && sub.includes("MESSAGE") && sub.includes("CONNECTION"));
  check("1.2 NÃO usa minúsculo (bug A7)", !sub.includes("messages") && !sub.includes("connection"));
  check("1.3 inclui QRCODE", sub.includes("QRCODE"));

  // ── eventos do webhook/set em MAIÚSCULO ──
  const evts = bodies.webhookSet?.webhook?.events || [];
  check("2.1 webhook/set usa MESSAGES_UPSERT/CONNECTION_UPDATE (maiúsculo)", evts.includes("MESSAGES_UPSERT") && evts.includes("CONNECTION_UPDATE"));

  // ── e o QR foi obtido pelo campo data.qrcode (minúsculo do GO) ──
  check("3.1 QR obtido (data.qrcode) → ok", r.ok === true && !!r.qrBase64 && r.qrBase64.includes("ZZZ"));

  // ── 4. INV-07 (caso real 18/09): sessão JÁ LOGADA no provedor → "open", sem QR ──
  // O /instance/connect revive o cliente; se a credencial vale, ele re-loga e
  // GetQr nunca terá QR (e ainda REINICIA o cliente a cada chamada — nocivo).
  // Pré-check no /instance/all: connected=true → devolve state "open" direto.
  let qrCalls = 0;
  (globalThis as any).fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/instance/all")) return jsonResp({ data: [{ name: "inst_name", id: "i1", token: "tok", connected: true }] });
    if (u.includes("/instance/qr")) { qrCalls++; return jsonResp({}); }
    return jsonResp({});
  };
  const r4 = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-1");
  check("4.1 provedor 'open' antes do QR → ok + state open", r4.ok === true && r4.state === "open");
  check("4.2 NÃO pede QR em sessão logada (GetQr reinicia o cliente)", qrCalls === 0);

  // ── 5. "session already logged in" no meio do fluxo → "open" (sem 35s de retry) ──
  (globalThis as any).fetch = async (url: string) => {
    const u = String(url);
    if (u.includes("/instance/all")) return jsonResp({ data: [{ name: "inst_name", id: "i1", token: "tok", connected: false }] });
    if (u.includes("/instance/qr")) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: "session already logged in" }), json: async () => ({}), headers: { get: () => "application/json" } };
    }
    return jsonResp({});
  };
  const t5 = Date.now();
  const r5 = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-1");
  check("5.1 'already logged in' → ok + state open (não é falha de QR)", r5.ok === true && r5.state === "open");
  check("5.2 corta o retry (não espera as 5 rodadas)", Date.now() - t5 < 10_000);
  (globalThis as any).fetch = orig;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} evolution-connect-subscribe: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
