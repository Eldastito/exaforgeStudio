/**
 * TEST — Filtro "ocultar sem estoque" no catálogo (GET /api/products?inStock=1).
 *
 * Prova que o filtro esconde SÓ o que está sem estoque de verdade — produto com
 * controle de estoque e disponível ≤ 0 — mantendo serviços e itens sem controle.
 * Confere também o X-Total-Count (paginação correta com o filtro).
 *
 * Uso:  npm run test:product-instock
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-instock-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-instock-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const productsRouter = (await import("../src/server/routes/products.js")).default;
  const storefrontRouter = (await import("../src/server/routes/storefront.js")).default;

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'U', ?)`).run(userId, orgId, `u_${userId.slice(0, 6)}@x.com`);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = orgId; req.user = { userId }; next(); });
  app.use("/api/products", productsRouter);
  app.use("/api/storefront", storefrontRouter);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/products`;
  const post = (body: any) => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  const get = async (qs: string) => { const r = await fetch(`${base}${qs}`); return { total: Number(r.headers.get("X-Total-Count") || 0), rows: await r.json() }; };
  const getStore = async (qs: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/storefront/products${qs}`); return { total: Number(r.headers.get("X-Total-Count") || 0), rows: await r.json() }; };

  try {
    // 4 itens: com estoque, SEM estoque (0), serviço, e produto sem controle.
    await post({ type: "product", name: "Camisa com estoque", price: 50, stock_control_enabled: true, initial_stock: 5 });
    await post({ type: "product", name: "Calça zerada", price: 80, stock_control_enabled: true, initial_stock: 0 });
    await post({ type: "service", name: "Ajuste de barra", price: 20 });
    await post({ type: "product", name: "Boné sem controle", price: 30, stock_control_enabled: false });

    const all = await get("?limit=100");
    check("sem filtro: 4 itens (X-Total-Count)", all.total === 4 && all.rows.length === 4, JSON.stringify({ total: all.total, n: all.rows.length }));

    const only = await get("?limit=100&inStock=1");
    const names = (only.rows as any[]).map(r => r.name);
    check("inStock=1: esconde a zerada (3 itens)", only.total === 3 && only.rows.length === 3, JSON.stringify({ total: only.total, names }));
    check("inStock=1: NÃO traz a 'Calça zerada'", !names.includes("Calça zerada"), JSON.stringify(names));
    check("inStock=1: mantém produto com estoque, serviço e sem-controle", names.includes("Camisa com estoque") && names.includes("Ajuste de barra") && names.includes("Boné sem controle"), JSON.stringify(names));

    // Busca + filtro combinam (a contagem reflete os dois).
    const combo = await get("?limit=100&inStock=1&q=Camisa");
    check("inStock + busca combinam (só a Camisa)", combo.total === 1 && (combo.rows as any[])[0]?.name === "Camisa com estoque", JSON.stringify({ total: combo.total }));

    // Vitrine: mesmo filtro (só type='product' — serviço nem entra).
    const storeAll = await getStore("?limit=100");
    check("vitrine sem filtro: 3 produtos (sem o serviço)", storeAll.total === 3, JSON.stringify({ total: storeAll.total }));
    const storeIn = await getStore("?limit=100&inStock=1");
    const sNames = (storeIn.rows as any[]).map(r => r.name);
    check("vitrine inStock=1: esconde a zerada (2 produtos)", storeIn.total === 2 && !sNames.includes("Calça zerada"), JSON.stringify({ total: storeIn.total, sNames }));
    check("vitrine inStock=1: mantém com-estoque e sem-controle", sNames.includes("Camisa com estoque") && sNames.includes("Boné sem controle"), JSON.stringify(sNames));
  } finally {
    server.close();
  }

  console.log("\n=== Filtro ocultar sem estoque (catálogo) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
