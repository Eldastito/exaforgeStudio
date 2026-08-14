/**
 * TEST — Integridade do webhook de pagamento generico (SEC-F20). Deterministico, sem DB.
 *
 * A auditoria mostrou que o path generico marcava pago com folgas: (1) payload SEM status
 * assumia PAGO; (2) sem conferencia de valor. Aqui provamos:
 *   - so status EXPLICITAMENTE pago vira paid=true; ausencia de status -> paid=false;
 *   - valor do payload divergente do pedido -> rejeitado; igual/ausente -> aceito.
 *
 * Uso: npm run test:security-payment-webhook
 */
import { resolveGenericPaymentWebhook, paymentAmountMatches } from "../src/server/paymentWebhookGuard.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// 1. Status pago EXPLICITO (o coracao do fix).
check("1.1 sem status -> NAO pago (antes assumia pago)", resolveGenericPaymentWebhook({ orderId: "o1" }).paid === false);
check("1.2 status vazio -> NAO pago", resolveGenericPaymentWebhook({ orderId: "o1", status: "" }).paid === false);
check("1.3 status 'paid' -> pago", resolveGenericPaymentWebhook({ orderId: "o1", status: "paid" }).paid === true);
check("1.4 status 'approved' -> pago", resolveGenericPaymentWebhook({ orderId: "o1", status: "APPROVED" }).paid === true);
check("1.5 status 'pending' -> NAO pago", resolveGenericPaymentWebhook({ orderId: "o1", status: "pending" }).paid === false);
check("1.6 status 'cancelled' -> NAO pago", resolveGenericPaymentWebhook({ orderId: "o1", status: "cancelled" }).paid === false);

// 2. Resolucao de orderId/externalId.
check("2.1 orderId direto", resolveGenericPaymentWebhook({ orderId: "o9", id: "ext9" }).orderId === "o9");
check("2.2 order_id snake_case", resolveGenericPaymentWebhook({ order_id: "o8" }).orderId === "o8");
check("2.3 external_reference em data", resolveGenericPaymentWebhook({ data: { external_reference: "o7", id: "ext7" } }).orderId === "o7");
check("2.4 externalId de data.id", resolveGenericPaymentWebhook({ data: { external_reference: "o7", id: "ext7" } }).externalId === "ext7");
check("2.5 sem pedido -> orderId null", resolveGenericPaymentWebhook({ status: "paid" }).orderId === null);

// 3. Conferencia de valor.
check("3.1 valor igual -> aceita", paymentAmountMatches({ amount: 100 }, 100) === true);
check("3.2 valor divergente (menor) -> rejeita", paymentAmountMatches({ amount: 1 }, 100) === false);
check("3.3 valor divergente (maior) -> rejeita", paymentAmountMatches({ amount: 999 }, 100) === false);
check("3.4 tolerancia de centavo -> aceita", paymentAmountMatches({ amount: 100.004 }, 100) === true);
check("3.5 payload sem valor -> aceita (nao inventa)", paymentAmountMatches({ status: "paid" }, 100) === true);
check("3.6 pedido sem valor esperado -> aceita", paymentAmountMatches({ amount: 50 }, null) === true);
check("3.7 valor em data.transaction_amount", paymentAmountMatches({ data: { transaction_amount: 100 } }, 100) === true);
check("3.8 valor em 'value'", paymentAmountMatches({ value: 42 }, 42) === true);

const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log("  x " + r.name);
console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-payment-webhook: " + passed + "/" + results.length + " checks");
process.exit(failures === 0 ? 0 : 1);
