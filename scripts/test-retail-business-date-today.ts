/**
 * TESTE — "hoje" server-side = DIA COMERCIAL (fuso), não UTC.
 * ----------------------------------------------------------------------------
 * Continua a Fatia 1A (ANALISE-PDR-ESTABILIZACAO-TOULON): sites server-side de
 * "hoje" que a auditoria deixou em UTC (não são seletor de data que o usuário
 * troca — são caminhos de escrita/leitura sem escolha humana), corrigidos para
 * `BusinessTimeService.businessDate(orgId, now)`:
 *   1. `RetailRevenueBridgeService.revenueForPeriod/salesCountForPeriod('today')`
 *      (Dashboard/Diretor) — âncora no dia comercial;
 *   2. `RetailWhatsAppIntakeService.handleInbound` sem `payload.date` — o
 *      fechamento entra no dia comercial (o exato sintoma "boleta some" após 21h).
 * Honra o kill-switch 6B (`retail_business_date_v1` off → UTC, 0-regressão).
 *
 * `now` é injetado (mesmo padrão de `BusinessTimeService`), então o teste é
 * DETERMINÍSTICO e PEGA a regressão independente da hora de parede da CI.
 *
 * Uso:  npm run test:retail-business-date-today
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-bizdate-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-retail-bizdate-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailRevenueBridgeService } = await import("../src/server/RetailRevenueBridgeService.js");
  const { RetailFeatureFlagService } = await import("../src/server/RetailFeatureFlagService.js");
  const { BusinessTimeService } = await import("../src/server/BusinessTimeService.js");
  const { RetailClosingService, __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");
  const { RetailWhatsAppIntakeService } = await import("../src/server/RetailWhatsAppIntakeService.js");

  // Instante NOTURNO no Rio: 2026-09-11T01:00Z == 2026-09-10 22:00 SP.
  // → dia comercial (SP) = 2026-09-10; dia UTC = 2026-09-11. É a janela do bug.
  const nowEve = new Date("2026-09-11T01:00:00Z");
  const BIZ = "2026-09-10";  // dia comercial de nowEve (SP)
  const UTC = "2026-09-11";  // dia UTC de nowEve

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_daily_closing_enabled) VALUES (?, ?, 'A', 'active', 1)`).run(randomUUID(), A);
  RetailFeatureFlagService.set(A, "business_date", true); // Fatia 1A ligada (tz SP default)
  check("0.1 businessDate(nowEve) = dia comercial SP (não UTC)", BusinessTimeService.businessDate(A, nowEve) === BIZ);

  const store = RetailStoreService.create(A, { name: "Toulon 1079", code: "1079", whatsappIdentifier: "5531988887777" });
  RetailRevenueBridgeService.setEnabled(A, true);

  // ── 1. Receita/vendas "hoje" ancoram no dia COMERCIAL ──
  const mkClosing = (date: string, informed: number) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, 0)`)
      .run(randomUUID(), A, store.id, date, informed);
  mkClosing(BIZ, 1000); // dia comercial de nowEve → deve contar
  mkClosing(UTC, 500);  // dia UTC de nowEve (amanhã comercial) → NÃO deve contar
  check("1.1 receita 'today' conta o dia comercial (1000), não o UTC", RetailRevenueBridgeService.revenueForPeriod(A, "today", nowEve) === 1000,
    String(RetailRevenueBridgeService.revenueForPeriod(A, "today", nowEve)));

  const mkSale = (date: string, boleta: string) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor) VALUES (?, ?, '1079', ?, ?, 100)`)
      .run(randomUUID(), A, boleta, date);
  mkSale(BIZ, "B1"); mkSale(UTC, "B2");
  check("1.2 contagem de vendas 'today' = 1 (só o dia comercial)", RetailRevenueBridgeService.salesCountForPeriod(A, "today", nowEve) === 1,
    String(RetailRevenueBridgeService.salesCountForPeriod(A, "today", nowEve)));

  // ── 2. Kill-switch OFF → volta ao dia UTC (0-regressão) ──
  RetailFeatureFlagService.set(A, "business_date", false);
  check("2.1 OFF: receita 'today' volta ao dia UTC (500)", RetailRevenueBridgeService.revenueForPeriod(A, "today", nowEve) === 500,
    String(RetailRevenueBridgeService.revenueForPeriod(A, "today", nowEve)));
  check("2.2 OFF: contagem 'today' = 1 no dia UTC", RetailRevenueBridgeService.salesCountForPeriod(A, "today", nowEve) === 1);
  RetailFeatureFlagService.set(A, "business_date", true); // religa p/ a parte 3

  // ── 3. Intake de fechamento sem data → entra no dia COMERCIAL (org C limpa,
  //       pra não colidir com os fechamentos semeados de A no mesmo dia) ──
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 1000, pix: 2000, total: 3000, confidence: 95 }));
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_daily_closing_enabled) VALUES (?, ?, 'C', 'active', 1)`).run(randomUUID(), C);
  RetailFeatureFlagService.set(C, "business_date", true);
  const storeC = RetailStoreService.create(C, { name: "Loja C", code: "C1", whatsappIdentifier: "5531955554444" });
  const r = await RetailWhatsAppIntakeService.handleInbound(
    C, storeC, { senderId: "5531955554444", imageBase64: "ZmFrZQ==", imageMime: "image/jpeg", contactId: "c1" }, nowEve
  );
  check("3.1 intake responde confirmação", !!r?.reply);
  check("3.2 fechamento entra no dia COMERCIAL (não some pro UTC)", RetailClosingService.listByDate(C, BIZ).length === 1,
    `biz=${RetailClosingService.listByDate(C, BIZ).length} utc=${RetailClosingService.listByDate(C, UTC).length}`);
  check("3.3 NADA registrado no dia UTC", RetailClosingService.listByDate(C, UTC).length === 0);

  // ── 4. Intake com kill-switch OFF → dia UTC (0-regressão) ──
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_daily_closing_enabled) VALUES (?, ?, 'B', 'active', 1)`).run(randomUUID(), B);
  RetailFeatureFlagService.set(B, "business_date", false); // kill-switch OFF explícito (default é ON)
  const storeB = RetailStoreService.create(B, { name: "Loja B", code: "B1", whatsappIdentifier: "5531977776666" });
  const rB = await RetailWhatsAppIntakeService.handleInbound(
    B, storeB, { senderId: "5531977776666", imageBase64: "ZmFrZQ==", imageMime: "image/jpeg", contactId: "c2" }, nowEve
  );
  check("4.1 OFF: intake responde", !!rB?.reply);
  check("4.2 OFF: fechamento no dia UTC (legado)", RetailClosingService.listByDate(B, UTC).length === 1,
    `biz=${RetailClosingService.listByDate(B, BIZ).length} utc=${RetailClosingService.listByDate(B, UTC).length}`);

  // ── 5. isolamento ──
  check("5.1 org B não vê fechamento de C", RetailClosingService.listByDate(B, BIZ).length === 0 && RetailClosingService.listByDate(C, UTC).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-business-date-today: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
