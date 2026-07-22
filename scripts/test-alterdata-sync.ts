/**
 * TEST — Motor de sincronização Alterdata (ADR-105, Fase 1a).
 *
 * Prova, offline (HTTP fake), a camada de transporte do delta-sync:
 *   - apiGet monta a URL do módulo + headers de paginação + Bearer;
 *   - syncResource pagina, chama o mapper e AVANÇA o cursor p/ a maior versão;
 *   - 401 força renovação do token no Guardian e repete;
 *   - retry/backoff em 5xx (sem espera real em teste);
 *   - base URL ausente → erro claro.
 *
 * Uso: npm run test:alterdata-sync
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-sync-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-sync-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Resposta HTTP fake compatível com SyncResponse.
function resp(status: number, body: any, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function main() {
  await import("../src/server/db.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataSyncService, __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  AlterdataConnectorService.saveSettings(orgId, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  // Token do Guardian: mock que sempre devolve um token válido.
  let tokenCalls = 0;
  __setAlterdataTokenHttpForTests(async () => { tokenCalls++; return resp(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600 }); });

  // ===== 1. syncResource pagina e avança o cursor =====
  const seen: any[] = [];
  const reqs: string[] = [];
  __setAlterdataSyncHttpForTests(async (url: string, init: any) => {
    reqs.push(url);
    const pagina = Number(init.headers.pagina || 1);
    check("Bearer presente no header", String(init.headers.Authorization || "").startsWith("Bearer "));
    if (pagina === 1) return resp(200, [{ referencia: "R1", versao: 5 }, { referencia: "R2", versao: 7 }], { "total-paginas": "2" });
    return resp(200, [{ referencia: "R3", versao: 9 }], { "total-paginas": "2" });
  });

  const r1 = await AlterdataSyncService.syncResource(orgId, {
    moduleKey: "supply", resource: "Referencia",
    buildPath: (c) => `/api/v1/Referencia/versao/${c}`,
    onItems: async (items) => { seen.push(...items); return items.length; },
  });
  check("importou 3 itens em 2 páginas", r1.imported === 3 && r1.pages === 2, JSON.stringify(r1));
  check("URL usa o subdomínio do módulo supply", reqs[0].startsWith("https://toulon-supply.apimodaup.com.br/api/v1/Referencia/versao/"));
  check("cursor partiu de 0", r1.fromVersion === "0");
  check("cursor avançou para a maior versão (9)", r1.toVersion === "9");
  check("cursor persistido no store", AlterdataConnectorService.getCursor(orgId, "supply", "Referencia", "") === "9");

  // 2ª execução parte do cursor 9 (delta).
  reqs.length = 0;
  __setAlterdataSyncHttpForTests(async (url: string) => { reqs.push(url); return resp(200, [], {}); });
  const r2 = await AlterdataSyncService.syncResource(orgId, {
    moduleKey: "supply", resource: "Referencia",
    buildPath: (c) => `/api/v1/Referencia/versao/${c}`,
    onItems: async () => 0,
  });
  check("delta: 2ª execução parte do cursor 9", reqs[0].includes("/versao/9"));
  check("delta: nada novo → cursor fica em 9", r2.toVersion === "9" && r2.imported === 0);

  // ===== 2. 401 → renova token e repete =====
  let call = 0;
  __setAlterdataSyncHttpForTests(async () => { call++; return call === 1 ? resp(401, {}) : resp(200, [{ referencia: "R9", versao: 20 }], {}); });
  const before = tokenCalls;
  const r3 = await AlterdataSyncService.syncResource(orgId, {
    moduleKey: "supply", resource: "Saldo", filial: "1",
    buildPath: (c) => `/api/v1/Saldo/versao/1/${c}`,
    onItems: async (i) => i.length,
  });
  check("401 dispara renovação do token no Guardian", tokenCalls > before);
  check("após renovar, importa normalmente", r3.imported === 1 && r3.toVersion === "20");
  check("cursor de Saldo é isolado por filial", AlterdataConnectorService.getCursor(orgId, "supply", "Saldo", "1") === "20");

  // ===== 3. retry em 5xx =====
  let n = 0;
  __setAlterdataSyncHttpForTests(async () => { n++; return n === 1 ? resp(503, {}) : resp(200, [{ referencia: "RX", versao: 30 }], {}); });
  const r4 = await AlterdataSyncService.syncResource(orgId, {
    moduleKey: "supply", resource: "Grade",
    buildPath: (c) => `/api/v1/Grade/versao/${c}`,
    onItems: async (i) => i.length,
  });
  check("retry em 503 e depois sucesso", n === 2 && r4.imported === 1, `n=${n}`);

  // ===== 3b. versão via `controleVersao` (campo real do spec Supply) =====
  __setAlterdataSyncHttpForTests(async () => resp(200, [{ referenciaId: "R50", controleVersao: 123 }], {}));
  const r4b = await AlterdataSyncService.syncResource(orgId, {
    moduleKey: "supply", resource: "ReferenciaCv",
    buildPath: (c) => `/api/v1/Referencia/versao/${c}`,
    onItems: async (i) => i.length,
  });
  check("cursor avança pelo campo controleVersao", r4b.toVersion === "123", r4b.toVersion);

  // ===== 4. base URL ausente → erro claro =====
  const orgNoBase = `org_${randomUUID().slice(0, 8)}`;
  AlterdataConnectorService.saveSettings(orgNoBase, { enabled: true, authConfig: { clientId: "a", clientSecret: "b" } });
  let baseErr = false;
  try { await AlterdataSyncService.apiGet(orgNoBase, "supply", "/api/v1/Referencia/versao/0"); } catch (e: any) { baseErr = /base URL/i.test(String(e.message)); }
  check("base URL ausente → erro claro", baseErr === true);

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Motor de sync Alterdata (ADR-105, Fase 1a) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
