/**
 * SaleWhatsAppCommandService — WZ-2: registro de VENDA por comando de WhatsApp
 * (PRD WhatsApp Unificado, backlog do piloto — pedido verbatim do dono:
 * "registre a venda da peça xpto do tamanho GG, da cor azul, com a referencia
 * 123456, com o valor xx,xx pago com cartão de credito").
 *
 * Fluxo: gestor autorizado manda o comando no canal interno / modo misto →
 * parser DETERMINÍSTICO extrai peça/tamanho/cor/referência/valor/pagamento →
 * valida contra o CATÁLOGO REAL (`products_services.reference` — o campo de
 * referência do modelo Toulon — e `product_variants` size/color) → registra
 * pelo caminho canônico `OrdersService.createOrder` (autoClose='pago', baixa
 * de estoque, entra na comissão como fonte zappflow) → confirma com resumo.
 *
 * Guardrails (RN-151 / RN-CG-03):
 * - NUNCA inventa: produto só por referência exata ou nome com match ÚNICO;
 *   ambiguidade → lista candidatos COM a referência e pede pra repetir com ela
 *   (desambiguação ativa sem estado); variante inexistente → lista as
 *   disponíveis e NÃO registra; sem estoque → repassa o erro real do
 *   OrdersService (a transação desfaz tudo).
 * - Dinheiro: o VALOR FALADO é o preço da transação (priceOverride — venda com
 *   desconto existe); quando difere da tabela, o resumo DIZ os dois. Valor e
 *   pagamento são OBRIGATÓRIOS — sem eles pergunta, não chuta.
 * - Só o caminho INTERNO chama este serviço (gestor autorizado — §73/CA-04).
 * - Deps injetáveis → teste roda em CI sem rede.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { OrdersService } from "./OrdersService.js";
import { logAuthEvent } from "./auditLog.js";

export interface SaleCommandParse {
  intent: "register_sale" | "none";
  itemName?: string;
  size?: string;
  color?: string;
  reference?: string;
  amount?: number;        // valor TOTAL falado, em BRL
  payment?: string;       // normalizado: cartao_credito|cartao_debito|pix|dinheiro|boleto|fiado|transferencia
  quantity?: number;      // default 1
  missing: string[];      // campos obrigatórios ausentes
}

export interface SaleCommandDeps {
  createOrder?: (orgId: string, params: any) => { id: string; status: string; total: number };
  sendMessage?: (channelId: string, to: string, text: string, opts?: any) => Promise<any>;
}

const TRIGGER = /^(?:zapp[\s,:!.-]*)?\s*registr(?:a|e|ar)\s+(?:a\s+|uma\s+)?venda\b/i;

const PAYMENTS: Array<{ re: RegExp; key: string; label: string }> = [
  { re: /cart[ãa]o\s+de\s+cr[ée]dito|cr[ée]dito/i, key: "cartao_credito", label: "cartão de crédito" },
  { re: /cart[ãa]o\s+de\s+d[ée]bito|d[ée]bito/i, key: "cartao_debito", label: "cartão de débito" },
  { re: /\bpix\b/i, key: "pix", label: "PIX" },
  { re: /dinheiro|esp[ée]cie/i, key: "dinheiro", label: "dinheiro" },
  { re: /boleto/i, key: "boleto", label: "boleto" },
  { re: /fiado|crediário|crediario/i, key: "fiado", label: "fiado" },
  { re: /transfer[êe]ncia|ted|doc/i, key: "transferencia", label: "transferência" },
];
export function paymentLabel(key: string): string { return PAYMENTS.find(p => p.key === key)?.label || key; }

function parseBRL(s: string): number | undefined {
  const n = Number(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export class SaleWhatsAppCommandService {
  /** Parser puro/determinístico do comando de venda. */
  static parse(text: string): SaleCommandParse {
    const t = String(text || "").trim();
    if (!TRIGGER.test(t)) return { intent: "none", missing: [] };

    const reference = t.match(/refer[êe]ncia\s*:?\s*([A-Za-z0-9._-]+)/i)?.[1];
    const size = t.match(/tamanho\s*:?\s*([A-Za-z0-9]{1,5})\b/i)?.[1]?.toUpperCase();
    const color = t.match(/(?:da\s+cor|de\s+cor|cor)\s*:?\s*([A-Za-zÀ-ú]+)/i)?.[1];
    const amountRaw = t.match(/valor\s*(?:de\s*)?:?\s*(?:r\$\s*)?(\d{1,6}(?:[.,]\d{1,2})?)/i)?.[1];
    const amount = amountRaw ? parseBRL(amountRaw) : undefined;
    const payment = PAYMENTS.find(p => p.re.test(t))?.key;
    const qty = t.match(/(\d+)\s*(?:pe[çc]as|unidades|unid)\b/i)?.[1];
    const quantity = qty ? Math.max(1, parseInt(qty, 10)) : 1;

    // Nome da peça: o trecho entre "venda [da peça]" e o primeiro campo rotulado.
    const nameMatch = t.match(/venda\s+(?:d[aeo]s?\s+)?(?:pe[çc]a\s+)?(.+?)(?=\s*,|\s+(?:do\s+tamanho|tamanho|da\s+cor|de\s+cor|cor|com\s+a\s+refer|refer|no\s+valor|com\s+o\s+valor|valor|pag[oa]\s)|$)/i);
    const itemName = nameMatch?.[1]?.trim() || undefined;

    const missing: string[] = [];
    if (!reference && !itemName) missing.push("a peça (nome ou referência)");
    if (amount == null) missing.push("o valor (ex.: valor 149,90)");
    if (!payment) missing.push("a forma de pagamento (ex.: pago com cartão de crédito)");
    return { intent: "register_sale", itemName, size, color, reference, amount, payment, quantity, missing };
  }

  /** Acha o produto no catálogo REAL — nunca inventa. */
  private static findProduct(orgId: string, p: SaleCommandParse): { product?: any; candidates?: any[] } {
    if (p.reference) {
      const product = db.prepare(
        `SELECT * FROM products_services WHERE organization_id = ? AND reference = ? AND active = 1`
      ).get(orgId, p.reference) as any;
      return product ? { product } : { candidates: [] };
    }
    const like = `%${norm(p.itemName || "")}%`;
    const rows = db.prepare(
      `SELECT * FROM products_services WHERE organization_id = ? AND active = 1 AND LOWER(name) LIKE ? LIMIT 6`
    ).all(orgId, like) as any[];
    if (rows.length === 1) return { product: rows[0] };
    return { candidates: rows };
  }

  /** Casa tamanho/cor com as variantes reais do produto (se ele tiver). */
  private static findVariant(orgId: string, productId: string, p: SaleCommandParse): { variant?: any; hasVariants: boolean; available: any[] } {
    const all = db.prepare(
      `SELECT * FROM product_variants WHERE organization_id = ? AND product_service_id = ? AND active = 1`
    ).all(orgId, productId) as any[];
    if (!all.length) return { hasVariants: false, available: [] };
    if (!p.size && !p.color) return { hasVariants: true, available: all };
    const hit = all.find(v => {
      const vs = norm(v.size || ""); const vc = norm(v.color || ""); const vn = norm(v.name || "");
      const sizeOk = !p.size || vs === norm(p.size) || vn.includes(norm(p.size));
      const colorOk = !p.color || vc === norm(p.color) || vn.includes(norm(p.color));
      return sizeOk && colorOk;
    });
    return { variant: hit, hasVariants: true, available: all };
  }

  /**
   * Trata a mensagem se for comando de venda. `handled:false` = não é comando.
   */
  static async handle(
    orgId: string,
    channelId: string,
    senderId: string,
    text: string,
    deps?: SaleCommandDeps,
  ): Promise<{ handled: boolean; outcome?: "registered" | "missing_fields" | "not_found" | "ambiguous" | "variant_not_found" | "error"; orderId?: string }> {
    const p = this.parse(text);
    if (p.intent === "none") return { handled: false };

    const send = deps?.sendMessage
      || ((cid: string, to: string, msg: string) => MessageProviderService.sendMessage(cid, to, msg, { feature: "gestao" }));

    if (p.missing.length) {
      await send(channelId, senderId, `📝 Pra registrar a venda me falta: ${p.missing.join("; ")}.\nEx.: *registre a venda da peça vestido midi, tamanho GG, cor azul, referência 123456, valor 149,90 pago com cartão de crédito*`);
      return { handled: true, outcome: "missing_fields" };
    }

    // 1) Produto — catálogo real, nunca inventa.
    const found = this.findProduct(orgId, p);
    if (!found.product) {
      if (found.candidates && found.candidates.length > 1) {
        const list = found.candidates.slice(0, 5).map((c: any, i: number) => `${i + 1}. ${c.name}${c.reference ? ` (ref. ${c.reference})` : ""}`).join("\n");
        await send(channelId, senderId, `Achei mais de uma peça parecida — me repete o comando com a *referência* da certa:\n${list}`);
        return { handled: true, outcome: "ambiguous" };
      }
      const what = p.reference ? `referência *${p.reference}*` : `peça "*${p.itemName}*"`;
      await send(channelId, senderId, `❌ Não achei nenhuma peça com ${what} no catálogo. Confere a referência (ou cadastra a peça) e me manda de novo — não registro venda de produto que não existe.`);
      return { handled: true, outcome: "not_found" };
    }
    const product = found.product;

    // 2) Variante (tamanho/cor) — só das que EXISTEM.
    const v = this.findVariant(orgId, product.id, p);
    let variantId: string | null = null;
    let variantLabel = "";
    if (v.hasVariants && (p.size || p.color)) {
      if (!v.variant) {
        const opts = v.available.slice(0, 8).map((x: any) => x.name || [x.size, x.color].filter(Boolean).join(" / ")).join(" · ");
        await send(channelId, senderId, `❌ A peça *${product.name}* não tem a variação ${[p.size, p.color].filter(Boolean).join(" / ")}. Disponíveis: ${opts || "nenhuma cadastrada"}. Me manda de novo com uma delas.`);
        return { handled: true, outcome: "variant_not_found" };
      }
      variantId = v.variant.id;
      variantLabel = v.variant.name || [v.variant.size, v.variant.color].filter(Boolean).join(" / ");
    }

    // 3) Registra pelo caminho canônico (autoClose → 'pago' + baixa de estoque).
    const qty = p.quantity || 1;
    const unitOverride = Math.round(((p.amount as number) / qty) * 100) / 100;
    const notes = [
      `Registrada via WhatsApp (Zapp) por ${senderId}.`,
      p.size || p.color ? `Variação pedida: ${[p.size, p.color].filter(Boolean).join(" / ")}${variantLabel ? ` → ${variantLabel}` : ""}.` : "",
      `Pagamento: ${paymentLabel(p.payment as string)}.`,
    ].filter(Boolean).join(" ");
    let order: { id: string; status: string; total: number };
    try {
      const createOrder = deps?.createOrder || ((o: string, params: any) => OrdersService.createOrder(o, params));
      order = createOrder(orgId, {
        items: [{ productId: product.id, variantId, quantity: qty, priceOverride: unitOverride }],
        autoClose: true,
        createdBy: `whatsapp:${senderId}`,
        notes,
      });
    } catch (e: any) {
      // Estoque insuficiente etc. — a transação desfez tudo; repassa honesto.
      await send(channelId, senderId, `❌ Não registrei a venda: ${e?.message || "erro no pedido"}.`);
      return { handled: true, outcome: "error" };
    }

    // Forma de pagamento no pedido (coluna canônica) + auditoria.
    try { db.prepare(`UPDATE orders SET payment_method = ? WHERE id = ? AND organization_id = ?`).run(p.payment, order.id, orgId); } catch { /* aditivo */ }
    try { logAuthEvent(orgId, null, order.id, "SALE_REGISTERED_VIA_WHATSAPP", { senderId, reference: product.reference || null, amount: p.amount, payment: p.payment }); } catch { /* best-effort */ }

    const catalogPrice = Number((variantId ? v.variant?.price : null) ?? product.price ?? 0);
    const priceNote = catalogPrice > 0 && Math.abs(catalogPrice * qty - (p.amount as number)) >= 0.01
      ? `\n(valor de tabela: R$ ${(catalogPrice * qty).toFixed(2).replace(".", ",")} — registrei R$ ${(p.amount as number).toFixed(2).replace(".", ",")} como você informou)`
      : "";
    await send(channelId, senderId,
      `✅ Venda registrada!\n• ${product.name}${variantLabel ? ` (${variantLabel})` : ""}${qty > 1 ? ` ×${qty}` : ""}\n• Valor: R$ ${(p.amount as number).toFixed(2).replace(".", ",")} — ${paymentLabel(p.payment as string)}\n• Pedido nº ${order.id.slice(0, 8)} (status: pago, estoque baixado)${priceNote}`);
    return { handled: true, outcome: "registered", orderId: order.id };
  }
}
