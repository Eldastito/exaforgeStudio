/**
 * TESTE — NuvemFiscalAdapter (ADR-200, Fase 3 PR2). HTTP mockado; sem rede.
 * Cobre OAuth token + cache, mapeamento de erro, distribuição (mapBatch,
 * classificação, gunzip base64), backoff 429 e manifestação.
 * Uso: npm run test:nuvemfiscal-adapter
 */
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function res(status: number, jsonObj: any, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null }, json: async () => jsonObj };
}

async function main() {
  const { NuvemFiscalAdapter } = await import("../src/server/providers/NuvemFiscalAdapter.js");

  const PROC_XML = '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35240612345678000199550010000001231000000122"/></NFe></nfeProc>';
  const RES_XML = '<resNFe><chNFe>35240612345678000199550010000001231000000122</chNFe></resNFe>';
  const gzB64 = gzipSync(Buffer.from(PROC_XML, "utf8")).toString("base64");

  // ---- Mock fetch: roteia por URL e conta chamadas de token --------------------
  let tokenCalls = 0; let lastAuthHeader: string | null = null; let lastUrl = "";
  const creds = { clientId: "cid", clientSecret: "sec", scope: "distribuicao-nfe" };

  function makeAdapter(router: (url: string, init: any) => any) {
    const fetchFn = async (url: string, init: any = {}) => {
      lastUrl = url;
      if (url.includes("/oauth/token")) { tokenCalls++; return res(200, { access_token: "tok-1", expires_in: 3600 }); }
      lastAuthHeader = init?.headers?.Authorization || null;
      return router(url, init);
    };
    return new NuvemFiscalAdapter(creds, { fetchFn, ambiente: "homologacao" });
  }

  // 1. probe OK + token cache ----------------------------------------------------
  tokenCalls = 0;
  const a1 = makeAdapter(() => res(200, {}));
  const p = await a1.probe();
  check("probe → connected", p.connected === true && p.capabilities?.scope === "distribuicao-nfe");
  await a1.listSinceNsu({ cnpj: "12345678000199", ultNsu: "0" });
  await a1.listSinceNsu({ cnpj: "12345678000199", ultNsu: "10" });
  check("token é cacheado (1 chamada de token p/ 3 usos)", tokenCalls === 1, `tokenCalls=${tokenCalls}`);
  check("Bearer no header da distribuição", lastAuthHeader === "Bearer tok-1");

  // 2. probe falha (401) ---------------------------------------------------------
  const aBad = new NuvemFiscalAdapter(creds, { ambiente: "homologacao", fetchFn: async (u: string) => u.includes("/oauth/token") ? res(401, { error: "invalid_client" }) : res(200, {}) });
  const pb = await aBad.probe();
  check("probe 401 → connected false + invalid_client", pb.connected === false && pb.errorCode === "invalid_client");

  // 3. distribuição: mapBatch, classificação, gunzip ----------------------------
  const batchPayload = {
    ultimo_nsu: "152", maximo_nsu: "160",
    documentos: [
      { nsu: "151", tipo_documento: "resumo", chave_acesso: "35240612345678000199550010000001231000000122", resumo: RES_XML },
      { nsu: "152", tipo_documento: "nfeProc", conteudo: gzB64 },
    ],
  };
  const a2 = makeAdapter(() => res(200, batchPayload));
  const batch = await a2.listSinceNsu({ cnpj: "12345678000199", ultNsu: "150" });
  check("cursor: ultNsu/maxNsu mapeados", batch.ultNsu === "152" && batch.maxNsu === "160");
  check("2 documentos mapeados", batch.documents.length === 2);
  check("doc1 classificado resNFe + chave", batch.documents[0].schema === "resNFe" && batch.documents[0].accessKey === "35240612345678000199550010000001231000000122");
  check("doc2 gunzip base64 → XML procNFe", batch.documents[1].schema === "procNFe" && (batch.documents[1].xml || "").includes("nfeProc"));
  check("URL de distribuição usa ult_nsu e ambiente", lastUrl.includes("ult_nsu=150") && lastUrl.includes("ambiente=homologacao"));

  // 4. backoff 429 ---------------------------------------------------------------
  const a3 = makeAdapter(() => res(429, {}, { "Retry-After": "120" }));
  const blocked = await a3.listSinceNsu({ cnpj: "12345678000199", ultNsu: "5" });
  check("429 → blocked (sem lançar), cursor preservado", !!blocked.blocked && blocked.blocked!.reason === "rate_limited" && blocked.ultNsu === "5");

  // 5. manifestação --------------------------------------------------------------
  let manifestBody: any = null;
  const a4 = makeAdapter((_u, init) => { manifestBody = JSON.parse(init.body); return res(200, { protocolo: "135240000012345", status: "135" }); });
  const m = await a4.manifest({ cnpj: "12345678000199", accessKey: "35240612345678000199550010000001231000000122", event: "ciencia_operacao" });
  check("manifest ok + protocolo", m.ok === true && m.protocol === "135240000012345");
  check("manifest envia tpEvento 210210 (Ciência)", manifestBody?.tipo_evento === "210210");

  console.log("\n=== NuvemFiscalAdapter — Fase 3 PR2 (ADR-200) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); process.exit(1); });
