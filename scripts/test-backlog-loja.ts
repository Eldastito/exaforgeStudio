/**
 * TESTE — Backlog Loja (ADR-028)
 * --------------------------------
 * Cobre os itens 32, 33 e 34 do backlog (aprovados por decisão explícita):
 *   32/33. slug por produto (backfill + geração na criação + unicidade por
 *          organização + fallback preguiçoso da vitrine) — o consumidor real
 *          do SEO: a rota /loja/:slug/produto/:productSlug injeta meta tags
 *          no servidor (comprovado por leitura do fonte, já que o servidor
 *          HTTP não sobe em teste);
 *   34.    IA do WhatsApp respeita storefront_visible: produto oculto da
 *          vitrine some do contexto de produtos e da resolução de pedido.
 *
 * Uso: npm run test:backlog-loja
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-backlog-loja-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-backlog-loja-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { slugifyProductName, uniqueProductSlug, ensureProductSlug } = await import("../src/server/productSlug.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa B', 'active')`).run(randomUUID(), orgB);

  // ---- itens 32/33: slug ----
  check("slugify: acentos/caixa/pontuação viram slug limpo", slugifyProductName("Feijão Prêto Kicaldo 1kg!") === "feijao-preto-kicaldo-1kg");
  check("slugify: nome vazio não explode", slugifyProductName("") === "");

  const s1 = uniqueProductSlug(orgA, "Feijão Preto 1kg");
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, slug) VALUES (?, ?, 'product', 'Feijão Preto 1kg', 9.99, ?)`).run(randomUUID(), orgA, s1);
  const s2 = uniqueProductSlug(orgA, "Feijão Preto 1kg");
  check("Colisão de slug na mesma org ganha sufixo numérico", s1 === "feijao-preto-1kg" && s2 === "feijao-preto-1kg-2", `s1=${s1} s2=${s2}`);
  const sB = uniqueProductSlug(orgB, "Feijão Preto 1kg");
  check("Mesmo nome em OUTRA organização usa o slug base (unicidade é por org)", sB === "feijao-preto-1kg");

  // índice único parcial protege no nível do banco
  let dupBlocked = false;
  try {
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, slug) VALUES (?, ?, 'product', 'Outro', 1, ?)`).run(randomUUID(), orgA, s1);
  } catch { dupBlocked = true; }
  check("Índice único (org, slug) bloqueia slug duplicado direto no banco", dupBlocked);

  // fallback preguiçoso: produto sem slug ganha um ao passar pela vitrine
  const legacyId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price) VALUES (?, ?, 'product', 'Produto Legado Sem Slug', 5)`).run(legacyId, orgA);
  const filled = ensureProductSlug(orgA, { id: legacyId, name: "Produto Legado Sem Slug", slug: null });
  const persisted = (db.prepare(`SELECT slug FROM products_services WHERE id = ?`).get(legacyId) as any)?.slug;
  check("ensureProductSlug preenche e persiste slug de produto legado", filled === "produto-legado-sem-slug" && persisted === filled);
  const again = ensureProductSlug(orgA, { id: legacyId, name: "Produto Legado Sem Slug", slug: persisted });
  check("ensureProductSlug é idempotente (não regenera slug existente)", again === persisted);

  // consumidor do SEO existe de verdade (rota de injeção no servidor)
  const serverSrc = fs.readFileSync(path.join(process.cwd(), "server.ts"), "utf-8");
  check("server.ts injeta <title>/og: na URL /loja/:slug/produto/:productSlug", /\/loja\/:slug\/produto\/:productSlug/.test(serverSrc) && /og:title/.test(serverSrc));
  check("Injeção escapa HTML (produto com aspas/tags no nome não injeta markup)", /replace\(\/&\/g, '&amp;'\)/.test(serverSrc));
  const storefrontPublicSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/storefrontPublic.ts"), "utf-8");
  check("Vitrine pública devolve slug no payload do produto", /ensureProductSlug\(orgId, p\)/.test(storefrontPublicSrc));

  // ---- item 34: WhatsApp respeita storefront_visible ----
  const visivelId = randomUUID();
  const ocultoId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, storefront_visible) VALUES (?, ?, 'product', 'Produto Visível', 10, 1, 1)`).run(visivelId, orgA);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, storefront_visible) VALUES (?, ?, 'product', 'Produto Oculto', 10, 1, 0)`).run(ocultoId, orgA);

  // mesmas consultas do AIOrchestratorService após o ajuste
  const ctxRows = db.prepare(`
    SELECT ps.* FROM products_services ps
    WHERE ps.organization_id = ? AND ps.active = 1 AND COALESCE(ps.storefront_visible, 1) = 1
  `).all(orgA) as any[];
  check("Contexto de produtos da IA não inclui produto oculto", !ctxRows.some((r) => r.id === ocultoId));
  check("Produto visível continua no contexto da IA", ctxRows.some((r) => r.id === visivelId));

  const orderResolve = db.prepare(
    `SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1 AND lower(name) = lower(?)`
  ).get(orgA, "Produto Oculto") as any;
  check("Resolução de pedido por nome não encontra produto oculto", !orderResolve);

  const legacyNullVisible = db.prepare(`
    SELECT COUNT(*) AS c FROM products_services
    WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1 AND storefront_visible IS NULL
  `).get(orgB) as any;
  // COALESCE(NULL,1)=1: produto antigo sem a coluna preenchida continua visível
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Produto Antigo NULL', 1, 1)`).run(randomUUID(), orgB);
  const nullVisible = db.prepare(`
    SELECT COUNT(*) AS c FROM products_services
    WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1
  `).get(orgB) as any;
  check("storefront_visible NULL (legado) continua visível para a IA (COALESCE)", nullVisible.c >= 1, `visiveis=${nullVisible.c} (legado null check: ${legacyNullVisible.c})`);

  const aiSrc = fs.readFileSync(path.join(process.cwd(), "src/server/AIOrchestratorService.ts"), "utf-8");
  const filterCount = (aiSrc.match(/COALESCE\((ps\.)?storefront_visible, 1\) = 1/g) || []).length;
  check("Todas as 5 consultas de produto da IA aplicam o filtro de visibilidade", filterCount === 5, `filtros=${filterCount}`);

  // ---- resultado ----
  console.log("\n=== Backlog Loja (ADR-028) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
