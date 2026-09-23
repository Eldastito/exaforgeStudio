/**
 * TESTE — Raio-X do dia com ESTADOS explícitos de consulta (caso Toulon).
 * ----------------------------------------------------------------------------
 * O raio-x de 19/09 falhou nos 3 turnos por credencial ausente, mas a tela
 * dizia "Nenhuma linha devolvida (caixa não fechado / dia sem movimento)" —
 * transformando "não consegui consultar" em "não houve venda". Prova que o
 * dayXray agora distingue:
 *   - auth_error: todos os turnos falharam por credencial (NUNCA vira "vazio");
 *   - success_empty: a API respondeu, mas sem movimento;
 *   - success_with_rows: veio movimento;
 *   - partial_success: parte dos turnos respondeu, parte falhou;
 * e que dados gravados (fechamento/boletas) continuam disponíveis, rotulados
 * como históricos, com a última data de dados da AlterData.
 *
 * Uso:  npm run test:alterdata-xray-states
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-xray-states-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-xray-states-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const resp = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const loja = RetailStoreService.create(A, { name: "Avenida Brasil", code: "1082" });
  const DATE = "2026-09-19";
  // Dados HISTÓRICOS já no banco: fechamento + boletas (como no caso real).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 5476.70, 5476.80, ?)`)
    .run(randomUUID(), A, loja.id, DATE, JSON.stringify({ "1": 5476.8 }));
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '1082', '1', ?, 'V1', 5666.00, 'N')`).run(randomUUID(), A, DATE);

  // ── 1. SEM credenciais → auth_error, NUNCA "sem movimento" ──
  AlterdataConnectorService.saveSettings(A, { enabled: true, environment: "homolog", rede: "T", filiais: ["1082"], basePattern: "t-{module}.x.br" });
  const xAuth = await AlterdataSyncRunner.dayXray(A, "1082", DATE);
  check("1.1 queryState = auth_error (não success_empty)", xAuth.queryState === "auth_error", xAuth.queryState);
  check("1.2 os 3 turnos marcados como auth", xAuth.turnos.length === 3 && xAuth.turnos.every((t) => t.state === "auth"), JSON.stringify(xAuth.turnos));
  check("1.3 authError exposto p/ banner", !!xAuth.authError && /credenciais/.test(xAuth.authError.message), JSON.stringify(xAuth.authError));
  check("1.4 dados históricos seguem disponíveis (fechamento + boletas)", xAuth.closing?.systemTotal === 5476.8 && xAuth.boletas.total === 5666.00, JSON.stringify({ c: xAuth.closing, b: xAuth.boletas.total }));
  check("1.5 última data de dados da AlterData preenchida", !!xAuth.lastSystemDataAt, String(xAuth.lastSystemDataAt));
  check("1.6 resumo ao vivo vazio (não confundir com dado histórico)", xAuth.resumo.length === 0);

  // ── 2. Credencial OK, API responde VAZIO → success_empty ──
  AlterdataConnectorService.saveSettings(A, { enabled: true, environment: "homolog", rede: "T", filiais: ["1082"], basePattern: "t-{module}.x.br", authConfig: { clientId: "u@t", clientSecret: "s" } });
  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok", expires_in: 3600 }) as any);
  __setAlterdataSyncHttpForTests(async () => resp(200, { success: true, data: [] }) as any);
  const xEmpty = await AlterdataSyncRunner.dayXray(A, "1082", DATE);
  check("2.1 queryState = success_empty (API respondeu, sem movimento)", xEmpty.queryState === "success_empty", xEmpty.queryState);
  check("2.2 turnos marcados como empty", xEmpty.turnos.every((t) => t.state === "empty"), JSON.stringify(xEmpty.turnos));

  // ── 3. API responde COM linhas → success_with_rows ──
  __setAlterdataSyncHttpForTests(async () => resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 5476.8 }, { titulo: "Dinheiro", valor: 800 }] }) as any);
  const xRows = await AlterdataSyncRunner.dayXray(A, "1082", DATE);
  check("3.1 queryState = success_with_rows", xRows.queryState === "success_with_rows", xRows.queryState);
  check("3.2 linhas cruas devolvidas (3 turnos × 2 linhas)", xRows.resumo.length === 6, String(xRows.resumo.length));

  // ── 4. Parte responde, parte falha → partial_success ──
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/1082/" + DATE + "/1")) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 100 }] }) as any;
    return resp(500, { error: "boom" }) as any;
  });
  const xPartial = await AlterdataSyncRunner.dayXray(A, "1082", DATE);
  check("4.1 queryState = partial_success", xPartial.queryState === "partial_success", xPartial.queryState);
  check("4.2 identifica turno que respondeu e os que falharam", xPartial.turnos.find((t) => t.turno === 1)?.state === "rows" && xPartial.turnos.filter((t) => t.state === "error").length === 2, JSON.stringify(xPartial.turnos));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} alterdata-xray-states: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
