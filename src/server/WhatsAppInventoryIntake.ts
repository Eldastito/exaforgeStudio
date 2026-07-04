import fs from "fs";
import path from "path";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { classifyInventoryPhoto, extractProductFromImage, extractInvoiceItems, parseInventoryReply } from "./llm.js";
import { findBestProductMatch } from "./productMatcher.js";
import { suggestSalePrice } from "./pricing.js";
import { orgMarkup } from "./routes/products.js";
import { InventoryIntakeService } from "./InventoryIntakeService.js";
import { savePendingAction, clearPendingAction } from "./PendingManagerActions.js";

// Mesmo diretório de mídia usado pelo painel (routes/products.ts / routes/uploads.ts).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

/**
 * Cadastro de estoque/vitrine direto no WhatsApp, pelo canal do GESTOR
 * autorizado (mesmo mecanismo do "Zapp"/orchestrator_agent, ver
 * AIOrchestratorService.findAuthorizedManager) — a "IA do negócio", separada
 * da IA de atendimento ao cliente final.
 *
 * Fluxo 1 (foto de produto avulso): classifica -> extrai nome/marca/peso
 * (nunca preço, mesma regra da ADR-020) -> pergunta custo/margem/quantidade
 * na conversa -> publica na vitrine.
 * Fluxo 2 (foto de nota fiscal): extrai itens -> item com match forte no
 * catálogo (limiar mais alto que a tela de revisão, aqui não há humano
 * conferindo antes) repõe estoque sozinho; item novo pergunta só o preço de
 * venda (quantidade/custo já vêm da nota, dado real, não palpite).
 *
 * O estado da conversa (o que já foi perguntado/respondido) vive em
 * pending_manager_actions, reaproveitando o mesmo mecanismo já usado pela
 * confirmação de campanha do Zapp — um gestor tem no máximo UM cadastro em
 * andamento por vez.
 */
export class WhatsAppInventoryIntake {
  static async handlePhoto(orgId: string, identifier: string, base64: string, mime: string): Promise<string> {
    try {
      const type = await classifyInventoryPhoto(base64, mime);
      if (type === "unclear") {
        savePendingAction(orgId, identifier, "awaiting_photo_type", { base64, mime });
        return "Recebi a foto! Ela é de um *produto* avulso (embalagem/rótulo) ou de uma *nota fiscal*? Me responda com uma das duas palavras. 🙂";
      }
      if (type === "product") return await this.startProductRegistration(orgId, identifier, base64, mime);
      return await this.startInvoiceRegistration(orgId, identifier, base64, mime);
    } catch (e) {
      console.error("[WhatsAppInventoryIntake] Falha ao processar foto", e);
      return "Não consegui analisar essa foto agora. Pode tentar de novo em instantes?";
    }
  }

  static async handleReply(orgId: string, identifier: string, pending: any, text: string): Promise<string> {
    if (pending.expires_at && new Date(pending.expires_at).getTime() < Date.now()) {
      clearPendingAction(pending.id);
      return "Esse cadastro expirou (mais de 1h parado). Pode mandar a foto de novo quando quiser. 🙂";
    }
    let payload: any = {};
    try { payload = JSON.parse(pending.payload_json || "{}"); } catch {
      clearPendingAction(pending.id);
      return "Não consegui recuperar os dados desse cadastro. Pode mandar a foto de novo?";
    }

    try {
      if (pending.action_type === "awaiting_photo_type") {
        const t = text.toLowerCase();
        clearPendingAction(pending.id);
        if (/produto|item|avulso/.test(t)) return await this.startProductRegistration(orgId, identifier, payload.base64, payload.mime);
        if (/nota|fiscal|cupom|comprovante/.test(t)) return await this.startInvoiceRegistration(orgId, identifier, payload.base64, payload.mime);
        // Resposta ambígua: restaura a pendência e pergunta de novo.
        savePendingAction(orgId, identifier, "awaiting_photo_type", payload);
        return "Não entendi — pode responder só *produto* ou *nota fiscal*?";
      }
      if (pending.action_type === "product_registration") return await this.continueProductRegistration(orgId, identifier, pending, payload, text);
      if (pending.action_type === "invoice_registration") return await this.continueInvoiceRegistration(orgId, identifier, pending, payload, text);
      return "Ação concluída.";
    } catch (e) {
      console.error("[WhatsAppInventoryIntake] Falha ao continuar cadastro", e);
      return "Tive um problema para continuar esse cadastro. Pode tentar responder de novo?";
    }
  }

