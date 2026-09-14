/**
 * TEST — Diagnóstico de FILIAIS ÓRFÃS (vendem no ERP, sem loja no ZapFlow).
 * ----------------------------------------------------------------------------
 * Cruza as filiais que vendem (VendaMalote resumo por filial) com as lojas
 * cadastradas. As órfãs (venda>0, sem loja) ganham a última data de movimento
 * (DataCaixa/UltimoMovimento) — uma órfã com movimento recente é candidata a
 * "pra onde uma loja migrou de código". Prova, offline:
 *   - filiais com loja aparecem com hasStore + nome; sem última data;
 *   - filiais órfãs (venda>0, sem loja) trazem lastMovement + lastFinalized;
 *   - filiais com venda 0 são ignoradas; ordenado por venda desc.
 *
 * Uso: npm run test:alterdata-orphan-filiais
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-orphan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-orphan-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  // Lojas cadastradas: 1006 (Grande Rio) e 1082 (Av. brasil). 1066 é órfã.
  RetailStoreService.create(A, { name: "Grande Rio", code: "1006", whatsappIdentifier: "5521900001006" });
  RetailStoreService.create(A, { name: "Av. brasil", code: "1082", whatsappIdentifier: "5521900001082" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "01", filiais: ["1006", "1082"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  const RECENT = "2026-09-13";
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/VendaMalote/relatorio/resumo/porfilial")) {
      return resp(200, { success: true, data: [
        { filial: "1006", totalVenda: 9808586.06 },   // tem loja (Grande Rio)
        { filial: "1066", totalVenda: 1974013.50 },   // ÓRFÃ (sem loja) — a candidata
        { filial: "1082", totalVenda: 1244365.81 },   // tem loja (Av. brasil)
        { filial: "1005", totalVenda: 0 },            // venda 0 → ignorada
        { filial: "99", totalVenda: 0 },              // venda 0 → ignorada
      ] });
    }
    if (url.includes("/DataCaixa/UltimoMovimento/1066")) {
      return resp(200, { success: true, data: { data: `${RECENT}T00:00:00`, filial: "1066", finalizado2: 1, turno: 1 } });
    }
    return resp(200, { success: true, data: [] });
  });

  const rows = await AlterdataSyncRunner.orphanFiliaisReport(A);
  const by = (f: string) => rows.find((r) => r.filial === f);

  check("só filiais com venda>0 entram (5 no ERP → 3 no relatório)", rows.length === 3, JSON.stringify(rows.map((r) => r.filial)));
  check("ordenado por venda desc (1006 primeiro)", rows[0]?.filial === "1006", JSON.stringify(rows.map((r) => r.filial)));
  check("1006 tem loja (Grande Rio) e não busca movimento", by("1006")?.hasStore === true && by("1006")?.storeName === "Grande Rio" && by("1006")?.lastMovement === null, JSON.stringify(by("1006")));
  check("1082 tem loja (Av. brasil)", by("1082")?.hasStore === true && by("1082")?.storeName === "Av. brasil", JSON.stringify(by("1082")));
  check("1066 é ÓRFÃ (vende, sem loja)", by("1066")?.hasStore === false && by("1066")?.storeName === null, JSON.stringify(by("1066")));
  check("1066 traz a última data de movimento (candidata a loja migrada)", by("1066")?.lastMovement === RECENT && by("1066")?.lastFinalized === true, JSON.stringify(by("1066")));
  check("filiais com venda 0 (1005, 99) são ignoradas", !by("1005") && !by("99"), JSON.stringify(rows.map((r) => r.filial)));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Filiais órfãs (vendem no ERP, sem loja) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
