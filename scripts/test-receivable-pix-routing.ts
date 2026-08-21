/**
 * TEST — Roteamento + reconciliação de PIX de recebível (ADR-183 F2+F3). DB-backed, det.
 * Prova: o webhook do gateway (rcv:<id>) dá baixa na system-of-record (receivables.received) E
 * confirma a expectativa do runtime (gateway_payment_webhook) → ação done; idempotente; sem
 * confirmação viva é no-op na confirmação mas ainda baixa o recebível; isolamento.
 *
 * Uso: npm run test:receivable-pix-routing
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rcvpix-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rcvpix-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PaymentService } = await import("../src/server/PaymentService.js");
  const { ConfirmationEngine } = await import("../src/server/ConfirmationEngine.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const mkReceivable = (org: string, amount: number) => {
    const id = `rcv_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fatura', ?, '2026-08-15', 'open')`).run(id, org, amount);
    return id;
  };
  // Cria uma ação aprovada + confirmação armada (como faz o handler F2).
  const mkArmedAction = (org: string, paymentId: string) => {
    const a = DecisionActionService.propose(org, { domain: "runtime", actionType: "collection", title: "cobrança", expectedImpact: 100, commandType: "collection_send_reminder", commandPayload: {} });
    DecisionActionService.approve(org, a.id, "u");
    db.prepare(`UPDATE decision_actions SET status='approved', executed_at=CURRENT_TIMESTAMP WHERE id=?`).run(a.id);
    ConfirmationEngine.expect(org, { actionId: a.id, method: "gateway_payment_webhook", externalRef: paymentId, deadlineAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
    return a.id;
  };

  // 1. Recebível pago → baixa na system-of-record + confirma a ação.
  const rid = mkReceivable(A, 250);
  const pay = "MP-PAY-A1";
  const aid = mkArmedAction(A, pay);
  await PaymentService.onReceivablePaid(A, rid, pay, 250);
  check("1.1 recebível marcado 'received'", (db.prepare(`SELECT status FROM receivables WHERE id=?`).get(rid) as any).status === "received");
  check("1.2 confirmação confirmada", ConfirmationEngine.getForAction(A, aid)?.status === "confirmed");
  await new Promise((r) => setTimeout(r, 30));
  const act = DecisionActionService.get(A, aid);
  check("1.3 ação fechada (done) com result_amount", act.status === "done" && Number(act.result_amount) === 250);
  check("1.4 cash_event registrado (in) da baixa", !!db.prepare(`SELECT 1 FROM cash_events WHERE organization_id=? AND source_type='receivable' AND source_id=?`).get(A, rid));

  // 2. Idempotência: repetir NÃO reabre nem duplica.
  await PaymentService.onReceivablePaid(A, rid, pay, 250);
  await new Promise((r) => setTimeout(r, 20));
  check("2.1 repetir mantém done (não reabre)", DecisionActionService.get(A, aid).status === "done");
  check("2.2 não duplica cash_event", (db.prepare(`SELECT COUNT(*) n FROM cash_events WHERE organization_id=? AND source_type='receivable' AND source_id=?`).get(A, rid) as any).n === 1);

  // 3. Sem confirmação viva: ainda baixa o recebível (best-effort), sem quebrar.
  const rid2 = mkReceivable(A, 90);
  await PaymentService.onReceivablePaid(A, rid2, "MP-PAY-NOEXPECT", 90);
  check("3.1 baixa recebível mesmo sem expectativa viva", (db.prepare(`SELECT status FROM receivables WHERE id=?`).get(rid2) as any).status === "received");

  // 4. Recebível inexistente → não quebra (best-effort), nada confirmado.
  await PaymentService.onReceivablePaid(A, "rcv_nao_existe", "MP-X", 10);
  check("4.1 recebível inexistente não quebra o fluxo", true);

  // 5. Isolamento: baixa em A não toca recebível de B com o mesmo valor.
  const ridB = mkReceivable(B, 250);
  check("5.1 recebível de B intacto (open)", (db.prepare(`SELECT status FROM receivables WHERE id=?`).get(ridB) as any).status === "open");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} receivable-pix-routing: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