  // ---- Fluxo 1: foto de produto avulso ----

  private static async startProductRegistration(orgId: string, identifier: string, base64: string, mime: string): Promise<string> {
    const processed = await sharp(Buffer.from(base64, "base64")).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const b64 = processed.toString("base64");
    const fileName = `${uuidv4()}.jpg`;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), processed);
    const imageUrl = `/media/${fileName}`;

    const raw = await extractProductFromImage(b64, "image/jpeg");
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { /* fica {} */ }

    const extracted = {
      name: String(parsed.name || "").trim().slice(0, 120) || "Produto não identificado",
      brand: parsed.brand ? String(parsed.brand).trim().slice(0, 80) : null,
      category: parsed.category ? String(parsed.category).trim().slice(0, 80) : null,
      weightLabel: parsed.weightLabel ? String(parsed.weightLabel).trim().slice(0, 40) : null,
      description: String(parsed.description || "").trim().slice(0, 500),
    };

    savePendingAction(orgId, identifier, "product_registration", { imageUrl, extracted, collected: {} });
    const label = [extracted.name, extracted.weightLabel].filter(Boolean).join(" — ");
    return `📦 Identifiquei: *${label}*${extracted.brand ? ` (${extracted.brand})` : ""}. Para cadastrar e publicar na vitrine, me diga:\n1) Quanto você pagou (custo)?\n2) Que margem de lucro quer aplicar? (ou já me diga o preço de venda final)\n3) Quantas unidades tem em estoque?`;
  }

  /** Não-privado: testado diretamente (lógica pura, sem I/O) em scripts/test-whatsapp-inventory-intake.ts. */
  static resolveProductFields(collected: any): { ready: boolean; missing: string[]; salePrice?: number } {
    let salePrice = collected.salePrice;
    if (salePrice == null && collected.costPrice != null && collected.marginPercent != null) {
      salePrice = Math.round(collected.costPrice * (1 + collected.marginPercent / 100) * 100) / 100;
    }
    const missing: string[] = [];
    if (salePrice == null) missing.push(collected.costPrice == null ? "costPrice" : "priceOrMargin");
    if (collected.quantity == null) missing.push("quantity");
    return { ready: missing.length === 0, missing, salePrice };
  }

  private static askMissingText(missing: string[]): string {
    const labels: Record<string, string> = {
      costPrice: "quanto você pagou (custo)",
      priceOrMargin: "que margem de lucro quer aplicar (ou já me diga o preço de venda final)",
      quantity: "quantas unidades tem em estoque",
    };
    return `Ainda preciso saber: ${missing.map((m) => labels[m]).join(" e ")}.`;
  }

  private static async continueProductRegistration(orgId: string, identifier: string, pending: any, payload: any, text: string): Promise<string> {
    const before = this.resolveProductFields(payload.collected || {});
    const parsed = await parseInventoryReply(text, before.missing);
    payload.collected = { ...(payload.collected || {}), ...parsed };
    const after = this.resolveProductFields(payload.collected);

    if (!after.ready) {
      savePendingAction(orgId, identifier, "product_registration", payload);
      if (Object.keys(parsed).length === 0) return `Não consegui entender nenhum valor nessa mensagem. ${this.askMissingText(after.missing)}`;
      return this.askMissingText(after.missing);
    }

    clearPendingAction(pending.id);
    const productId = InventoryIntakeService.commitProductFromScan(orgId, {
      name: payload.extracted.name, category: payload.extracted.category, description: payload.extracted.description,
      salePrice: after.salePrice!, quantity: payload.collected.quantity, imageUrl: payload.imageUrl,
    });
    InventoryIntakeService.recordPriceHistory(orgId, {
      productId, productName: payload.extracted.name, category: payload.extracted.category,
      costPrice: payload.collected.costPrice ?? null, marginPercent: payload.collected.marginPercent ?? null,
      salePrice: after.salePrice!, source: "whatsapp_manager",
    });
    return `✅ Produto *${payload.extracted.name}* cadastrado e publicado na vitrine! Preço R$ ${after.salePrice!.toFixed(2)}, ${payload.collected.quantity} unidade(s) em estoque.`;
  }

  // ---- Fluxo 2: foto de nota fiscal ----

  private static async startInvoiceRegistration(orgId: string, identifier: string, base64: string, mime: string): Promise<string> {
    const processed = await sharp(Buffer.from(base64, "base64")).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    const b64 = processed.toString("base64");

    const raw = await extractInvoiceItems(b64, "image/jpeg");
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { /* fica {} */ }

    const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 60).map((it: any) => ({
      name: String(it?.name || "").trim().slice(0, 120),
      quantity: Math.max(0, Number(it?.quantity) || 0),
      unitCost: Math.max(0, Number(it?.unitCost) || 0),
    })).filter((it: any) => it.name && it.quantity > 0);
    const supplierName = parsed.supplierName ? String(parsed.supplierName).trim().slice(0, 120) : null;

    if (!items.length) return "Não consegui identificar itens de compra nessa nota. Pode mandar uma foto mais nítida?";

    const catalog = db.prepare(`SELECT id, name FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1`).all(orgId) as any[];
    const markup = orgMarkup(orgId);
    const queue: any[] = [];
    const restockedNames: string[] = [];
    for (const it of items) {
      // Limiar mais alto (0.75) que o da tela de revisão (0.6, ADR-024): ali um
      // humano ainda confere antes de confirmar; aqui a reposição é automática
      // e sem revisão, então só aceitamos matches bem fortes.
      const match = findBestProductMatch(it.name, catalog, 0.75);
      if (match) {
        InventoryIntakeService.commitInvoiceItemRestock(orgId, { productId: match.id, quantity: it.quantity, unitCost: it.unitCost, supplierName });
        restockedNames.push(`${match.name} (+${it.quantity})`);
      } else {
        queue.push({ ...it, suggestedSalePrice: suggestSalePrice(it.unitCost, markup) });
      }
    }

    const restockSummary = restockedNames.length ? `✅ Reposição automática no estoque: ${restockedNames.join(", ")}.` : "";

    if (!queue.length) {
      return [restockSummary, "Nenhum item novo nesta nota — nada mais para cadastrar. 👍"].filter(Boolean).join("\n\n");
    }

    savePendingAction(orgId, identifier, "invoice_registration", { supplierName, queue, currentIndex: 0 });
    const first = queue[0];
    return [
      restockSummary,
      `🆕 Encontrei *${queue.length} item(ns) novo(s)* na nota. Vamos cadastrar um de cada vez.`,
      this.askInvoiceItemPrice(first),
    ].filter(Boolean).join("\n\n");
  }

  private static askInvoiceItemPrice(item: any): string {
    return `*${item.name}* — custo R$ ${item.unitCost.toFixed(2)}, quantidade ${item.quantity}. Qual o preço de venda? (sugestão: R$ ${item.suggestedSalePrice.toFixed(2)})`;
  }

  private static async continueInvoiceRegistration(orgId: string, identifier: string, pending: any, payload: any, text: string): Promise<string> {
    const queue = payload.queue as any[];
    const current = queue[payload.currentIndex];
    const parsed = await parseInventoryReply(text, ["priceOrMargin"]);
    let salePrice = parsed.salePrice;
    if (salePrice == null && parsed.marginPercent != null) {
      salePrice = Math.round(current.unitCost * (1 + parsed.marginPercent / 100) * 100) / 100;
    }
    if (salePrice == null || !(salePrice > 0)) {
      savePendingAction(orgId, identifier, "invoice_registration", payload);
      return `Não entendi o preço. ${this.askInvoiceItemPrice(current)}`;
    }

    InventoryIntakeService.commitInvoiceItemCreate(orgId, {
      name: current.name, salePrice, quantity: current.quantity, unitCost: current.unitCost, supplierName: payload.supplierName,
    });
    InventoryIntakeService.recordPriceHistory(orgId, {
      productName: current.name, costPrice: current.unitCost, marginPercent: parsed.marginPercent ?? null,
      salePrice, source: "whatsapp_manager_invoice",
    });

    const createdMsg = `✅ *${current.name}* cadastrado (R$ ${salePrice.toFixed(2)}, ${current.quantity} un.) e publicado na vitrine.`;
    const nextIndex = payload.currentIndex + 1;
    if (nextIndex >= queue.length) {
      clearPendingAction(pending.id);
      return `${createdMsg}\n\n🎉 Nota fiscal totalmente processada!`;
    }
    payload.currentIndex = nextIndex;
    savePendingAction(orgId, identifier, "invoice_registration", payload);
    return `${createdMsg}\n\n${this.askInvoiceItemPrice(queue[nextIndex])}`;
  }
}
