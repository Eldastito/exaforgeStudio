/**
 * TESTE — Orçamento do catálogo no prompt da IA de atendimento (20/09/2026).
 * -----------------------------------------------------------------------------
 * Incidente TOULON: após o sync do catálogo (Alterdata), `getProductsContext`
 * despejava o catálogo INTEIRO (com grade tamanho/cor) no prompt — ~1 MILHÃO de
 * tokens → toda chamada da IA morria em 429 "Request too large" e o cliente
 * ficava sem resposta.
 *
 * Prova, offline:
 *  - catálogo pequeno → contexto COMPLETO, byte-igual ao formato de sempre
 *    (0-regressão, sem aviso de parcial);
 *  - catálogo grande → contexto cabe no ORÇAMENTO, o produto que o cliente
 *    citou entra (relevância), e o aviso de catálogo PARCIAL instrui a IA a
 *    não inventar preço/estoque de item não listado;
 *  - variações (grade) continuam listadas;
 *  - catálogo vazio → "" ; isolamento multi-tenant.
 *
 * Uso: npm run test:ai-products-context
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prodctx-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prodctx-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");
  const ctx = (orgId: string, q = "") => (AIOrchestratorService as any).getProductsContext(orgId, q) as Promise<string>;

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Loja ${tag}`);
    return orgId;
  };
  const insP = db.prepare(`INSERT INTO products_services (id, organization_id, type, name, description, price, active, storefront_visible) VALUES (?, ?, 'product', ?, ?, ?, 1, 1)`);

  // ── 1) Catálogo pequeno: contexto completo, sem aviso (0-regressão). ──
  const A = mkOrg("A");
  insP.run(randomUUID(), A, "Camisa Polo Azul", "Malha piquet", 129.9);
  insP.run(randomUUID(), A, "Calça Jeans Slim", "Lavagem escura", 199.9);
  const cA = await ctx(A, "quero uma polo");
  check("1.1 catálogo pequeno entra completo", cA.includes("Camisa Polo Azul") && cA.includes("Calça Jeans Slim"), cA.slice(0, 80));
  check("1.2 sem aviso de parcial no catálogo pequeno", !cA.includes("PARCIAL"));
  check("1.3 cabeçalho de sempre preservado", cA.startsWith("Produtos/Serviços disponíveis"));

  // ── 2) Catálogo com grade (variações) segue listando o estoque por variação. ──
  const pgId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, storefront_visible, has_variants) VALUES (?, ?, 'product', 'Vestido Festa', 349.9, 1, 1, 1)`).run(pgId, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, price, active) VALUES (?, ?, ?, 'Tam M', 349.9, 1)`).run(randomUUID(), A, pgId);
  const cA2 = await ctx(A, "vestido");
  check("2.1 variação (grade) listada", cA2.includes("Vestido Festa") && cA2.includes("Tam M"), "");

  // ── 3) Catálogo GRANDE (o incidente): orçamento + relevância + aviso honesto. ──
  const B = mkOrg("B");
  const seed = db.transaction(() => {
    for (let i = 0; i < 2500; i++) {
      insP.run(randomUUID(), B, `Blusa Ref ${String(i).padStart(4, "0")}`, `Coleção outono, tecido premium, modelagem confortável, referência ${i}`, 99.9 + (i % 50));
    }
    insP.run(randomUUID(), B, "Jaqueta Corta-Vento Neon", "Impermeável, edição limitada", 459.9);
  });
  seed();
  const BUDGET = (AIOrchestratorService as any).PRODUCTS_CONTEXT_BUDGET_CHARS as number;
  const cB = await ctx(B, "tem a jaqueta corta-vento neon?");
  check("3.1 contexto cabe no orçamento (não explode o prompt)", cB.length <= BUDGET + 400, `len=${cB.length} budget=${BUDGET}`);
  check("3.2 produto citado pelo cliente ENTRA (relevância)", cB.includes("Jaqueta Corta-Vento Neon"), "");
  check("3.3 aviso de catálogo parcial presente", cB.includes("PARCIAL") && /de 2501 itens/.test(cB), "");
  check("3.4 aviso instrui a NÃO inventar preço/estoque", cB.includes("NÃO invente"), "");
  const cB2 = await ctx(B, "");
  check("3.5 sem query também respeita o orçamento", cB2.length <= BUDGET + 400, `len=${cB2.length}`);

  // ── 4) Vazio e isolamento. ──
  check("4.1 org sem produto → contexto vazio", (await ctx(mkOrg("Z"), "oi")) === "");
  check("4.2 catálogo de B não vaza pra A", !(await ctx(A, "blusa")).includes("Blusa Ref"), "");

  console.log("\n=== TEST: orçamento do catálogo no prompt da IA ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
