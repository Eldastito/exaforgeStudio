/**
 * TEST — IA Maestro sugere a transferência (ADR-083, Fase G / Fase 2).
 *
 * Prova o laço sinais → ação → transferência:
 *   - o publisher emite `retail_transfer_suggested` a partir da GRADE FURADA
 *     (loja zerada num tamanho que outra tem sobrando), com os IDs na evidência;
 *   - RetailTransferService.fromSignal cria a transferência (in_transit, source
 *     'ai_suggested', vinculada ao sinal), dá baixa na origem e RESOLVE o sinal;
 *   - o publisher NÃO re-sugere o que já está em trânsito;
 *   - quando a grade deixa de estar furada, o sinal auto-resolve.
 *
 * Uso: npm run test:retail-transfer-signal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-transfer-signal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-transfer-signal-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailTransferService } = await import("../src/server/RetailTransferService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede', 'active')`).run(randomUUID(), A);
  const donor = RetailStoreService.create(A, { name: "Loja Sobra", code: "01", whatsappIdentifier: "5511900000001" });
  const needy = RetailStoreService.create(A, { name: "Loja Falta", code: "02", whatsappIdentifier: "5511900000002" });

  // Produto com 2 tamanhos. A loja "needy" TEM o produto (tam. P) mas está ZERADA
  // no tam. M — que a loja "donor" tem sobrando (3). → grade furada no M.
  const prod = randomUUID(), vP = randomUUID(), vM = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(prod, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size) VALUES (?, ?, ?, 'P', 'P')`).run(vP, A, prod);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size) VALUES (?, ?, ?, 'M', 'M')`).run(vM, A, prod);
  RetailInventoryService.setQuantity(A, donor.id, prod, vM, 3);  // sobra no M
  RetailInventoryService.setQuantity(A, donor.id, prod, vP, 5);  // tem P também (evita furada reversa)
  RetailInventoryService.setQuantity(A, needy.id, prod, vP, 2);  // carrega o produto (tam. P)
  RetailInventoryService.setQuantity(A, needy.id, prod, vM, 0);  // zerada no M → única furada
  const openTransferSignals = () => BusinessSignalService.list(A, { status: "open" }).filter((s: any) => s.signal_type === "retail_transfer_suggested");

  // ===== 1. Publisher SUGERE a transferência =====
  RetailOpsSignalPublisher.run(A);
  let sug = openTransferSignals();
  check("emite 1 sugestão de transferência (grade furada no M)", sug.length === 1, JSON.stringify(sug.map((s: any) => s.signal_type)));
  const ev = sug[0]?.evidence || {};
  check("evidência carrega origem/destino/produto/variante + qtd sugerida", ev.originStoreId === donor.id && ev.destStoreId === needy.id && ev.productId === prod && ev.variantId === vM && ev.quantitySuggested === 1, JSON.stringify(ev));

  // ===== 2. fromSignal cria a transferência e resolve o sinal =====
  const t = RetailTransferService.fromSignal(A, sug[0].id, "u1");
  check("transferência criada em trânsito, source 'ai_suggested'", t.status === "in_transit" && t.source === "ai_suggested", JSON.stringify({ s: t.status, src: t.source }));
  check("vínculo com o sinal gravado", t.signal_id === sug[0].id, String(t.signal_id));
  check("baixa na origem (3 → 2)", Number(RetailInventoryService.get(A, donor.id, prod, vM)?.quantity_available) === 2);
  check("sinal foi resolvido (some dos abertos)", openTransferSignals().length === 0);

  // ===== 3. Publisher NÃO re-sugere o que está em trânsito =====
  RetailOpsSignalPublisher.run(A);
  check("não re-sugere transferência já em trânsito", openTransferSignals().length === 0, JSON.stringify(openTransferSignals().map((s: any) => s.evidence)));

  // ===== 4. Recebida a transferência, a grade deixa de estar furada =====
  RetailTransferService.receive(A, t.id, {}, "u2");
  check("destino recebeu o M (0 → 1)", Number(RetailInventoryService.get(A, needy.id, prod, vM)?.quantity_available) === 1);
  RetailOpsSignalPublisher.run(A);
  check("sem nova sugestão após a grade normalizar", openTransferSignals().length === 0);

  console.log("\n=== IA sugere transferência (Fase 2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
