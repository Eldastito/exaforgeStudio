/**
 * TEST — Comigo/Boosts de divulgação (ADR-123 / ADR-088 D8).
 *
 * Uso: npm run test:comigo-boosts
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-boost-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-boost-1234567890";
process.env.APP_URL = "https://app.exemplo.com";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoBoostService: B } = await import("../src/server/ComigoBoostService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Galeto da Praça', 'active')`).run(randomUUID(), orgId);
  const galeto = randomUUID(), refri = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Galeto', 45, 1)`).run(galeto, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Refri', 5, 1)`).run(refri, orgId);

  // ===== Post do dia — fallback (sem histórico) usa produtos ativos =====
  const p0 = B.postDoDia(orgId);
  check("post fallback lista produtos ativos", p0.items.length === 2);
  check("legenda cita o nome do negócio", p0.caption.includes("Galeto da Praça"));
  check("legenda cita preço", p0.caption.includes("45,00"));

  // ===== Post do dia — com histórico ranqueia os mais vendidos =====
  for (let i = 0; i < 3; i++) {
    const oid = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total) VALUES (?, ?, 'paid','cash', 45)`).run(oid, orgId);
    db.prepare(`INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, 'Galeto', 1, 45, 0)`).run(randomUUID(), oid, galeto);
  }
  const p1 = B.postDoDia(orgId);
  check("post com histórico: Galeto em 1º", p1.items[0]?.name === "Galeto");

  // ===== Compartilhar cardápio: link do Mesa/QR + texto =====
  const c = B.catalogoShare(orgId);
  check("catálogo devolve link do Mesa/QR", c.link.startsWith("https://app.exemplo.com/mesa/mesa_"));
  check("texto convidativo inclui o link", c.text.includes(c.link));

  // ===== list traz os dois boosts =====
  const l = B.list(orgId);
  check("list traz post + catálogo", !!l.post?.caption && !!l.catalogo?.link);

  // ===== use registra no log; boost inválido recusado =====
  check("use(post) ok", B.use(orgId, "post", "u1").ok === true);
  check("use(catalogo) ok", B.use(orgId, "catalogo").ok === true);
  check("boost desconhecido recusado", B.use(orgId, "hack").ok === false);
  const logged = (db.prepare("SELECT COUNT(*) c FROM comigo_boost_log WHERE organization_id = ?").get(orgId) as any).c;
  check("log registrou 2 usos", logged === 2);

  // ===== Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outro', 'active')`).run(randomUUID(), other);
  const po = B.postDoDia(other);
  check("isolamento: outra org sem produtos → post genérico", po.items.length === 0);
  check("isolamento: log da outra org vazio", (db.prepare("SELECT COUNT(*) c FROM comigo_boost_log WHERE organization_id = ?").get(other) as any).c === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Boosts de divulgação (ADR-123) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Boosts de divulgação OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
