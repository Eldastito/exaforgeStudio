/**
 * TESTE — Releitura SOB DEMANDA do resumo de um dia (caso Toulon 19/09/26).
 * ----------------------------------------------------------------------------
 * O sync leu o dia CEDO (R$ 2.368,60, sem o débito de R$ 3.108,10 que o TEF
 * consolidou horas depois) e o valor parcial congelou. O botão "Reler
 * Alterdata" da conferência chama refreshDayClosings, que re-lê o resumo de
 * todas as lojas ativas com filial NAQUELE dia e regrava por turno. Prova:
 *   - dia parcial (2.368,60) é reparado para o valor cheio (5.476,80);
 *   - loja cujo resumo devolve 0 NÃO perde o valor bom já gravado (guard
 *     val > 0 do merge por turno — releitura nunca apaga dinheiro);
 *   - loja sem filial é ignorada; isolamento por organização.
 *
 * Uso:  npm run test:alterdata-refresh-day
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-refresh-day-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-refresh-day-1234567890";

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
  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok", expires_in: 3600 }) as any);
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1082", "1005"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "u@t", clientSecret: "s" },
  });

  const avBrasil = RetailStoreService.create(A, { name: "Avenida Brasil", code: "1082" });
  const carioca = RetailStoreService.create(A, { name: "Carioca", code: "1005" });
  RetailStoreService.create(A, { name: "Sem filial" }); // ignorada na releitura
  const DATE = "2026-09-19";

  // Estado congelado do caso real: turno 1 gravado PARCIAL (leitura cedo).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 5476.70, 2368.60, ?)`)
    .run(randomUUID(), A, avBrasil.id, DATE, JSON.stringify({ "1": 2368.60 }));
  // Carioca já tem valor bom gravado; o resumo dela hoje devolve 0 (caixa reaberto/indisponível).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 1000, 1000, ?)`)
    .run(randomUUID(), A, carioca.id, DATE, JSON.stringify({ "1": 1000 }));

  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes(`/ResumoFecharMovimento/1082/${DATE}/1`))
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 5476.8 }, { titulo: "Dinheiro", valor: 800 }, { titulo: "Cartão", valor: 4287.1 }, { titulo: "PIX", valor: 389.7 }] }) as any;
    if (url.includes(`/ResumoFecharMovimento/1005/${DATE}/1`))
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] }) as any;
    return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] }) as any;
  });

  const out = await AlterdataSyncRunner.refreshDayClosings(A, DATE);
  const row = (id: string) => db.prepare(`SELECT system_total, system_turnos_json, informed_total FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(A, id, DATE) as any;

  // ── 1. Dia parcial reparado ──
  const av = row(avBrasil.id);
  check("1.1 turno 1 regravado com o valor cheio (5.476,80)", Number(av?.system_total) === 5476.8, JSON.stringify(av));
  check("1.2 chave do turno substituída (não somada ao parcial)", JSON.parse(av?.system_turnos_json || "{}")["1"] === 5476.8, av?.system_turnos_json);
  check("1.3 informado humano intocado (fechamento aprovado)", Number(av?.informed_total) === 5476.7, `${av?.informed_total}`);
  check("1.4 resultado reporta a loja como aplicada", out.stores.find((s: any) => s.storeId === avBrasil.id)?.applied === true && out.stores.find((s: any) => s.storeId === avBrasil.id)?.total === 5476.8, JSON.stringify(out.stores));

  // ── 2. Releitura zerada NÃO apaga valor bom ──
  const ca = row(carioca.id);
  check("2.1 resumo devolvendo 0 preserva os R$ 1.000 gravados", Number(ca?.system_total) === 1000 && JSON.parse(ca?.system_turnos_json || "{}")["1"] === 1000, JSON.stringify(ca));
  check("2.2 loja com resumo zerado reporta applied=false", out.stores.find((s: any) => s.storeId === carioca.id)?.applied === false);

  // ── 3. Escopo ──
  check("3.1 só lojas com filial entram na releitura", out.stores.length === 2, JSON.stringify(out.stores.map((s: any) => s.filial)));
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const outB = await AlterdataSyncRunner.refreshDayClosings(B, DATE);
  check("3.2 org B sem lojas → releitura vazia", outB.stores.length === 0);

  // ── 4. Recheck pula dia consolidado (aprovado + system_total) ──
  // Reconta as chamadas ao resumo: com o dia consolidado dentro da janela,
  // backfill({skipConsolidated}) não deve bater na API para ele.
  const cariocaCode = "1005";
  let calls = 0;
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/ResumoFecharMovimento/")) calls++;
    return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] }) as any;
  });
  const hoje = new Date().toISOString().slice(0, 10);
  // Carioca (1005) tem HOJE aprovado com system_total > 0 → consolidado.
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, system_turnos_json) VALUES (?, ?, ?, ?, 'approved', 1500, 1500, ?)`)
    .run(randomUUID(), A, carioca.id, hoje, JSON.stringify({ "1": 1500 }));
  const withSkip = await AlterdataSyncRunner.backfillFilialClosings(A, cariocaCode, 1, { skipConsolidated: true });
  check("4.1 dia consolidado é pulado (0 chamadas à API)", calls === 0 && withSkip.skippedConsolidated === 1, JSON.stringify({ calls, skip: withSkip.skippedConsolidated }));
  const cariocaRow = () => db.prepare(`SELECT system_total FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date = ?`).get(A, carioca.id, hoje) as any;
  check("4.2 valor consolidado intocado", Number(cariocaRow()?.system_total) === 1500);
  // O backfill MANUAL (sem skip) relê mesmo o dia aprovado — é ferramenta de reparo.
  calls = 0;
  await AlterdataSyncRunner.backfillFilialClosings(A, cariocaCode, 1);
  check("4.3 backfill manual relê o dia aprovado (2 turnos)", calls === 2, `calls=${calls}`);

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} alterdata-refresh-day: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
