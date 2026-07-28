/**
 * TEST — Transferência: geografia + melhor horário (ADR-083, Fase G / Fase 3).
 *
 * Prova:
 *   - haversineKm mede a distância entre coordenadas; hasCoords valida;
 *   - a loja guarda endereço/cidade/lat/long;
 *   - com dois doadores para o MESMO furo, a IA sugere o MAIS PRÓXIMO (distância
 *     na evidência);
 *   - suggestBestWindow devolve a hora mais TRANQUILA da loja (dados do PDV).
 *
 * Uso: npm run test:retail-transfer-geo
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-transfer-geo-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-transfer-geo-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { haversineKm, hasCoords } = await import("../src/server/geo.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailTransferService } = await import("../src/server/RetailTransferService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  // ===== 1. Haversine + hasCoords =====
  // Rio (~-22.91,-43.17) a São Paulo (~-23.55,-46.63) ≈ 360 km.
  check("haversine Rio↔SP ≈ 360 km", near(haversineKm(-22.91, -43.17, -23.55, -46.63), 360, 25), String(haversineKm(-22.91, -43.17, -23.55, -46.63)));
  check("haversine mesmo ponto = 0", haversineKm(-22.9, -43.2, -22.9, -43.2) === 0);
  check("hasCoords rejeita (0,0) e não-número", !hasCoords(0, 0) && !hasCoords("x", 1) && hasCoords(-22.9, -43.2));
  check("haversine sem coords → NaN", Number.isNaN(haversineKm(null, null, -22.9, -43.2)));

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede', 'active')`).run(randomUUID(), A);

  // ===== 2. Loja guarda geografia =====
  const near1 = RetailStoreService.create(A, { name: "Loja Perto", code: "01", whatsappIdentifier: "5511900000001", address: "Rua A, 10", city: "Rio", latitude: -22.91, longitude: -43.20 });
  const far = RetailStoreService.create(A, { name: "Loja Longe", code: "02", whatsappIdentifier: "5511900000002", city: "Rio", latitude: -23.30, longitude: -43.20 });
  const needy = RetailStoreService.create(A, { name: "Loja Falta", code: "03", whatsappIdentifier: "5511900000003", latitude: -22.90, longitude: -43.20 });
  const stored = RetailStoreService.get(A, near1.id);
  check("loja persiste endereço/cidade/lat/long", stored?.address === "Rua A, 10" && stored?.city === "Rio" && near(Number(stored?.latitude), -22.91, 0.001), JSON.stringify({ a: stored?.address, lat: stored?.latitude }));

  // ===== 3. Dois doadores p/ o mesmo furo → IA sugere o MAIS PRÓXIMO =====
  const prod = randomUUID(), vP = randomUUID(), vM = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(prod, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size) VALUES (?, ?, ?, 'P', 'P')`).run(vP, A, prod);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size) VALUES (?, ?, ?, 'M', 'M')`).run(vM, A, prod);
  for (const st of [near1, far]) { RetailInventoryService.setQuantity(A, st.id, prod, vM, 3); RetailInventoryService.setQuantity(A, st.id, prod, vP, 5); }
  RetailInventoryService.setQuantity(A, needy.id, prod, vP, 2);  // carrega o produto
  RetailInventoryService.setQuantity(A, needy.id, prod, vM, 0);  // furo no M

  RetailOpsSignalPublisher.run(A);
  const sug = BusinessSignalService.list(A, { status: "open" }).filter((s: any) => s.signal_type === "retail_transfer_suggested");
  check("emite 1 sugestão (um furo, doador escolhido)", sug.length === 1, String(sug.length));
  const ev = sug[0]?.evidence || {};
  check("escolhe o doador MAIS PRÓXIMO (Loja Perto)", ev.originStoreId === near1.id, JSON.stringify({ origin: ev.originStore, dist: ev.distanceKm }));
  check("evidência traz a distância (~1 km) e o melhor horário", ev.distanceKm != null && ev.distanceKm < 5 && typeof ev.bestTime === "string", JSON.stringify({ d: ev.distanceKm, t: ev.bestTime }));

  // ===== 4. Melhor horário = hora mais tranquila (PDV da loja de origem "01") =====
  // Muitas vendas às 15h, poucas às 9h → melhor horário ≈ 09h.
  const insSale = db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas) VALUES (?, ?, '01', ?, date('now','-2 days'), ?, 10, 1)`);
  for (let i = 0; i < 8; i++) insSale.run(randomUUID(), A, `b15_${i}`, "15:30");
  insSale.run(randomUUID(), A, "b09", "09:15");
  const win = RetailTransferService.suggestBestWindow(A, "01");
  check("melhor horário aponta a hora mais tranquila (09h)", win.includes("09h"), win);
  check("sem dados de PDV → horário padrão", RetailTransferService.suggestBestWindow(A, "99").includes("início da manhã"));

  console.log("\n=== Transferência: geografia + melhor horário (Fase 3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
