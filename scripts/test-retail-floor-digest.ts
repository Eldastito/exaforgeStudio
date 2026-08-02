/**
 * TESTE — ADR-150 Fatia 10 (pós-piloto): comparativo de rede + resumo diário
 * --------------------------------------------------------------------------
 * Prova, offline:
 *   - network(): uma linha por loja ATIVA com os números honestos (declarada
 *     × confirmada, TMA, rupturas); loja inativa fora; ordem alfabética;
 *   - buildMessage(): texto determinístico só com FATOS do dia — conversão
 *     confirmada + média 28d, principal perda com % das perdas, peça mais
 *     pedida, pico por hora + minutos de fila cheia (do sinal da Fatia 8),
 *     unmatched/pendentes, rodapé de calibração; dia sem atendimento → null;
 *   - runDigestPass(): opt-in default DESLIGADO; hora do Brasil respeitada;
 *     envia aos responsáveis da loja (ADR-108) + fallback do número da loja;
 *     dedupe por (org, loja, dia) — 2º passe não reenvia; loja sem turno no
 *     dia não recebe; sem destino não envia nem marca o log;
 *   - settings novos validados (digestHour 0..23);
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-digest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-f10-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorSettingsService } = await import("../src/server/RetailFloorService.js");
  const { RetailFloorNetworkAnalytics } = await import("../src/server/RetailFloorAnalyticsService.js");
  const { RetailFloorDigestService } = await import("../src/server/RetailFloorDigestService.js");
  const { RetailFloorSignalPublisher } = await import("../src/server/RetailFloorSignalPublisher.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  ModuleService.enableModule(A, "retail_floor");

  const store1 = randomUUID(), store2 = randomUUID(), storeInactive = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, whatsapp_identifier) VALUES (?, ?, 'Loja 1005', '1005', '5511999990001')`).run(store1, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1006', '1006')`).run(store2, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Fechada', '1099', 0)`).run(storeInactive, A);
  const vAna = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-01', 'Ana')`).run(vAna, A);
  db.prepare(`INSERT INTO retail_store_responsibles (id, organization_id, store_id, name, whatsapp_identifier) VALUES (?, ?, ?, 'Gerente', '5511888880001')`).run(randomUUID(), A, store1);

  // "Hoje" em UTC (o passe usa a data UTC do now injetado).
  const TODAY = new Date().toISOString().slice(0, 10);
  const shift = randomUUID();
  db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status, opened_at) VALUES (?, ?, ?, 'open', ?)`).run(shift, A, store1, `${TODAY} 09:00:00`);
  db.prepare(`INSERT INTO retail_floor_queue_state (id, organization_id, shift_id, seller_id, status) VALUES (?, ?, ?, ?, 'waiting')`).run(randomUUID(), A, shift, vAna);

  const att = db.prepare(
    `INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, outcome_reason_json, reconciliation_state, declared_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Hoje na loja 1: 1 confirmada (200), 1 unmatched (150), 1 perda por falta de tamanho, 1 pendente (90).
  att.run(randomUUID(), A, store1, shift, vAna, `${TODAY} 10:00:00`, `${TODAY} 10:20:00`, "converted", null, "confirmed", 200);
  att.run(randomUUID(), A, store1, shift, vAna, `${TODAY} 11:00:00`, `${TODAY} 11:30:00`, "converted", null, "unmatched", 150);
  att.run(randomUUID(), A, store1, shift, vAna, `${TODAY} 17:00:00`, `${TODAY} 17:25:00`, "not_converted", JSON.stringify({ category: "product", productDetail: { reason: "missing_size", size: "M" } }), null, null);
  att.run(randomUUID(), A, store1, shift, vAna, `${TODAY} 17:30:00`, `${TODAY} 17:50:00`, "converted", null, "pending", 90);
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Camisa Malha', 129.9)`).run(prod, A);
  db.prepare(`INSERT INTO retail_floor_unmet_demand (id, organization_id, store_id, attendance_id, product_id, reason, created_at) VALUES (?, ?, ?, 'x', ?, 'missing_size', ?)`)
    .run(randomUUID(), A, store1, prod, `${TODAY} 17:05:00`);
  // Sinal de fila cheia do dia (Fatia 8) pro texto citar. Roster=1 e Ana atendeu
  // 20+30+25+20=95min → allBusy 95min ≥ 15 publica.
  RetailFloorSignalPublisher.sweep(A, TODAY);

  // ---- 1. network ----
  const net = RetailFloorNetworkAnalytics.network(A, TODAY, TODAY);
  check("network: só lojas ativas (2), alfabético", net.stores.length === 2 && net.stores[0].storeName === "Loja 1005");
  const n1 = net.stores[0];
  check("network: números da loja 1 (4 atend., conf. 25%, decl. 75%)",
    n1.attendances === 4 && n1.conversionConfirmedPct === 25 && n1.conversionDeclaredPct === 75 && n1.unmatchedCount === 1 && n1.pendingCount === 1 && n1.unmetCount === 1);
  check("network: loja 2 zerada sem quebrar", net.stores[1].attendances === 0 && net.stores[1].conversionConfirmedPct === null);

  // ---- 2. buildMessage ----
  const msg = RetailFloorDigestService.buildMessage(A, store1, TODAY)!;
  check("mensagem: cabeçalho com a loja", msg.includes("Loja 1005"));
  check("mensagem: atendimentos + conversão confirmada", msg.includes("4 atendimentos") && msg.includes("conversão confirmada 25%"));
  check("mensagem: principal perda com % (falta de tamanho, 100%)", msg.includes("falta de tamanho") && msg.includes("100% de 1 perdas"));
  check("mensagem: peça mais pedida sem atender", msg.includes("Camisa Malha"));
  check("mensagem: pico por hora + minutos de fila cheia (do sinal)", /Pico às 17h/.test(msg) && /ocupada por 95min/.test(msg));
  check("mensagem: unmatched e pendentes citados", msg.includes("1 conversão(ões) declarada(s) sem venda no PDV") && msg.includes("1 aguardando o lançamento"));
  check("mensagem: dia sem atendimento → null", RetailFloorDigestService.buildMessage(A, store2, TODAY) === null);
  RetailFloorSettingsService.update(A, { calibrationUntil: "2099-12-31" }, "u1");
  check("mensagem: rodapé de calibração quando vigente", RetailFloorDigestService.buildMessage(A, store1, TODAY)!.includes("calibração"));

  // ---- 3. runDigestPass ----
  const sends: Array<{ target: string; message: string }> = [];
  const send = async (target: string, message: string) => { sends.push({ target, message }); };
  const nowLate = new Date(); nowLate.setUTCHours(23, 30, 0, 0); // 20:30 BRT

  check("opt-in: default desligado → não envia", (await RetailFloorDigestService.runDigestPass(A, { now: nowLate, send })) === 0 && sends.length === 0);
  RetailFloorSettingsService.update(A, { dailyDigestEnabled: true, digestHour: 20 }, "u1");
  const nowEarly = new Date(); nowEarly.setUTCHours(12, 0, 0, 0); // 09:00 BRT
  check("hora: antes da digest_hour (BRT) → não envia", (await RetailFloorDigestService.runDigestPass(A, { now: nowEarly, send })) === 0);
  const sent = await RetailFloorDigestService.runDigestPass(A, { now: nowLate, send });
  check("envio: 1 resumo, responsável + número da loja", sent === 1 && sends.length === 2 &&
    sends.some((s) => s.target === "5511888880001") && sends.some((s) => s.target === "5511999990001"));
  check("envio: loja sem turno hoje (1006) não recebe", sends.every((s) => !s.message.includes("Loja 1006")));
  const again = await RetailFloorDigestService.runDigestPass(A, { now: nowLate, send });
  check("dedupe: 2º passe do dia não reenvia", again === 0 && sends.length === 2);
  const log = db.prepare(`SELECT sent_to FROM retail_floor_digest_log WHERE organization_id = ? AND store_id = ?`).get(A, store1) as any;
  check("log: destinos registrados", !!log && log.sent_to.includes("5511888880001"));

  // ---- 4. validação de settings ----
  let badHour = false;
  try { RetailFloorSettingsService.update(A, { digestHour: 24 }, "u1"); } catch (e: any) { badHour = /0 e 23/.test(e.message); }
  check("settings: digest_hour fora de 0..23 rejeitada", badHour);

  // ---- 5. isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: network de B vazio", RetailFloorNetworkAnalytics.network(B, TODAY, TODAY).stores.length === 0);
  const sendsB: any[] = [];
  RetailFloorSettingsService.update(B, { dailyDigestEnabled: true }, "u1");
  check("Isolamento: passe de B não envia resumo de A", (await RetailFloorDigestService.runDigestPass(B, { now: nowLate, send: async (t: string, m: string) => { sendsB.push(m); } })) === 0 && sendsB.length === 0);

  console.log("\n=== ADR-150 Fatia 10: rede + resumo diário ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
