/**
 * TESTE — WZ-2: registro de venda por comando de WhatsApp.
 * ------------------------------------------------------------------------------
 * Caso central = o comando VERBATIM do dono: "registre a venda da peça xpto do
 * tamanho GG, da cor azul, com a referencia 123456, com o valor xx,xx pago com
 * cartão de credito". Prova, offline, com o OrdersService REAL (banco isolado):
 *   - parser determinístico extrai peça/tamanho/cor/referência/valor/pagamento;
 *   - venda registrada pelo caminho canônico: order 'pago', item com a variante
 *     certa, ESTOQUE baixado, payment_method gravado, valor FALADO respeitado
 *     (priceOverride) com aviso quando difere da tabela;
 *   - NUNCA inventa: referência inexistente recusa · nome ambíguo lista
 *     candidatos com referência · variante inexistente lista as disponíveis ·
 *     sem estoque repassa o erro e NADA é gravado;
 *   - campos obrigatórios ausentes → pergunta (não chuta);
 *   - pergunta aberta não é interceptada; fiação no webhookProcessor.
 *
 * Uso:  npm run test:sale-whatsapp-command
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sale-cmd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sale-cmd-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SaleWhatsAppCommandService: Svc } = await import("../src/server/SaleWhatsAppCommandService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Toulon', 'active')`).run(randomUUID(), A);

  // Catálogo real: peça com referência 123456 + variantes GG/Azul e M/Vermelho + estoque.
  const prodId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled, reference) VALUES (?, ?, 'product', 'Vestido Midi Xpto', 199.90, 1, 1, '123456')`).run(prodId, A);
  const varGG = randomUUID();
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, active) VALUES (?, ?, ?, 'GG / Azul', 'GG', 'Azul', 1)`).run(varGG, A, prodId);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color, active) VALUES (?, ?, ?, 'M / Vermelho', 'M', 'Vermelho', 1)`).run(randomUUID(), A, prodId);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, variant_id, quantity_available) VALUES (?, ?, ?, ?, 5)`).run(randomUUID(), A, prodId, varGG);
  // Segunda peça de nome parecido (pro caso ambíguo).
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, reference) VALUES (?, ?, 'product', 'Vestido Midi Festa', 299.90, 1, '654321')`).run(randomUUID(), A);

  const sent: string[] = [];
  const deps = { sendMessage: async (_c: string, _t: string, msg: string) => { sent.push(msg); } };

  // ── 1) Parser: o comando VERBATIM do dono ──
  const CMD = "registre a venda da peça xpto do tamanho GG, da cor azul, com a referencia 123456, com o valor 149,90 pago com cartão de credito";
  const p = Svc.parse(CMD);
  check("1.1 intent register_sale", p.intent === "register_sale");
  check("1.2 referência 123456", p.reference === "123456");
  check("1.3 tamanho GG + cor azul", p.size === "GG" && (p.color || "").toLowerCase() === "azul", `${p.size}|${p.color}`);
  check("1.4 valor 149.90 (vírgula pt-BR)", p.amount === 149.9);
  check("1.5 pagamento cartao_credito", p.payment === "cartao_credito");
  check("1.6 nada obrigatório faltando", p.missing.length === 0, p.missing.join(","));
  check("1.7 pergunta aberta não intercepta", Svc.parse("como foram as vendas de hoje?").intent === "none");

  // ── 2) Fluxo feliz com o OrdersService REAL ──
  const r2 = await Svc.handle(A, "ch1", "5521999", CMD, deps as any);
  check("2.1 handled + registered", r2.handled === true && r2.outcome === "registered" && !!r2.orderId, r2.outcome);
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(r2.orderId) as any;
  check("2.2 pedido 'pago' com o VALOR FALADO (149.90, não a tabela 199.90)", order?.status === "pago" && Math.abs(order.total_amount - 149.9) < 0.01, `${order?.status}|${order?.total_amount}`);
  check("2.3 payment_method gravado", order?.payment_method === "cartao_credito");
  const item = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).get(r2.orderId) as any;
  check("2.4 item amarrado ao produto + variante GG/Azul", item?.product_service_id === prodId && item?.variant_id === varGG);
  const inv = db.prepare(`SELECT quantity_available FROM inventory_items WHERE organization_id = ? AND variant_id = ?`).get(A, varGG) as any;
  check("2.5 estoque baixado (5→4)", inv?.quantity_available === 4, String(inv?.quantity_available));
  check("2.6 resposta avisa que difere da tabela", sent.some(m => /tabela/.test(m) && /149,90/.test(m)));
  const audit = db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'SALE_REGISTERED_VIA_WHATSAPP'`).get(A) as any;
  check("2.7 auditado", Number(audit?.c || 0) >= 1);

  // ── 3) NUNCA inventa ──
  sent.length = 0;
  const r3 = await Svc.handle(A, "ch1", "5521999", "registre a venda da peça fantasma, referência 999999, valor 50,00 pago no pix", deps as any);
  check("3.1 referência inexistente recusa (não registra)", r3.outcome === "not_found" && sent.some(m => /999999/.test(m)));
  sent.length = 0;
  const r4 = await Svc.handle(A, "ch1", "5521999", "registre a venda da peça vestido midi, valor 100,00 pago no pix", deps as any);
  check("4.1 nome ambíguo lista candidatos COM referência", r4.outcome === "ambiguous" && sent.some(m => /123456/.test(m) && /654321/.test(m)));
  sent.length = 0;
  const r5 = await Svc.handle(A, "ch1", "5521999", "registre a venda da peça xpto, tamanho P, cor rosa, referência 123456, valor 100,00 pago no pix", deps as any);
  check("5.1 variante inexistente lista as disponíveis (não registra)", r5.outcome === "variant_not_found" && sent.some(m => /GG \/ Azul/.test(m)));
  sent.length = 0;
  const r6 = await Svc.handle(A, "ch1", "5521999", "registre a venda da peça xpto, tamanho GG, cor azul, referência 123456, valor 100,00 pago no pix, 10 unidades", deps as any);
  const invAfter = db.prepare(`SELECT quantity_available FROM inventory_items WHERE organization_id = ? AND variant_id = ?`).get(A, varGG) as any;
  check("6.1 sem estoque (10 > 4) → erro honesto e NADA gravado", r6.outcome === "error" && invAfter?.quantity_available === 4);
  sent.length = 0;
  const r7 = await Svc.handle(A, "ch1", "5521999", "registre a venda da peça xpto referência 123456", deps as any);
  check("7.1 sem valor/pagamento → pergunta o que falta (não chuta)", r7.outcome === "missing_fields" && sent.some(m => /valor/.test(m) && /pagamento/.test(m)));

  // ── 8) Fiação no webhookProcessor (depois do Estúdio, antes do Controller) ──
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/webhookProcessor.ts"), "utf8");
  const iSale = src.indexOf("SaleWhatsAppCommandService.handle");
  const iGestor = src.indexOf("GestorCommandService.handle");
  check("8.1 runInternalInbound chama a venda antes do Controller", iSale > 0 && iGestor > 0 && iSale < iGestor);

  console.log("\n=== TEST: Registro de venda via WhatsApp (WZ-2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
