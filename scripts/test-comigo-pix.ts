/**
 * TEST — Comigo/Pix dinâmico com webhook (ADR-118 / ADR-088 D3 nível 2).
 *
 * Uso: npm run test:comigo-pix
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-pix-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-pix-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoPixService: Pix } = await import("../src/server/ComigoPixService.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const secret = "segredo-webhook-teste";
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pay_webhook_secret_hash) VALUES (?, ?, 'X', 'active', ?)`)
    .run(randomUUID(), orgId, EncryptionService.hash(secret));

  // Pedido aberto de R$55.
  const o1 = B.openOrder(orgId, { sessionAlias: "Zé" });
  B.addItem(orgId, o1, { name: "Galeto", unitPrice: 45 });
  B.addItem(orgId, o1, { name: "Refri", qty: 2, unitPrice: 5 });

  // ===== 1. createCharge gera txid + payload =====
  const c1 = Pix.createCharge(orgId, o1) as any;
  check("cobrança criada", c1.ok === true && !!c1.txid);
  check("valor da cobrança = 55", near(c1.amount, 55));
  check("txid tem ≤ 35 chars (regra Pix)", c1.txid.length <= 35);
  check("payload copia-e-cola gerado", typeof c1.qrPayload === "string" && c1.qrPayload.length > 0);
  check("pedido segue aberto até pagar", (db.prepare("SELECT status FROM comigo_orders WHERE id=?").get(o1) as any).status === "open");

  // ===== 2. Idempotente por pedido (reusa a cobrança pendente) =====
  const c2 = Pix.createCharge(orgId, o1) as any;
  check("createCharge reusa cobrança pendente", c2.txid === c1.txid && c2.reused === true);

  // ===== 3. confirmByTxid fecha o pedido como pix_dyn =====
  const conf = Pix.confirmByTxid(orgId, c1.txid, "E2E123") as any;
  check("confirmação fecha o pedido", conf.ok === true && conf.orderClosed === true);
  const ord = db.prepare("SELECT status, paid_via, paid_at FROM comigo_orders WHERE id=?").get(o1) as any;
  check("pedido pago via pix_dyn com paid_at", ord.status === "paid" && ord.paid_via === "pix_dyn" && !!ord.paid_at);
  check("cobrança marcada paga", (db.prepare("SELECT status FROM comigo_pix_charges WHERE txid=?").get(c1.txid) as any).status === "paid");

  // ===== 4. Idempotência: reentrega não paga em dobro =====
  const again = Pix.confirmByTxid(orgId, c1.txid) as any;
  check("reentrega: alreadyPaid (não fecha de novo)", again.ok === true && again.alreadyPaid === true);

  // ===== 5. Webhook por segredo da org =====
  const badOrg = Pix.handleWebhook("segredo-errado", { txid: "x", status: "paid" });
  check("webhook com segredo inválido = unauthorized", badOrg.status === "unauthorized");
  // Novo pedido + cobrança, confirmada via webhook.
  const o2 = B.openOrder(orgId, {});
  B.addItem(orgId, o2, { name: "Bolo", unitPrice: 30 });
  const c3 = Pix.createCharge(orgId, o2) as any;
  const wh = Pix.handleWebhook(secret, { txid: c3.txid, status: "paid", e2eId: "E2EABC" });
  check("webhook válido concilia por txid", wh.status === "ok" && wh.orgId === orgId);
  check("webhook fechou o pedido via pix_dyn", (db.prepare("SELECT paid_via FROM comigo_orders WHERE id=?").get(o2) as any).paid_via === "pix_dyn");

  // ===== 6. Pix dinâmico entra no CAIXA (daySummary) =====
  const today = new Date().toISOString().slice(0, 10);
  const s = B.daySummary(orgId, today);
  check("caixa do dia inclui os Pix dinâmicos (55 + 30 = 85)", near(s.caixaHoje, 85));

  // ===== 7. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  const leak = Pix.confirmByTxid(other, c3.txid) as any;
  check("isolamento: outra org não confirma cobrança alheia", leak.ok === false && leak.error === "charge_not_found");

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Pix dinâmico (ADR-118) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Pix dinâmico OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
