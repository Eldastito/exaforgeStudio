/**
 * TEST — Probe HISTÓRICO do ResumoFecharMovimento (diagnóstico do backfill).
 * ----------------------------------------------------------------------------
 * O "Recuperar fechamentos" busca o ResumoFecharMovimento em DIAS PASSADOS. Se o
 * endpoint só servir o dia atual, o backfill aplica 0 e a loja segue zerada. O
 * probeOrg passa a bater o ResumoFecharMovimento em datas passadas (7/21/45 dias)
 * para provar, autenticado, se o endpoint serve histórico. Prova, offline:
 *   - os probes HISTÓRICOS aparecem no resultado do probeOrg;
 *   - quando a data passada tem venda, o probe volta 200 com "Total de Vendas".
 *
 * Uso: npm run test:alterdata-resumo-historical-probe
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-resumo-hist-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-resumo-hist-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}
const dateNDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  RetailStoreService.create(A, { name: "Grande Rio", code: "1006", whatsappIdentifier: "5521900001006" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "01", priceTable: "5", filiais: ["1006"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  const d45 = dateNDaysAgo(45);
  const hoje = new Date().toISOString().slice(0, 10);
  __setAlterdataSyncHttpForTests(async (url: string) => {
    // Dia de HOJE → caixa aberto (tudo 0). Dia PASSADO (45d) → tem venda.
    if (url.includes(`/ResumoFecharMovimento/1006/${hoje}/`)) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] });
    if (url.includes(`/ResumoFecharMovimento/1006/${d45}/`)) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 1234.56 }] });
    if (url.includes(`/ResumoFecharMovimento/`)) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] });
    return resp(200, { success: true, data: [] });
  });

  const probes = await AlterdataSyncRunner.probeOrg(A);
  const hist = probes.filter((p) => p.resource.includes("HISTÓRICO"));
  check("probeOrg inclui os probes HISTÓRICOS (7/21/45 dias)", hist.length === 3, JSON.stringify(hist.map((p) => p.resource)));
  const p45 = hist.find((p) => p.resource.includes(d45));
  check("probe histórico de 45d atrás responde 200", p45?.status === 200 && p45?.ok === true, JSON.stringify(p45));
  check("probe histórico de 45d atrás mostra Total de Vendas com valor (serve histórico)", !!p45 && p45.snippet.includes("Total de Vendas") && p45.snippet.includes("1234.56"), JSON.stringify(p45?.snippet?.slice(0, 120)));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Probe histórico do ResumoFecharMovimento ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
