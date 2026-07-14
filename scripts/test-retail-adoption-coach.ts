/**
 * TESTE — ADR-085 D5: narrativa da IA de adoção (tom parceiro próximo)
 * -------------------------------------------------------------------
 * Prova, offline, a orientação amigável derivada dos bloqueios factuais:
 *   - org vazia → allClear=false, headline com nº de passos, mensagens por
 *     bloqueio no tom parceiro;
 *   - a mensagem do bloqueio de WhatsApp nomeia a loja sem número;
 *   - tudo configurado → allClear=true, headline comemorativa, sem mensagens;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-adoption-coach
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-coach-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-coach-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailActivationService } = await import("../src/server/RetailActivationService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailAdoptionService } = await import("../src/server/RetailAdoptionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const msgFor = (c: any, key: string) => c.messages.find((m: any) => m.key === key)?.message || "";

  // ---- 1. Org vazia ----
  const c0 = RetailAdoptionService.coach(A);
  check("Vazio: allClear=false", c0.allClear === false);
  check("Headline menciona os passos", /passo/.test(c0.headline));
  check("Mensagem de canal no tom parceiro", /WhatsApp/.test(msgFor(c0, "channel_connected")) && /🙌|😊/.test(msgFor(c0, "channel_connected")));

  // ---- 2. Bloqueio de WhatsApp nomeia a loja ----
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'Canal', 'connected')`).run(randomUUID(), A);
  RetailActivationService.activate(A, "u1");
  const s1 = RetailStoreService.create(A, { name: "Loja Com Zap", whatsappIdentifier: "5511999990001" });
  RetailStoreService.create(A, { name: "Loja Sem Zap" });
  const c1 = RetailAdoptionService.coach(A);
  check("Mensagem de WhatsApp nomeia a loja sem número", msgFor(c1, "stores_have_whatsapp").includes("Loja Sem Zap"));

  // ---- 3. Tudo configurado ----
  RetailStoreService.update(A, RetailStoreService.list(A).find((s: any) => s.name === "Loja Sem Zap").id, { whatsappIdentifier: "5511999990002" }, "u1");
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_amount, quota_date) VALUES (?, ?, ?, 8000, date('now'))`).run(randomUUID(), A, s1.id);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, date('now'), 'received', 1000)`).run(randomUUID(), A, s1.id);
  RetailCommissionService.createRule(A, { name: "5%", scope: "store", calculationType: "percent_sales", config: { percent: 5 } }, "u1");
  const c2 = RetailAdoptionService.coach(A);
  check("Tudo pronto: allClear=true e sem mensagens", c2.allClear === true && c2.messages.length === 0);
  check("Headline comemorativa", /🎉/.test(c2.headline));

  // ---- 4. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B tem bloqueios (não herda A)", RetailAdoptionService.coach(B).allClear === false);

  console.log("\n=== ADR-085 D5: narrativa da IA de adoção (tom parceiro) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
