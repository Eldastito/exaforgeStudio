/**
 * TEST — Verificação do webhook Stone/Pagar.me por RE-CONSULTA (SEC-F27). Determinístico.
 *
 * Prova as decisões PURAS que o `syncStonePayment` usa depois de RE-CONSULTAR a API:
 *   - do evento tira-se o ID do recurso a consultar (nunca o status do corpo);
 *   - só o objeto AUTORITATIVO (status/code/amount da API) confirma o pagamento;
 *   - um corpo forjado ("order.paid" com status "paid") NÃO decide nada sozinho — o que decide é
 *     o objeto retornado pela re-consulta;
 *   - valor divergente reprova (defesa em profundidade); ausência de base não bloqueia.
 *
 * Uso: npm run test:security-stone-webhook
 */
import { stoneFetchTargetFromEvent, resolveStoneAuthoritative, stoneAmountMatches } from "../src/server/stonePaymentGuard.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function main() {
  // ── 1. Alvo da RE-CONSULTA a partir do evento (só o id, nunca o status) ──
  check("1.1 order.paid -> consulta a order pelo id",
    JSON.stringify(stoneFetchTargetFromEvent({ type: "order.paid", data: { id: "or_1", code: "ped1", status: "paid" } })) === JSON.stringify({ kind: "order", id: "or_1" }));
  check("1.2 charge.paid com order_id -> resolve pela order",
    JSON.stringify(stoneFetchTargetFromEvent({ type: "charge.paid", data: { id: "ch_1", order_id: "or_9" } })) === JSON.stringify({ kind: "order", id: "or_9" }));
  check("1.3 charge.paid com order.id aninhado -> resolve pela order",
    JSON.stringify(stoneFetchTargetFromEvent({ type: "charge.paid", data: { id: "ch_1", order: { id: "or_7" } } })) === JSON.stringify({ kind: "order", id: "or_7" }));
  check("1.4 charge sem order -> consulta a própria charge",
    JSON.stringify(stoneFetchTargetFromEvent({ type: "charge.paid", data: { id: "ch_5" } })) === JSON.stringify({ kind: "charge", id: "ch_5" }));
  check("1.5 tipo irrelevante -> null", stoneFetchTargetFromEvent({ type: "customer.created", data: { id: "x" } }) === null);
  check("1.6 sem id -> null", stoneFetchTargetFromEvent({ type: "order.paid", data: {} }) === null);

  // ── 2. O CORPO forjado não é autoridade — quem decide é o objeto AUTORITATIVO ──
  // Cenário-ataque: o forjador manda um evento; ainda assim exigimos re-consulta. O evento em si
  // NÃO tem função de decisão de "pago" — só aponta o id. A decisão vem de resolveStoneAuthoritative.
  const authPaid = resolveStoneAuthoritative({ id: "or_1", code: "ped1", status: "paid", amount: 5000 });
  check("2.1 objeto autoritativo pago confirma", authPaid.paid === true && authPaid.ref === "ped1" && authPaid.amountCents === 5000);
  const authPending = resolveStoneAuthoritative({ id: "or_1", code: "ped1", status: "pending", amount: 5000 });
  check("2.2 objeto autoritativo pendente NÃO confirma", authPending.paid === false);
  const authFailed = resolveStoneAuthoritative({ id: "or_1", code: "ped1", status: "failed", amount: 5000 });
  check("2.3 objeto autoritativo falho NÃO confirma", authFailed.paid === false);
  const authChargePaid = resolveStoneAuthoritative({ id: "or_2", code: "ped2", status: "processing", charges: [{ status: "paid" }], amount: 900 });
  check("2.4 charge do pedido 'paid' confirma (link de 1 cobrança)", authChargePaid.paid === true && authChargePaid.ref === "ped2");
  const authMeta = resolveStoneAuthoritative({ id: "or_3", metadata: { reference: "res:abc" }, status: "paid", amount: 100 });
  check("2.5 ref cai no metadata.reference quando sem code", authMeta.ref === "res:abc");
  const authNoRef = resolveStoneAuthoritative({ id: "or_4", status: "paid", amount: 100 });
  check("2.6 pago mas SEM ref -> ref null (service não confirma)", authNoRef.paid === true && authNoRef.ref === null);
  check("2.7 objeto vazio -> não pago", resolveStoneAuthoritative({}).paid === false);

  // ── 3. Conferência de valor (defesa em profundidade) ──
  check("3.1 valor bate (5000c == R$50,00)", stoneAmountMatches(5000, 50) === true);
  check("3.2 valor NÃO bate (reprova)", stoneAmountMatches(5000, 49.99) === false);
  check("3.3 sem valor autoritativo -> não bloqueia", stoneAmountMatches(null, 50) === true);
  check("3.4 sem esperado -> não bloqueia", stoneAmountMatches(5000, undefined) === true);
  check("3.5 centavos com arredondamento (1990c == R$19,90)", stoneAmountMatches(1990, 19.9) === true);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log("  x " + r.name);
  console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-stone-webhook: " + passed + "/" + results.length + " checks");
  process.exit(failures === 0 ? 0 : 1);
}
main();
