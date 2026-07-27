/**
 * TEST — Venda por PESO (kg) no catálogo + Balcão PDV.
 *
 * A vitrine já vendia por peso; esta fatia leva o `sale_mode` para onde o
 * autônomo (peixaria/açougue/hortifruti) opera: o cadastro de produto e o
 * Balcão do Comigo. Prova:
 *   - POST /api/products aceita sale_mode='weight' + porções (sale_options.steps
 *     em gramas) e grava; serviço/reserva ignoram sale_mode (fica 'unit');
 *   - GET /api/products devolve sale_mode + sale_options_json;
 *   - PATCH troca o modo e, ao sair de weight, zera as porções antigas;
 *   - Balcão: uma venda por peso (qty = kg fracionário, unitPrice = preço/kg)
 *     soma total = kg × preço/kg (BalcaoService aceita qty REAL).
 *
 * Uso:  npm run test:product-sale-mode
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sale-mode-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sale-mode-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const productsRouter = (await import("../src/server/routes/products.js")).default;
  const { BalcaoService } = await import("../src/server/BalcaoService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Peixaria do Zé', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Zé', ?)`).run(userId, orgId, `ze_${userId.slice(0, 6)}@x.com`);

  // App com auth fake (injeta org/usuário) + router real de produtos.
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = orgId; req.user = { userId }; next(); });
  app.use("/api/products", productsRouter);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/products`;
  const post = async (body: any) => { const r = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const patch = async (id: string, body: any) => { const r = await fetch(`${base}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const getAll = async () => { const r = await fetch(base); return { status: r.status, json: await r.json().catch(() => ([])) }; };
  const rowOf = (id: string) => db.prepare(`SELECT sale_mode, sale_options_json, type, price FROM products_services WHERE id = ?`).get(id) as any;

  try {
    // ===== 1. Criar produto por PESO (peixaria: preço por kg + porções) =====
    const r1 = await post({ type: "product", name: "Tilápia fresca", price: 39.9, sale_mode: "weight", sale_options: { steps: [500, 1000, 2000] } });
    check("POST weight responde ok", r1.status === 200 && !!r1.json.id, JSON.stringify(r1.json));
    const w = rowOf(r1.json.id);
    check("grava sale_mode='weight'", w?.sale_mode === "weight", JSON.stringify(w));
    check("grava porções em gramas (steps)", w?.sale_options_json === JSON.stringify({ steps: [500, 1000, 2000] }), String(w?.sale_options_json));
    check("preço por kg preservado (39.9)", near(Number(w?.price), 39.9));

    // Porções inválidas (0/negativas) são filtradas; lista vazia vira null.
    const r1b = await post({ type: "product", name: "Camarão", price: 79.9, sale_mode: "weight", sale_options: { steps: [0, -3] } });
    check("steps inválidos → sale_options_json null", rowOf(r1b.json.id)?.sale_options_json === null, String(rowOf(r1b.json.id)?.sale_options_json));

    // ===== 2. Produto comum continua 'unit' (default) =====
    const r2 = await post({ type: "product", name: "Lata de óleo", price: 12 });
    check("produto sem sale_mode → 'unit'", rowOf(r2.json.id)?.sale_mode === "unit");

    // ===== 3. Serviço ignora sale_mode (fica 'unit' mesmo se pedido weight) =====
    const r3 = await post({ type: "service", name: "Limpeza de peixe", price: 5, sale_mode: "weight" });
    check("serviço nunca vende por peso (fica 'unit')", rowOf(r3.json.id)?.sale_mode === "unit");

    // ===== 4. GET devolve sale_mode + sale_options_json =====
    const all = await getAll();
    const listed = (Array.isArray(all.json) ? all.json : []).find((p: any) => p.id === r1.json.id);
    check("GET /products expõe sale_mode/sale_options_json", listed?.sale_mode === "weight" && !!listed?.sale_options_json, JSON.stringify(listed && { sm: listed.sale_mode, so: listed.sale_options_json }));

    // ===== 5. PATCH troca o modo; sair de weight zera as porções antigas =====
    const p5 = await patch(r1.json.id, { sale_mode: "unit" });
    check("PATCH para 'unit' ok", p5.status === 200);
    const w5 = rowOf(r1.json.id);
    check("ao sair de weight, sale_mode='unit' e porções zeradas", w5?.sale_mode === "unit" && w5?.sale_options_json === null, JSON.stringify(w5));

    // ===== 6. Balcão: venda por peso soma kg × preço/kg =====
    const o = BalcaoService.openOrder(orgId, { sessionAlias: "Balcão" });
    BalcaoService.addItem(orgId, o, { productId: r1.json.id, name: "Tilápia fresca", qty: 1.35, unitPrice: 39.9 }); // 53.865 → 53.87
    BalcaoService.addItem(orgId, o, { name: "Lata de óleo", qty: 2, unitPrice: 12 });                              // 24
    const ord = db.prepare("SELECT total FROM comigo_orders WHERE id = ?").get(o) as any;
    check("total = 1,35kg × 39,90 + 2×12 = 77,87", near(Number(ord.total), 77.87), String(ord.total));
    const wItem = db.prepare("SELECT qty, unit_price FROM comigo_order_items WHERE order_id = ? AND name = 'Tilápia fresca'").get(o) as any;
    check("linha por peso guarda qty fracionário (1.35) e preço/kg", near(Number(wItem.qty), 1.35) && near(Number(wItem.unit_price), 39.9), JSON.stringify(wItem));
  } finally {
    server.close();
  }

  console.log("\n=== Venda por peso (catálogo + Balcão) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
