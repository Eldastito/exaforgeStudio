/**
 * TESTE — Fechamento pelo WhatsApp da loja (ADR-083, Fase C / pedido TOULON)
 * -------------------------------------------------------------------------
 * Prova, offline, a ponte inbound de fechamento:
 *   - matchStore casa o número da loja tolerando o 9º dígito BR;
 *   - foto da folha → OCR (extrator injetado) → registra o fechamento do dia,
 *     calcula o desvio vs cota, dá baixa na pendência 'fechamento' e confirma;
 *   - valor em texto (R$ 4.850,00) → registra manualmente;
 *   - baixa confiança na foto → pede conferência ('needs_review');
 *   - texto irrelevante sem pendência → devolve null (segue fluxo normal);
 *   - texto irrelevante COM pendência aberta → orienta;
 *   - parseBrlAmount cobre formatos BR/US;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-whatsapp-closing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-wa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-wa-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService, RetailTaskService, __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");
  const { RetailWhatsAppIntakeService, parseBrlAmount } = await import("../src/server/RetailWhatsAppIntakeService.js");

  const DATE = "2026-07-15";
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1 WHERE organization_id=?`).run(A);
  // Número salvo SEM o 9º dígito; remetente virá COM o 9 (casamento tolerante).
  const store = RetailStoreService.create(A, { name: "Toulon Centro", whatsappIdentifier: "5531988887777" });
  RetailQuotaService.set(A, { storeId: store.id, quotaDate: DATE, quotaAmount: 4000 });
  RetailTaskService.generateDay(A, DATE); // cria a pendência 'fechamento' do dia

  // ---- 0. parseBrlAmount ----
  check("parseBrlAmount: 'R$ 4.850,00' = 4850", parseBrlAmount("R$ 4.850,00") === 4850);
  check("parseBrlAmount: '4850' = 4850", parseBrlAmount("4850") === 4850);
  check("parseBrlAmount: '4850.50' = 4850.5", parseBrlAmount("4850.50") === 4850.5);
  check("parseBrlAmount: 'total 3200' = 3200", parseBrlAmount("total 3200") === 3200);
  check("parseBrlAmount: frase não-numérica = null", parseBrlAmount("bom dia, tudo certo?") === null);

  // ---- 1. matchStore tolerante ao 9º dígito ----
  const matched = RetailWhatsAppIntakeService.matchStore(A, "553188887777"); // sem o 9
  check("matchStore casa o número sem 9º dígito", matched?.id === store.id);
  check("matchStore ignora número desconhecido", RetailWhatsAppIntakeService.matchStore(A, "5511999990000") === null);

  // ---- 2. Fechamento por FOTO (OCR injetado, alta confiança) ----
  __setClosingExtractorForTests(async () => JSON.stringify({ dinheiro: 1500, pix: 3000, credito: 500, total: 5000, confidence: 95 }));
  const r1 = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988887777", imageBase64: "ZmFrZQ==", imageMime: "image/jpeg", contactId: "c1", date: DATE });
  check("Foto: retorna confirmação", !!r1?.reply && r1!.reply.includes("Fechamento"));
  const closing = RetailClosingService.listByDate(A, DATE)[0];
  check("Foto: fechamento registrado com total 5000", Number(closing?.informed_total) === 5000, String(closing?.informed_total));
  check("Foto: desvio vs cota calculado (+1000)", Number(closing?.variance_amount) === 1000, String(closing?.variance_amount));
  check("Foto: alta confiança vira 'extracted'", closing?.status === "extracted", closing?.status);
  check("Foto: confirmação menciona a meta batida", /bateu/i.test(r1!.reply));
  const closingTask = RetailTaskService.listByDate(A, DATE).find((t: any) => t.task_type === "fechamento");
  check("Foto: pendência 'fechamento' recebe baixa", closingTask?.status === "submitted", closingTask?.status);

  // ---- 3. Baixa confiança → needs_review ----
  const DATE2 = "2026-07-16";
  RetailQuotaService.set(A, { storeId: store.id, quotaDate: DATE2, quotaAmount: 4000 });
  __setClosingExtractorForTests(async () => JSON.stringify({ total: 0, confidence: 10 }));
  const r2 = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988887777", imageBase64: "ZmFrZQ==", imageMime: "image/jpeg", contactId: "c1", date: DATE2 });
  const closing2 = RetailClosingService.listByDate(A, DATE2)[0];
  check("Baixa confiança vira 'needs_review'", closing2?.status === "needs_review", closing2?.status);
  check("Baixa confiança pede conferência na resposta", /confer/i.test(r2!.reply));
  __setClosingExtractorForTests(null);

  // ---- 4. Fechamento por VALOR em texto ----
  const DATE3 = "2026-07-17";
  RetailQuotaService.set(A, { storeId: store.id, quotaDate: DATE3, quotaAmount: 5000 });
  const r3 = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988887777", text: "R$ 4.200,00", contactId: "c1", date: DATE3 });
  const closing3 = RetailClosingService.listByDate(A, DATE3)[0];
  check("Texto: valor registrado (4200)", Number(closing3?.informed_total) === 4200, String(closing3?.informed_total));
  check("Texto: desvio negativo calculado (-800)", Number(closing3?.variance_amount) === -800, String(closing3?.variance_amount));
  check("Texto: confirmação menciona que faltou", /faltou/i.test(r3!.reply));

  // ---- 5. Texto irrelevante ----
  const DATE4 = "2026-07-18"; // sem pendência gerada
  const r4 = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988887777", text: "bom dia!", contactId: "c1", date: DATE4 });
  check("Texto irrelevante SEM pendência → null (segue fluxo normal)", r4 === null);

  RetailTaskService.generateDay(A, DATE4); // agora existe pendência de fechamento
  const r5 = await RetailWhatsAppIntakeService.handleInbound(A, store, { senderId: "5531988887777", text: "bom dia!", contactId: "c1", date: DATE4 });
  check("Texto irrelevante COM pendência → orienta", !!r5?.reply && /foto da folha|valor total/i.test(r5!.reply));

  // ---- 6. Isolamento multi-tenant ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  check("Isolamento: número da loja de A não casa na org B", RetailWhatsAppIntakeService.matchStore(B, "5531988887777") === null);

  console.log("\n=== Fechamento pelo WhatsApp da loja (ADR-083, Fase C) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
