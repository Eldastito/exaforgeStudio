/**
 * TEST — Probe de PREÇO no DELTA (cursor real alto).
 * ----------------------------------------------------------------------------
 * Sintoma de produção (Toulon): o preço responde 200 no cursor 0 (o resync
 * traz 50k preços) mas o DELTA — a chamada com o cursor ALTO guardado — leva
 * server_error (500). O "Testar módulos" só batia cursor 0, então escondia o
 * ponto exato da falha. Este probe lê o CURSOR REAL guardado e reproduz a
 * chamada que falha — decidindo, com prova, ModaUp (o endpoint quebra em cursor
 * alto) vs. nosso (cursor mal montado).
 *
 * Prova, offline (HTTP fake):
 *   - o probe de cursor 0 (rede/tabela/versao) responde 200;
 *   - o probe DELTA no cursor real alto reproduz o 500 (ok=false, status 500);
 *   - o formato tabela/versao segue 404 (não é a rota certa) no cursor alto.
 *
 * Uso: npm run test:alterdata-price-delta-probe
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-price-probe-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-price-probe-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "01", priceTable: "5",
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  // Cursor REAL guardado do preço (o que o delta usa) — o que reproduz o 500.
  const HIGH = "141994718";
  AlterdataConnectorService.setCursor(A, "price", "Preco", "5~0", HIGH);

  // Stub: cursor 0 (rede/tabela) → 200; DELTA no cursor alto (rede/tabela) →
  // 500 (o server_error real); formato tabela/versao → 404 em qualquer cursor.
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes(`/Preco/versao/01/5/${HIGH}`)) return resp(500, "Internal Server Error");
    if (url.includes(`/Preco/versao/01/5/0`)) return resp(200, { success: true, data: [{ produto: "011994036015", tabela: 5, preco1: 59.9, versao: 141994718 }] });
    if (url.includes(`/Preco/versao/5/`)) return resp(404, "Not Found"); // formato tabela/versao — inexistente nesta instalação
    // Demais endpoints do probe (Referencia/Saldo/DataCaixa/…): 200 vazio.
    return resp(200, { success: true, data: [] });
  });

  const probes = await AlterdataSyncRunner.probeOrg(A);
  const find = (needle: string) => probes.find((p) => p.resource.includes(needle));

  // 1) Baseline: cursor 0 no formato que funciona → 200.
  const base = find("Preco (formato rede/tabela/versao)");
  check("cursor 0 (rede/tabela/versao) responde 200", base?.status === 200 && base?.ok === true, JSON.stringify(base));

  // 2) DELTA no cursor real alto → reproduz o 500 (o achado que faltava).
  const deltaRT = probes.find((p) => p.resource.includes("Preco DELTA") && p.resource.includes("rede/tabela"));
  check("DELTA cursor real alto (rede/tabela) reproduz o 500", deltaRT?.status === 500 && deltaRT?.ok === false, JSON.stringify(deltaRT));
  check("probe DELTA cita o cursor real no rótulo", !!deltaRT && deltaRT.resource.includes(HIGH), JSON.stringify(deltaRT?.resource));

  // 3) O formato tabela/versao segue 404 no cursor alto (não é a rota certa).
  const deltaT = probes.find((p) => p.resource.includes("Preco DELTA") && p.resource.includes("(tabela/versao)"));
  check("DELTA formato tabela/versao segue 404", deltaT?.status === 404 && deltaT?.ok === false, JSON.stringify(deltaT));

  // 4) Sem cursor guardado → probe honesto (nada a reproduzir), não inventa.
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  AlterdataConnectorService.saveSettings(B, {
    enabled: true, environment: "homolog", rede: "01", priceTable: "5",
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  const probesB = await AlterdataSyncRunner.probeOrg(B);
  const none = probesB.find((p) => p.resource === "Preco DELTA");
  check("sem cursor guardado → probe honesto (nada a reproduzir)", !!none && none.status === 0 && none.ok === false, JSON.stringify(none));
  check("org B não reproduz DELTA de cursor (isolamento)", !probesB.some((p) => p.resource.includes("Preco DELTA cursor real")), JSON.stringify(probesB.map(p => p.resource)));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Probe de preço no delta (cursor real alto) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
