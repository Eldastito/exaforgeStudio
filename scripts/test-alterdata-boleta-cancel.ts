/**
 * TESTE — Sincronização de boleta CANCELADA (caso Toulon: boletas × caixa).
 * ----------------------------------------------------------------------------
 * Uma boleta cancelada na AlterData DEPOIS do sync deixa a nossa cópia do
 * VendaMalote contando a mais (ex.: 19/09 boletas R$ 5.666,00 × caixa
 * R$ 5.476,80 = R$ 189,20). Prova que o delta versionado, ao RE-ENTREGAR a
 * boleta com status 'C' e controleVersao maior, atualiza o status gravado —
 * e que os totais que filtram `<> 'C'` (money-audit, comissão) param de
 * contá-la. E prova a DIREÇÃO do indício na conferência: boletas > caixa vira
 * `boletas_acima_do_caixa` (provável cancelamento não propagado), sem correção
 * automática (não se chuta qual boleta pelo total).
 *
 * Uso:  npm run test:alterdata-boleta-cancel
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-boleta-cancel-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-boleta-cancel-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { RetailMoneyAuditService } = await import("../src/server/RetailMoneyAuditService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const resp = (status: number, body: any) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok", expires_in: 3600 }) as any);
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1082"],
    basePattern: "toulon-{module}.apimodaup.com.br", authConfig: { clientId: "u@t", clientSecret: "s" },
  });
  const loja = RetailStoreService.create(A, { name: "Avenida Brasil", code: "1082" });
  const DATE = "2026-09-19";
  // Fechamento do dia com o caixa (system_total) = folha, o número da loja.
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 5476.70, 5476.80, ?)`)
    .run(randomUUID(), A, loja.id, DATE, JSON.stringify({ "1": 5476.8 }));

  const boletaRow = () => db.prepare(`SELECT status, valor FROM retail_pdv_sales WHERE organization_id = ? AND filial = '1082' AND boleta = 'B189' AND sale_date = ?`).get(A, DATE) as any;
  const pdvNet = () => db.prepare(`SELECT COALESCE(SUM(valor),0) AS t, COUNT(*) AS n FROM retail_pdv_sales WHERE organization_id = ? AND filial = '1082' AND sale_date = ? AND COALESCE(status,'N') <> 'C'`).get(A, DATE) as any;

  // ── 1. Delta entrega a boleta VÁLIDA (status 'N', R$ 189,20) ──
  let phase: "vender" | "cancelar" = "vender";
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/VendaMalote/versao/")) {
      const cursorZero = url.includes("/VendaMalote/versao/0");
      if (phase === "vender" && cursorZero) {
        return resp(200, { success: true, data: [{ caixa: { boleta: "B189", filial: "1082", data: `${DATE}T10:00:00`, usuario: "V1", valor: 189.20, vendidas: 1, status: "N" }, controleVersao: 100 }] }) as any;
      }
      // Fase cancelar: o delta re-entrega a MESMA boleta com status 'C' e
      // controleVersao MAIOR (o ERP re-versiona o cancelamento).
      if (phase === "cancelar" && !cursorZero) {
        return resp(200, { success: true, data: [{ caixa: { boleta: "B189", filial: "1082", data: `${DATE}T10:00:00`, usuario: "V1", valor: 189.20, vendidas: 1, status: "C" }, controleVersao: 200 }] }) as any;
      }
      return resp(200, { success: true, data: [] }) as any;
    }
    return resp(200, { success: true, data: [] }) as any;
  });

  await AlterdataSyncRunner.runOrg(A);
  check("1.1 boleta gravada como válida (status N)", boletaRow()?.status === "N" && Number(boletaRow()?.valor) === 189.20, JSON.stringify(boletaRow()));
  check("1.2 conta no total líquido do PDV (1 boleta, 189,20)", pdvNet()?.n === 1 && Number(pdvNet()?.t) === 189.20, JSON.stringify(pdvNet()));
  const audit1 = RetailMoneyAuditService.day(A, DATE).stores.find((s: any) => s.storeId === loja.id);
  check("1.3 conferência: boletas 189,20 < caixa 5.476,80 → boletas_abaixo_do_caixa", audit1.issues.includes("boletas_abaixo_do_caixa") && audit1.differences.boletasVsSystem != null, JSON.stringify({ i: audit1.issues, d: audit1.differences.boletasVsSystem }));

  // ── 2. O delta RE-ENTREGA a boleta cancelada → status vira 'C' ──
  phase = "cancelar";
  await AlterdataSyncRunner.runOrg(A);
  check("2.1 status propagado para 'C' (cancelada) no re-sync", boletaRow()?.status === "C", JSON.stringify(boletaRow()));
  check("2.2 boleta cancelada SAI do total líquido (0 boletas válidas)", pdvNet()?.n === 0 && Number(pdvNet()?.t) === 0, JSON.stringify(pdvNet()));
  const audit2 = RetailMoneyAuditService.day(A, DATE).stores.find((s: any) => s.storeId === loja.id);
  check("2.3 conferência: sem boletas válidas, some o indício boletas × caixa", !audit2.issues.includes("boletas_acima_do_caixa") && !audit2.issues.includes("boletas_abaixo_do_caixa"), JSON.stringify(audit2.issues));

  // ── 3. Direção INVERSA: boletas > caixa vira boletas_acima_do_caixa ──
  // Insere uma boleta órfã histórica que soma acima do caixa do dia.
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '1082', 'BIG', ?, 'V2', 6000.00, 'N')`).run(randomUUID(), A, DATE);
  const audit3 = RetailMoneyAuditService.day(A, DATE).stores.find((s: any) => s.storeId === loja.id);
  check("3.1 boletas 6.000 > caixa 5.476,80 → boletas_acima_do_caixa (provável cancelamento não propagado)", audit3.issues.includes("boletas_acima_do_caixa") && !audit3.issues.includes("boletas_abaixo_do_caixa"), JSON.stringify(audit3.issues));
  check("3.2 delta boletasVsSystem positivo e nomeado", audit3.differences.boletasVsSystem > 0, String(audit3.differences.boletasVsSystem));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} alterdata-boleta-cancel: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
