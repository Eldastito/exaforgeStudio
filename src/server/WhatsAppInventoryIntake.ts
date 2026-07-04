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
import { StudioCatalogPhotoService } from "./StudioCatalogPhotoService.js";
import { savePendingAction, clearPendingAction } from "./PendingManagerActions.js";

// Recusa explícita a informar preço/margem/quantidade (ADR-032) — distinta de
// uma resposta que só não trouxe NENHUM valor por acaso: só conta como
// recusa quando a mensagem claramente diz "não" a fornecer o dado, nunca por
// silêncio ou ambiguidade (isso continua só reperguntando).
export const DECLINE_PATTERN = /^(n[ãa]o(\s+sei|\s+quero|\s+tenho)?|prefiro\s+n[ãa]o|depois\s+eu\s+vejo|agora\s+n[ãa]o|deixa\s+(pra\s+depois|assim|quieto)|pula|pular|sem\s+essa|n[ãa]o\s+vou\s+informar)\b/i;

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
      const reply = type === "product"
        ? await this.startProductRegistration(orgId, identifier, base64, mime)
        : await this.startInvoiceRegistration(orgId, identifier, base64, mime);
      return reply + this.maybeNudge(orgId);
    } catch (e) {
      console.error("[WhatsAppInventoryIntake] Falha ao processar foto", e);
      return "Não consegui analisar essa foto agora. Pode tentar de novo em instantes?";
    }
  }

  /**
   * Auditoria proativa de produtos sem preço/venda (ADR-032) — NUNCA dispara
   * mensagem só para isso; só aparece grudada numa resposta que já ia sair
   * (o gestor já está conversando). Rate-limit de 24h por organização
   * (organization_settings.pending_pricing_nudge_at) para não virar spam a
   * cada mensagem enquanto houver produtos incompletos.
   */
  /** Não-privado: testado diretamente em scripts/test-whatsapp-inventory-fase-b.ts. */
  static maybeNudge(orgId: string): string {
    try {
      const org = db.prepare(`SELECT pending_pricing_nudge_at FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      if (org?.pending_pricing_nudge_at) {
        const last = new Date(org.pending_pricing_nudge_at).getTime();
        if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return "";
      }
      const incomplete = InventoryIntakeService.incompletePricingProducts(orgId);
      if (!incomplete.length) return "";
      db.prepare(`UPDATE organization_settings SET pending_pricing_nudge_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
      const names = incomplete.slice(0, 5).map((p) => p.name).join(", ");
      const more = incomplete.length > 5 ? ` e mais ${incomplete.length - 5}` : "";
      return `\n\n⚠️ *Aproveitando que você está por aqui*: ${incomplete.length} produto(s) sem preço de venda, fora da vitrine: ${names}${more}. Sem o preço, ninguém consegue comprar — me diga o preço de qualquer um deles quando puder.`;
    } catch (e) { return ""; }
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
        if (/produto|item|avulso/.test(t)) return (await this.startProductRegistration(orgId, identifier, payload.base64, payload.mime)) + this.maybeNudge(orgId);
        if (/nota|fiscal|cupom|comprovante/.test(t)) return (await this.startInvoiceRegistration(orgId, identifier, payload.base64, payload.mime)) + this.maybeNudge(orgId);
        // Resposta ambígua: restaura a pendência e pergunta de novo.
        savePendingAction(orgId, identifier, "awaiting_photo_type", payload);
        return "Não entendi — pode responder só *produto* ou *nota fiscal*?";
      }
      if (pending.action_type === "product_registration") return (await this.continueProductRegistration(orgId, identifier, pending, payload, text)) + this.maybeNudge(orgId);
      if (pending.action_type === "invoice_registration") return (await this.continueInvoiceRegistration(orgId, identifier, pending, payload, text)) + this.maybeNudge(orgId);
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

    // Reconhece o catálogo ANTES de perguntar preço: mesmo produto já
    // cadastrado (limiar 0.75, igual à reposição automática do Fluxo 2 — sem
    // humano conferindo aqui) vira reposição, reaproveitando o preço/margem
    // já praticados em vez de perguntar tudo de novo (ADR-032).
    const catalog = db.prepare(`SELECT id, name, price, margin_percent FROM products_services WHERE organization_id = ? AND type = 'product' AND active = 1`).all(orgId) as any[];
    const match = findBestProductMatch(extracted.name, catalog, 0.75);
    const matchedRow = match ? catalog.find((c) => c.id === match.id) : null;

    if (match && matchedRow) {
      savePendingAction(orgId, identifier, "product_registration", {
        mode: "restock", base64: b64, mime: "image/jpeg", imageUrl,
        matchedProductId: match.id, matchedProductName: match.name, matchedPrice: matchedRow.price, matchedMargin: matchedRow.margin_percent,
        collected: {},
      });
      const priceLine = matchedRow.price != null
        ? `mesmo preço de R$ ${Number(matchedRow.price).toFixed(2)}${matchedRow.margin_percent != null ? ` (margem ${matchedRow.margin_percent}%)` : ""}`
        : "sem preço de venda definido ainda";
      return `📦 Esse produto já é seu: *${match.name}*! Vou repor o estoque usando o ${priceLine} — me diz só: quantas unidades chegaram?`;
    }

    savePendingAction(orgId, identifier, "product_registration", { mode: "new", base64: b64, mime: "image/jpeg", imageUrl, extracted, collected: {} });
    const label = [extracted.name, extracted.weightLabel].filter(Boolean).join(" — ");
    return `📦 Identifiquei: *${label}*${extracted.brand ? ` (${extracted.brand})` : ""}. Para cadastrar e publicar na vitrine, me diga:\n1) Quanto você pagou (custo)?\n2) Que margem de lucro quer aplicar? (ou já me diga o preço de venda final)\n3) Quantas unidades tem em estoque?\n\n_Preciso do preço de venda porque sem ele o produto fica só no controle de estoque — não posso publicar na vitrine e nenhum cliente consegue comprar._`;
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

  /** Foto de catálogo profissional (opt-in) — nunca bloqueia; falha/desligado cai na foto crua. */
  private static async catalogImageUrl(orgId: string, payload: any, fallbackUrl: string, existingProductId?: string): Promise<string> {
    if (existingProductId) {
      const r = await StudioCatalogPhotoService.ensureForExistingProduct(orgId, existingProductId, payload.base64, payload.mime || "image/jpeg");
      return r.url || fallbackUrl;
    }
    const url = await StudioCatalogPhotoService.generateForNewProduct(orgId, payload.base64, payload.mime || "image/jpeg");
    return url || fallbackUrl;
  }

  private static async continueProductRegistration(orgId: string, identifier: string, pending: any, payload: any, text: string): Promise<string> {
    if (payload.mode === "restock") return this.continueProductRestock(orgId, identifier, pending, payload, text);

    // Recusa explícita: só quando NADA foi extraído da mensagem e o texto
    // claramente recusa — nunca por silêncio/ambiguidade (essas só reperguntam).
    if (DECLINE_PATTERN.test(text.trim())) {
      const parsedOnDecline = await parseInventoryReply(text, ["quantity"]);
      const quantity = parsedOnDecline.quantity ?? 0;
      clearPendingAction(pending.id);
      const imageUrl = await this.catalogImageUrl(orgId, payload, payload.imageUrl);
      InventoryIntakeService.commitProductWithoutPrice(orgId, {
        name: payload.extracted.name, category: payload.extracted.category, description: payload.extracted.description,
        quantity, imageUrl,
      });
      return `Tudo bem, sem problema! Guardei *${payload.extracted.name}* no estoque (${quantity} un.), mas SEM publicar na vitrine — sem o preço de venda, nenhum cliente consegue comprar esse item. Quando quiser informar o preço, é só me chamar de novo. 👍`;
    }

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
    const imageUrl = await this.catalogImageUrl(orgId, payload, payload.imageUrl);
    const marginPercent = payload.collected.costPrice != null && payload.collected.marginPercent != null ? payload.collected.marginPercent : null;
    const productId = InventoryIntakeService.commitProductFromScan(orgId, {
      name: payload.extracted.name, category: payload.extracted.category, description: payload.extracted.description,
      salePrice: after.salePrice!, marginPercent, quantity: payload.collected.quantity, imageUrl,
    });
    InventoryIntakeService.recordPriceHistory(orgId, {
      productId, productName: payload.extracted.name, category: payload.extracted.category,
      costPrice: payload.collected.costPrice ?? null, marginPercent, salePrice: after.salePrice!, source: "whatsapp_manager",
    });
    return `✅ Produto *${payload.extracted.name}* cadastrado e publicado na vitrine! Preço R$ ${after.salePrice!.toFixed(2)}, ${payload.collected.quantity} unidade(s) em estoque.`;
  }

  /** Reposição de um produto já reconhecido no catálogo — só falta a quantidade. */
  private static async continueProductRestock(orgId: string, identifier: string, pending: any, payload: any, text: string): Promise<string> {
    const parsed = await parseInventoryReply(text, ["quantity"]);
    if (parsed.quantity == null) {
      savePendingAction(orgId, identifier, "product_registration", payload);
      return "Não entendi a quantidade. Quantas unidades chegaram?";
    }
    clearPendingAction(pending.id);
    InventoryIntakeService.restockProductFromScan(orgId, { productId: payload.matchedProductId, quantity: parsed.quantity });
    const { url, reused } = await StudioCatalogPhotoService.ensureForExistingProduct(orgId, payload.matchedProductId, payload.base64, payload.mime || "image/jpeg");
    if (url && !reused) StudioCatalogPhotoService.persistForProduct(orgId, payload.matchedProductId, url);

    const priceNote = payload.matchedPrice != null
      ? `Preço mantido: R$ ${Number(payload.matchedPrice).toFixed(2)}${payload.matchedMargin != null ? ` (margem ${payload.matchedMargin}%)` : ""}.`
      : "⚠️ Esse produto ainda não tem preço de venda definido — ele continua fora da vitrine até alguém informar o preço.";
    return `✅ Estoque de *${payload.matchedProductName}* reposto (+${parsed.quantity} un.). ${priceNote}`;
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
      "_Preciso do preço de venda porque sem ele o item fica só no controle de estoque — não posso publicar na vitrine e nenhum cliente consegue comprar._",
    ].filter(Boolean).join("\n\n");
  }

  private static askInvoiceItemPrice(item: any): string {
    return `*${item.name}* — custo R$ ${item.unitCost.toFixed(2)}, quantidade ${item.quantity}. Qual o preço de venda? (sugestão: R$ ${item.suggestedSalePrice.toFixed(2)})`;
  }

  private static advanceInvoiceQueue(orgId: string, identifier: string, pending: any, payload: any, createdMsg: string): string {
    const queue = payload.queue as any[];
    const nextIndex = payload.currentIndex + 1;
    if (nextIndex >= queue.length) {
      clearPendingAction(pending.id);
      return `${createdMsg}\n\n🎉 Nota fiscal totalmente processada!`;
    }
    payload.currentIndex = nextIndex;
    savePendingAction(orgId, identifier, "invoice_registration", payload);
    return `${createdMsg}\n\n${this.askInvoiceItemPrice(queue[nextIndex])}`;
  }

  private static async continueInvoiceRegistration(orgId: string, identifier: string, pending: any, payload: any, text: string): Promise<string> {
    const queue = payload.queue as any[];
    const current = queue[payload.currentIndex];

    if (DECLINE_PATTERN.test(text.trim())) {
      InventoryIntakeService.commitInvoiceItemWithoutPrice(orgId, {
        name: current.name, quantity: current.quantity, unitCost: current.unitCost, supplierName: payload.supplierName,
      });
      const createdMsg = `Tudo bem! Guardei *${current.name}* no estoque (${current.quantity} un., custo R$ ${current.unitCost.toFixed(2)}), mas SEM publicar na vitrine — sem o preço de venda, nenhum cliente consegue comprar esse item.`;
      return this.advanceInvoiceQueue(orgId, identifier, pending, payload, createdMsg);
    }

    const parsed = await parseInventoryReply(text, ["priceOrMargin"]);
    let salePrice = parsed.salePrice;
    if (salePrice == null && parsed.marginPercent != null) {
      salePrice = Math.round(current.unitCost * (1 + parsed.marginPercent / 100) * 100) / 100;
    }
    if (salePrice == null || !(salePrice > 0)) {
      savePendingAction(orgId, identifier, "invoice_registration", payload);
      return `Não entendi o preço. ${this.askInvoiceItemPrice(current)}`;
    }

    const marginPercent = parsed.marginPercent ?? (current.unitCost > 0 ? Math.round(((salePrice - current.unitCost) / current.unitCost) * 10000) / 100 : null);
    InventoryIntakeService.commitInvoiceItemCreate(orgId, {
      name: current.name, salePrice, marginPercent, quantity: current.quantity, unitCost: current.unitCost, supplierName: payload.supplierName,
    });
    InventoryIntakeService.recordPriceHistory(orgId, {
      productName: current.name, costPrice: current.unitCost, marginPercent, salePrice, source: "whatsapp_manager_invoice",
    });

    const createdMsg = `✅ *${current.name}* cadastrado (R$ ${salePrice.toFixed(2)}, ${current.quantity} un.) e publicado na vitrine.`;
    return this.advanceInvoiceQueue(orgId, identifier, pending, payload, createdMsg);
  }
}
