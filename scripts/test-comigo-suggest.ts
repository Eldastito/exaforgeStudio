/**
 * TEST — Comigo/Sugestão zero-token (market-basket) (ADR-117 / ADR-088 D5).
 *
 * Uso: npm run test:comigo-suggest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-sug-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-sug-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoSuggestionService: S } = await import("../src/server/ComigoSuggestionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);

  const P = { galeto: "p_galeto", refri: "p_refri", farofa: "p_farofa", agua: "p_agua" };
  function order(items: { pid: string; name: string; qty?: number; price?: number }[]) {
    const oid = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total) VALUES (?, ?, 'paid', 'cash', 0)`).run(oid, orgId);
    for (const it of items) {
      db.prepare(`INSERT INTO comigo_order_items (id, order_id, product_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(randomUUID(), oid, it.pid, it.name, it.qty || 1, it.price || 10);
    }
    return oid;
  }

  // Galeto sai muito; com galeto, refri co-ocorre mais que farofa; água é rara.
  order([{ pid: P.galeto, name: "Galeto", qty: 1 }, { pid: P.refri, name: "Refri", qty: 2 }]);
  order([{ pid: P.galeto, name: "Galeto" }, { pid: P.refri, name: "Refri" }]);
  order([{ pid: P.galeto, name: "Galeto" }, { pid: P.refri, name: "Refri" }]);
  order([{ pid: P.galeto, name: "Galeto" }, { pid: P.farofa, name: "Farofa" }]);
  order([{ pid: P.agua, name: "Água" }]);

  // ===== 1. Co-ocorrência: com Galeto, Refri > Farofa; Água não aparece =====
  const also = S.alsoBought(orgId, P.galeto);
  check("alsoBought retorna itens", also.length >= 2);
  check("Refri é o 1º co-ocorrente do Galeto", also[0]?.product_id === P.refri);
  check("Refri co-ocorre em 3 pedidos", also.find((a) => a.product_id === P.refri)?.count === 3);
  check("Farofa co-ocorre em 1 pedido", also.find((a) => a.product_id === P.farofa)?.count === 1);
  check("não sugere o próprio Galeto", !also.some((a) => a.product_id === P.galeto));
  check("Água (nunca junto do Galeto) não aparece", !also.some((a) => a.product_id === P.agua));

  // ===== 2. Mais pedidos (por qty) =====
  const top = S.topSellers(orgId);
  check("mais pedidos retorna itens", top.length >= 3);
  check("Galeto é o mais pedido (4 unidades)", top[0]?.product_id === P.galeto && top[0]?.count === 4);

  // ===== 3. forBalcao com e sem item =====
  const withItem = S.forBalcao(orgId, P.galeto);
  check("forBalcao(item) traz alsoBought + top", withItem.alsoBought.length >= 1 && withItem.top.length >= 1);
  const empty = S.forBalcao(orgId);
  check("forBalcao() sem item traz só os mais pedidos", empty.alsoBought.length === 0 && empty.top.length >= 1);

  // ===== 4. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org não vê sugestões", S.topSellers(other).length === 0 && S.alsoBought(other, P.galeto).length === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Sugestão zero-token (ADR-117) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Sugestão zero-token OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
