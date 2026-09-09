/**
 * TEST — F1.3: reset destrutivo do Evolution deixa de ser AUTOMÁTICO.
 * (PRD WhatsApp Unificado — RF-02/INV-07/CA-02.)
 *
 * O caminho de conexão (`connectAndGetQr`) NÃO pode mais apagar/recriar a
 * instância sozinho quando o QR vem vazio (o delete silencioso podia derrubar
 * uma sessão ativa por uma corrida/evento fora de ordem). A capacidade de reset
 * foi preservada, mas só como operação EXPLÍCITA (`resetInstance`).
 *
 * Prova, offline (fetch stubado, zero rede):
 *  - QR vazio no connect → NENHUM DELETE é emitido; retorna needsReset=true.
 *  - QR presente → retorna o QR, sem DELETE.
 *  - state=open → retorna open, sem DELETE.
 *  - sem instanceId → needsReset é falsy (reset precisa do id).
 *  - resetInstance() → EMITE o DELETE + recria (capacidade preservada).
 *  - resetInstance() sem instanceId → recusa honesta.
 *
 * Uso: npm run test:evolution-reset
 */
let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

type Call = { url: string; method: string };
const CFG = { baseUrl: "https://ev.test", apiKey: "admin-key", webhookUrl: "https://app.test/api/webhooks/evolution" };

function jsonResp(body: any, ok = true, status = 200) {
  return {
    ok, status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
  };
}

// Instala um fetch stub roteado por (url, método). Devolve o array de chamadas
// registradas + a função de restauração.
function installFetch(router: (url: string, method: string) => any) {
  const calls: Call[] = [];
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, opts?: any) => {
    const method = (opts?.method || "GET").toUpperCase();
    calls.push({ url: String(url), method });
    return router(String(url), method);
  };
  return { calls, restore: () => { (globalThis as any).fetch = orig; } };
}

async function main() {
  const { EvolutionService } = await import("../src/server/EvolutionService.js");

  // ── A. QR vazio no connect → SEM delete, needsReset=true ──
  {
    const { calls, restore } = installFetch((url) => {
      if (url.includes("/instance/qr")) return jsonResp({ data: { qrcode: "" } });     // QR vazio
      if (url.includes("/instance/connect/")) return jsonResp({ instance: { state: "connecting" } }); // legacy fallback: nada
      return jsonResp({}); // connect POST / webhook/set
    });
    const r = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-123");
    restore();
    const deletes = calls.filter((c) => c.method === "DELETE");
    check("A1 connect com QR vazio NÃO emite DELETE", deletes.length === 0);
    check("A2 retorna ok=false + needsReset=true", r.ok === false && r.needsReset === true);
    check("A3 nenhuma chamada a /instance/delete/", !calls.some((c) => c.url.includes("/instance/delete/")));
  }

  // ── B. QR presente na 1ª tentativa → retorna QR, sem delete ──
  {
    const { calls, restore } = installFetch((url) => {
      if (url.includes("/instance/qr")) return jsonResp({ data: { qrcode: "data:image/png;base64,AAAA" } });
      return jsonResp({});
    });
    const r = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-123");
    restore();
    check("B1 retorna ok=true com QR", r.ok === true && !!r.qrBase64 && r.qrBase64.startsWith("data:image"));
    check("B2 sem DELETE", !calls.some((c) => c.method === "DELETE"));
    check("B3 needsReset ausente quando ok", !r.needsReset);
  }

  // ── C. state=open (já conectada) → open, sem delete ──
  {
    const { calls, restore } = installFetch((url) => {
      if (url.includes("/instance/qr")) return jsonResp({ data: { qrcode: "" } });
      if (url.includes("/instance/connect/")) return jsonResp({ instance: { state: "open" } });
      return jsonResp({});
    });
    const r = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG, "inst-123");
    restore();
    check("C1 retorna state=open", r.ok === true && r.state === "open");
    check("C2 sem DELETE (não reseta sessão conectada)", !calls.some((c) => c.method === "DELETE"));
  }

  // ── D. sem instanceId → needsReset falsy (reset precisa do id) ──
  {
    const { restore } = installFetch((url) => {
      if (url.includes("/instance/qr")) return jsonResp({ data: { qrcode: "" } });
      if (url.includes("/instance/connect/")) return jsonResp({ instance: { state: "connecting" } });
      return jsonResp({});
    });
    const r = await EvolutionService.connectAndGetQr("inst_name", "tok", CFG); // sem instanceId
    restore();
    check("D1 needsReset falsy sem instanceId", r.ok === false && !r.needsReset);
  }

  // ── E. resetInstance() EXPLÍCITO → emite DELETE + recria + QR ──
  {
    const { calls, restore } = installFetch((url) => {
      if (url.includes("/instance/delete/")) return jsonResp({ status: "SUCCESS" });
      if (url.includes("/instance/all")) return jsonResp({ data: [] });                 // não existe → cria
      if (url.includes("/instance/create")) return jsonResp({ data: { token: "newtok", id: "inst-2" } });
      if (url.includes("/instance/qr")) return jsonResp({ data: { qrcode: "data:image/png;base64,BBBB" } });
      return jsonResp({});
    });
    const r = await EvolutionService.resetInstance("inst_name", "inst-1", CFG);
    restore();
    const del = calls.find((c) => c.method === "DELETE" && c.url.includes("/instance/delete/inst-1"));
    check("E1 resetInstance EMITE o DELETE explícito", !!del);
    check("E2 recria a instância (POST /instance/create)", calls.some((c) => c.url.includes("/instance/create") && c.method === "POST"));
    check("E3 retorna QR da instância nova", r.ok === true && !!r.qrBase64 && r.qrBase64.includes("BBBB"));
  }

  // ── F. resetInstance() sem instanceId → recusa honesta, sem delete ──
  {
    const { calls, restore } = installFetch(() => jsonResp({}));
    const r = await EvolutionService.resetInstance("inst_name", "", CFG);
    restore();
    check("F1 recusa sem instanceId", r.ok === false && /instanceId/i.test(r.error || ""));
    check("F2 não emitiu DELETE", !calls.some((c) => c.method === "DELETE"));
  }

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} evolution-reset: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
