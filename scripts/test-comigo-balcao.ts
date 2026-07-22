/**
 * TEST — Comigo/Balcão PDV + fiado + lista negra (ADR-111 D4 / ADR-112 / ADR-113, PR #3).
 *
 * Cobre o ciclo do pedido (abrir → itens → total), cobrança à vista (dinheiro/
 * Pix), fiado com limite (aviso + override), lista negra (bloqueio duro do fiado),
 * suspensão total (block_all_sales), recebimento parcial e a regra "fiado é a
 * receber, não caixa".
 *
 * Uso: npm run test:comigo-balcao
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-balcao-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-balcao-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_fiado_default_limit) VALUES (?, ?, 'X', 'active', ?)`)
    .run(randomUUID(), orgId, 50);

  // ===== 1. Ciclo do pedido: abrir → itens → total =====
  const o1 = B.openOrder(orgId, { sessionAlias: "João", consumo: "local" });
  B.addItem(orgId, o1, { name: "Galeto", qty: 1, unitPrice: 45 });
  B.addItem(orgId, o1, { name: "Refri", qty: 2, unitPrice: 5 });
  const ord1 = db.prepare("SELECT total, status FROM comigo_orders WHERE id = ?").get(o1) as any;
  check("total recalculado (45 + 2×5 = 55)", near(ord1.total, 55));
  check("pedido nasce 'open'", ord1.status === "open");

  // ===== 2. Cobrança à vista (dinheiro) = caixa =====
  const payCash = B.pay(orgId, o1, { paidVia: "cash" });
  check("pagar em dinheiro ok", payCash.ok === true && payCash.receivable === false);
  const ord1b = db.prepare("SELECT status, paid_via, paid_at FROM comigo_orders WHERE id = ?").get(o1) as any;
  check("dinheiro: status 'paid' + paid_at setado", ord1b.status === "paid" && ord1b.paid_via === "cash" && !!ord1b.paid_at);

  // ===== 3. Fiado dentro do limite =====
  const cid = B.ensureFiadoContact(orgId, "Maria", "5511999");
  check("ensureFiadoContact cria contato", !!cid);
  check("mesmo cliente reusa o contato (idempotente)", B.ensureFiadoContact(orgId, "Maria", "5511999") === cid);
  const o2 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o2, { name: "Marmita", qty: 2, unitPrice: 15 }); // 30
  const payFiado = B.pay(orgId, o2, { paidVia: "fiado", actorId: "u1" });
  check("fiado dentro do limite fecha", payFiado.ok === true && payFiado.receivable === true);
  check("fiado: pedido vira 'done' (a receber, não caixa)", (db.prepare("SELECT status, paid_via, paid_at FROM comigo_orders WHERE id = ?").get(o2) as any).status === "done");
  check("fiado: NÃO tem paid_at (não é caixa)", !(db.prepare("SELECT paid_at FROM comigo_orders WHERE id = ?").get(o2) as any).paid_at);
  check("saldo do fiado = 30", near(B.balanceOf(orgId, cid), 30));

  // ===== 4. Fiado que ESTOURA o limite: avisa (needsOverride) e libera =====
  const o3 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o3, { name: "Bolo", qty: 1, unitPrice: 40 }); // 30 + 40 = 70 > 50
  const warn = B.pay(orgId, o3, { paidVia: "fiado" });
  check("estouro do limite: needsOverride (não fecha)", warn.ok === false && (warn as any).needsOverride === true && (warn as any).reason === "over_limit");
  check("estouro: pedido segue 'open' (não fechou)", (db.prepare("SELECT status FROM comigo_orders WHERE id = ?").get(o3) as any).status === "open");
  const forced = B.pay(orgId, o3, { paidVia: "fiado", override: true });
  check("com override: fecha", forced.ok === true && (forced as any).overLimit === true);
  check("liberação acima do limite gravada (over_limit=1)", (db.prepare("SELECT over_limit FROM comigo_orders WHERE id = ?").get(o3) as any).over_limit === 1);
  check("ledger registra a dívida com over_limit=1", (db.prepare("SELECT over_limit FROM comigo_fiado_ledger WHERE order_id = ?").get(o3) as any).over_limit === 1);

  // ===== 5. Recebimento parcial abate o saldo =====
  const before = B.balanceOf(orgId, cid); // 30 + 40 = 70
  check("saldo antes do recebimento = 70", near(before, 70));
  B.settleFiado(orgId, cid, 25, "abateu 25");
  check("recebimento parcial: saldo = 45", near(B.balanceOf(orgId, cid), 45));

  // ===== 6. Lista negra: bloqueia o fiado (sem override) =====
  B.setBlacklist(orgId, cid, true, "sumiu 3 meses");
  const o4 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o4, { name: "Coxinha", qty: 1, unitPrice: 8 });
  const blocked = B.pay(orgId, o4, { paidVia: "fiado" });
  check("lista negra: fiado bloqueado", blocked.ok === false && (blocked as any).error === "blacklisted");
  const blockedForced = B.pay(orgId, o4, { paidVia: "fiado", override: true });
  check("lista negra: override NÃO fura o fiado (linha dura)", blockedForced.ok === false && (blockedForced as any).error === "blacklisted");
  // ...mas ainda vende à vista (não se recusa dinheiro).
  const cashOk = B.pay(orgId, o4, { paidVia: "cash" });
  check("lista negra ainda aceita venda à vista", cashOk.ok === true);

  // ===== 7. Suspensão total (block_all_sales) bloqueia até à vista =====
  B.setBlockAllSales(orgId, cid, true);
  const o5 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o5, { name: "Água", qty: 1, unitPrice: 3 });
  const allBlocked = B.pay(orgId, o5, { paidVia: "cash" });
  check("block_all: até à vista pede override", allBlocked.ok === false && (allBlocked as any).needsOverride === true && (allBlocked as any).reason === "blocked_all");
  const allForced = B.pay(orgId, o5, { paidVia: "cash", override: true });
  check("block_all: com override o dono libera", allForced.ok === true);

  // ===== 8. Isolamento entre organizações =====
  const otherOrg = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), otherOrg);
  let leaked = false;
  try { B.addItem(otherOrg, o2, { name: "hack", unitPrice: 1 }); leaked = true; } catch { leaked = false; }
  check("isolamento: outra org não mexe no pedido alheio", leaked === false);
  check("isolamento: saldo do fiado não vaza p/ outra org", B.balanceOf(otherOrg, cid) === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Balcão PDV + fiado + lista negra (ADR-111/112/113) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Balcão PDV + fiado OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
