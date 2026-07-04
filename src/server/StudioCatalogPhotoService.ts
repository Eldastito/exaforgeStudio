import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { editProductImageB64 } from "./llm.js";

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

/**
 * Foto profissional de catálogo (Fase B do cadastro por WhatsApp, ADR-032) —
 * quem decide GERAR ou REAPROVEITAR é sempre este serviço, chamado pela IA
 * Orquestradora (WhatsAppInventoryIntake) ANTES de gastar uma chamada de IA:
 * se o produto já tem `studio_image_url` (mesmo produto reconhecido por
 * match, não por busca de imagem — RAG aqui não guarda imagem, ver ADR-032),
 * reaproveita; só gera de novo quando realmente não existe ainda.
 *
 * Opt-in por loja (storefront_settings.ai_catalog_photos_enabled) — cada
 * geração custa uma chamada de IA extra; nem toda loja quer esse custo/estilo
 * por padrão. Nunca bloqueia o cadastro: qualquer falha (sem chave de IA,
 * moderação, rede) cai de volta na foto crua enviada pelo lojista.
 */
export class StudioCatalogPhotoService {
  static isEnabled(orgId: string): boolean {
    const row = db.prepare(`SELECT ai_catalog_photos_enabled FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!row?.ai_catalog_photos_enabled;
  }

  /** Reaproveita a foto de estúdio de um produto JÁ EXISTENTE (fluxo de reposição), sem gerar de novo. */
  static existingPhotoFor(orgId: string, productId: string): string | null {
    const row = db.prepare(`SELECT studio_image_url FROM products_services WHERE id = ? AND organization_id = ?`).get(productId, orgId) as any;
    return row?.studio_image_url || null;
  }

  /** Identidade visual da loja: paleta/tom (Estúdio de Criação, se já configurado) + cor de destaque/logo da vitrine. */
  private static stylePromptFor(orgId: string): string {
    const brand = db.prepare(`SELECT palette, tone, style FROM brand_profiles WHERE organization_id = ?`).get(orgId) as any;
    const storefront = db.prepare(`SELECT accent_color, logo_url FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any;
    const parts: string[] = [];
    if (brand?.style) parts.push(`Estilo da marca: ${brand.style}.`);
    if (brand?.tone) parts.push(`Tom visual: ${brand.tone}.`);
    try {
      const palette = brand?.palette ? JSON.parse(brand.palette) : null;
      if (Array.isArray(palette) && palette.length) parts.push(`Paleta de cores da marca: ${palette.join(", ")}.`);
    } catch { /* noop */ }
    if (!parts.length && storefront?.accent_color) parts.push(`Use a cor ${storefront.accent_color} como destaque sutil no fundo/composição.`);
    if (!parts.length) parts.push("Fundo neutro claro, iluminação de estúdio, estilo clean de e-commerce.");
    return parts.join(" ");
  }

  private static saveB64(b64: string): string {
    const fileName = `${uuidv4()}.png`;
    fs.writeFileSync(path.join(MEDIA_DIR, fileName), Buffer.from(b64, "base64"));
    return `/media/${fileName}`;
  }

  /**
   * Gera a foto de catálogo para um produto NOVO (ainda sem id) — o chamador
   * decide onde persistir a URL retornada (é a criação do produto que grava
   * `studio_image_url`). Retorna null em qualquer falha (nunca lança).
   */
  static async generateForNewProduct(orgId: string, rawBase64: string, rawMime: string): Promise<string | null> {
    if (!this.isEnabled(orgId)) return null;
    try {
      const b64 = await editProductImageB64(rawBase64, rawMime, this.stylePromptFor(orgId));
      if (!b64) return null;
      return this.saveB64(b64);
    } catch (e) {
      console.error("[StudioCatalogPhoto] Falha ao gerar foto de catálogo (produto novo)", e);
      return null;
    }
  }

  /**
   * Produto já existente (reposição): reaproveita se já tiver foto de
   * estúdio; senão gera e PERSISTE tanto em products_services.studio_image_url
   * quanto na capa de product_images — próxima reposição do mesmo produto
   * não gasta IA de novo.
   */
  static async ensureForExistingProduct(orgId: string, productId: string, rawBase64: string, rawMime: string): Promise<{ url: string | null; reused: boolean }> {
    if (!this.isEnabled(orgId)) return { url: null, reused: false };
    const existing = this.existingPhotoFor(orgId, productId);
    if (existing) return { url: existing, reused: true };
    try {
      const b64 = await editProductImageB64(rawBase64, rawMime, this.stylePromptFor(orgId));
      if (!b64) return { url: null, reused: false };
      const url = this.saveB64(b64);
      this.persistForProduct(orgId, productId, url);
      return { url, reused: false };
    } catch (e) {
      console.error("[StudioCatalogPhoto] Falha ao gerar foto de catálogo (reposição)", e);
      return { url: null, reused: false };
    }
  }

  /** Grava a URL em products_services.studio_image_url e troca a capa em product_images. */
  static persistForProduct(orgId: string, productId: string, url: string): void {
    db.prepare(`UPDATE products_services SET studio_image_url = ? WHERE id = ? AND organization_id = ?`).run(url, productId, orgId);
    const cover = db.prepare(`SELECT id FROM product_images WHERE product_service_id = ? ORDER BY position ASC LIMIT 1`).get(productId) as any;
    if (cover) db.prepare(`UPDATE product_images SET url = ? WHERE id = ?`).run(url, cover.id);
    else db.prepare(`INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, 0)`).run(uuidv4(), orgId, productId, url);
  }
}
