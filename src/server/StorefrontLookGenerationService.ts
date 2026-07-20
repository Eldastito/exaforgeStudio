import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { chat, isAIConfigured, editImagesB64, editImagesGoogleB64 } from "./llm.js";
import { JobQueueService } from "./JobQueueService.js";
import { PlanService } from "./PlanService.js";
import { FashionPresetAvatarService } from "./FashionPresetAvatarService.js";

/**
 * Geração + publicação das fotos do look de vitrine (ADR-104 Bloco 3).
 *
 * Look aprovado no Kanban → fila → a IA veste o AVATAR (modelo preset da loja)
 * com as peças e gera 2 poses → publica na galeria de looks da vitrine.
 *
 * Decisões de campo (Emerson, jul/26):
 *  - 2 imagens por look (2 poses do mesmo avatar).
 *  - A IA ESCOLHE o avatar por TOM DE PELE (clara/média/escura) que melhor
 *    combina com as cores das peças — override manual pelo gerente (preset fixo).
 *  - O gerente decide: publicar direto (vitrine_auto_publish) OU revisar antes.
 *
 * Economia (regra da ADR): imagem só de look APROVADO; conta no teto mensal de
 * estúdio (studio_creations/PlanService.studioAllowed) — fecha a lacuna em que a
 * foto de catálogo não contava. Sem consentimento (é modelo da loja, /media público).
 */

const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

// Prompt-base FIXO (nunca composto com texto do catálogo/cliente): preserva a
// identidade do modelo e veste as peças. A pose entra por parâmetro controlado.
const BASE_PROMPT =
  "A primeira imagem é a foto de um(a) modelo. Gere uma foto de catálogo de moda mostrando ESSE MESMO modelo — o mesmíssimo rosto, tom de pele, cabelo e corpo — vestindo as peças de roupa das demais imagens. " +
  "Regras invioláveis: não troque a pessoa nem gere outro rosto; não adicione outras pessoas; nenhuma nudez ou sexualização; mantenha as peças fiéis às fotos originais (cor, estampa, modelagem); corpo inteiro, fundo neutro de estúdio, luz de catálogo. ";
const POSES = [
  "Enquadramento frontal, postura de vitrine, olhando para a câmera.",
  "Postura levemente de perfil (3/4), pose de passarela, corpo inteiro.",
];

function usingGoogle(): boolean {
  return !!(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY);
}

export class StorefrontLookGenerationService {
  // ---- escolha do avatar (a IA casa tom de pele com as cores da roupa) ----

  /** Avatar a usar: o fixado pelo gerente (se ativo) OU a escolha da IA por tom de pele; fallback = 1º ativo. */
  static async chooseAvatar(orgId: string, look: any): Promise<any | null> {
    const avatars = FashionPresetAvatarService.list(orgId, { activeOnly: true });
    if (!avatars.length) return null;
    if (look.preset_avatar_id) {
      const fixed = avatars.find((a) => a.id === look.preset_avatar_id);
      if (fixed) return fixed;
    }
    if (avatars.length === 1 || !isAIConfigured()) return avatars[0];

    try {
      const pieces = (db.prepare(
        `SELECT ps.name, ps.category FROM storefront_look_items sli JOIN products_services ps ON ps.id = sli.product_service_id
         WHERE sli.look_id = ? AND sli.organization_id = ?`
      ).all(look.id, orgId) as any[]).map((r) => `${r.name}${r.category ? ` (${r.category})` : ""}`).join("; ");
      const options = avatars.map((a) => `${a.id} | ${a.label || "Modelo"} | pele ${a.skin_tone || "media"} | corpo ${a.body_type || "outro"}`).join("\n");
      const system = "Você é uma diretora de arte de moda. Escolha o MODELO cujo tom de pele valoriza melhor as cores das peças (ex.: roupas de cores muito claras/pastel ganham contraste com pele mais escura; cores escuras/vibrantes ficam ótimas em pele clara). Responda SOMENTE JSON com o id exato de um modelo da lista.";
      const prompt = `Peças do look: ${pieces || "não informado"}.\n\nModelos disponíveis (id | nome | tom de pele | corpo):\n${options}\n\nResponda: {"avatarId":"<id da lista>"}`;
      const raw = await chat(prompt, { json: true, temperature: 0.2, system });
      let parsed: any = {};
      try { parsed = JSON.parse(raw || "{}"); } catch { /* noop */ }
      const chosen = avatars.find((a) => a.id === String(parsed?.avatarId || ""));
      if (chosen) return chosen;
    } catch (e) { console.error("[StorefrontLookGen] escolha de avatar por IA falhou; usando o 1º ativo", e); }
    return avatars[0];
  }

  // ---- enfileirar a geração ----

  static requestGeneration(orgId: string, lookId: string): { ok: true; status: string; reused: boolean } | { ok: false; error: string } {
    const look = db.prepare(`SELECT * FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(lookId, orgId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    if (look.status === "archived") return { ok: false, error: "Look arquivado." };
    // Idempotência/economia: não regera o que já está pronto ou em andamento.
    if (["queued", "processing", "done"].includes(look.generation_status)) return { ok: true, status: look.generation_status, reused: true };

    const items = db.prepare(`SELECT 1 FROM storefront_look_items WHERE look_id = ? AND organization_id = ?`).all(lookId, orgId);
    if (!items.length) return { ok: false, error: "O look não tem peças." };
    if (!FashionPresetAvatarService.list(orgId, { activeOnly: true }).length) {
      return { ok: false, error: "Cadastre ao menos um avatar (modelo) do provador antes de gerar as fotos." };
    }
    const gate = PlanService.studioAllowed(orgId, "image");
    if (!gate.allowed) return { ok: false, error: `Limite de imagens de estúdio do plano atingido este mês (${gate.used}/${gate.limit}).` };

    db.prepare(`UPDATE storefront_looks SET generation_status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(lookId, orgId);
    JobQueueService.enqueue("storefront_look_image", { lookId, orgId }, { organizationId: orgId, maxAttempts: 1 });
    return { ok: true, status: "queued", reused: false };
  }

  // ---- executar (handler da fila) ----

  private static garmentImages(orgId: string, lookId: string): { buffer: Buffer; name: string; mime: string }[] {
    const items = db.prepare(
      `SELECT ps.name, ps.studio_image_url,
              (SELECT url FROM product_images pi WHERE pi.product_service_id = ps.id ORDER BY position ASC, created_at ASC LIMIT 1) AS cover
       FROM storefront_look_items sli JOIN products_services ps ON ps.id = sli.product_service_id
       WHERE sli.look_id = ? AND sli.organization_id = ? ORDER BY sli.position ASC`
    ).all(lookId, orgId) as any[];
    const out: { buffer: Buffer; name: string; mime: string }[] = [];
    for (const it of items.slice(0, 4)) { // 1 avatar + até 4 peças por chamada
      const url = it.studio_image_url || it.cover;
      if (!url || !String(url).startsWith("/media/")) continue;
      const file = path.join(MEDIA_DIR, path.basename(url));
      if (!fs.existsSync(file)) continue;
      const ext = path.extname(file).toLowerCase();
      out.push({ buffer: fs.readFileSync(file), name: it.name, mime: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg" });
    }
    return out;
  }

  private static async generateOne(avatarBuf: Buffer, garments: { buffer: Buffer; name: string; mime: string }[], pose: string): Promise<string | null> {
    const prompt = BASE_PROMPT + pose;
    try {
      if (usingGoogle()) {
        const b64 = await editImagesGoogleB64([{ buffer: avatarBuf, mime: "image/jpeg" }, ...garments.map((g) => ({ buffer: g.buffer, mime: g.mime }))], prompt);
        return b64 || null;
      }
      const images = [{ buffer: avatarBuf, name: "modelo.jpg", mime: "image/jpeg" }, ...garments.map((g, i) => ({ buffer: g.buffer, name: `peca-${i + 1}.jpg`, mime: g.mime }))];
      const b64 = await editImagesB64(images, prompt, { inputFidelity: "high", quality: "high", size: "1024x1536" });
      return b64 || null;
    } catch (e) { console.error("[StorefrontLookGen] geração falhou", e); return null; }
  }

  static async processJob(lookId: string, orgId: string): Promise<void> {
    const look = db.prepare(`SELECT * FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(lookId, orgId) as any;
    if (!look || look.generation_status !== "queued") return;
    db.prepare(`UPDATE storefront_looks SET generation_status = 'processing' WHERE id = ?`).run(lookId);

    const fail = (msg: string) => {
      db.prepare(`UPDATE storefront_looks SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(lookId);
      console.error(`[StorefrontLookGen] ${lookId}: ${msg}`);
    };

    try {
      const avatar = await this.chooseAvatar(orgId, look);
      const avatarUrl = avatar?.image_url;
      if (!avatarUrl || !String(avatarUrl).startsWith("/media/")) return fail("avatar indisponível");
      const avatarFile = path.join(MEDIA_DIR, path.basename(avatarUrl));
      if (!fs.existsSync(avatarFile)) return fail("arquivo do avatar não encontrado");
      const avatarBuf = fs.readFileSync(avatarFile);

      const garments = this.garmentImages(orgId, lookId);
      if (!garments.length) return fail("fotos das peças indisponíveis");

      const insImg = db.prepare(`INSERT INTO storefront_look_images (id, organization_id, look_id, url, position) VALUES (?, ?, ?, ?, ?)`);
      const recCreation = db.prepare(`INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url) VALUES (?, ?, 'image', ?, ?)`);
      let made = 0;
      for (let i = 0; i < POSES.length; i++) {
        // Respeita o teto a cada imagem — se estourar no meio, para (publica o que fez).
        if (!PlanService.studioAllowed(orgId, "image").allowed) break;
        const b64 = await this.generateOne(avatarBuf, garments, POSES[i]);
        if (!b64) continue;
        const fileName = `${uuidv4()}.png`;
        fs.writeFileSync(path.join(MEDIA_DIR, fileName), Buffer.from(b64, "base64"));
        const url = `/media/${fileName}`;
        insImg.run(uuidv4(), orgId, lookId, url, i);
        recCreation.run(uuidv4(), orgId, `Look de vitrine (${avatar.label || "modelo"})`, url);
        made++;
      }
      if (!made) return fail("nenhuma imagem gerada");

      // Fixa o avatar usado e marca pronto; publica direto se a loja escolheu isso.
      const autoPublish = (db.prepare(`SELECT vitrine_auto_publish FROM storefront_settings WHERE organization_id = ?`).get(orgId) as any)?.vitrine_auto_publish ? 1 : 0;
      const firstUrl = (db.prepare(`SELECT url FROM storefront_look_images WHERE look_id = ? AND organization_id = ? ORDER BY position ASC LIMIT 1`).get(lookId, orgId) as any)?.url || null;
      db.prepare(`UPDATE storefront_looks SET generation_status = 'done', preset_avatar_id = ?, published_image_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(avatar.id, autoPublish ? firstUrl : look.published_image_url, autoPublish ? "published" : look.status, lookId);
    } catch (e: any) {
      fail(String(e?.message || e).slice(0, 200));
    }
  }

  // ---- publicação manual (quando não é publicar-direto) ----

  static publish(orgId: string, lookId: string): { ok: true } | { ok: false; error: string } {
    const look = db.prepare(`SELECT generation_status FROM storefront_looks WHERE id = ? AND organization_id = ?`).get(lookId, orgId) as any;
    if (!look) return { ok: false, error: "Look não encontrado." };
    const first = db.prepare(`SELECT url FROM storefront_look_images WHERE look_id = ? AND organization_id = ? ORDER BY position ASC LIMIT 1`).get(lookId, orgId) as any;
    if (!first) return { ok: false, error: "Gere as fotos do look antes de publicar." };
    db.prepare(`UPDATE storefront_looks SET status = 'published', published_image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(first.url, lookId, orgId);
    return { ok: true };
  }

  /** Tira o look da vitrine (volta pra Aprovados, mantém as imagens geradas). */
  static unpublish(orgId: string, lookId: string): boolean {
    const r = db.prepare(`UPDATE storefront_looks SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status = 'published'`).run(lookId, orgId);
    return (r.changes || 0) > 0;
  }

  // ---- galeria pública (lookbook da vitrine) ----

  static publicLookbook(orgId: string): { id: string; title: string; image: string; images: string[]; items: { name: string; slug: string | null; price: number }[] }[] {
    const looks = db.prepare(
      `SELECT id, title, published_image_url FROM storefront_looks
       WHERE organization_id = ? AND status = 'published' AND published_image_url IS NOT NULL ORDER BY updated_at DESC`
    ).all(orgId) as any[];
    return looks.map((l) => {
      const images = (db.prepare(`SELECT url FROM storefront_look_images WHERE look_id = ? AND organization_id = ? ORDER BY position ASC`).all(l.id, orgId) as any[]).map((r) => r.url);
      const items = (db.prepare(
        `SELECT ps.name, ps.slug, ps.price FROM storefront_look_items sli JOIN products_services ps ON ps.id = sli.product_service_id
         WHERE sli.look_id = ? AND sli.organization_id = ? AND ps.active = 1 AND COALESCE(ps.storefront_visible,1) = 1 ORDER BY sli.position ASC`
      ).all(l.id, orgId) as any[]).map((r) => ({ name: r.name, slug: r.slug || null, price: r.price || 0 }));
      return { id: l.id, title: l.title || "Look", image: l.published_image_url, images: images.length ? images : [l.published_image_url], items };
    });
  }
}

// Handler da fila — registrado no load do módulo (importado pelas rotas no boot).
JobQueueService.registerHandler("storefront_look_image", async (p: any) => {
  await StorefrontLookGenerationService.processJob(p.lookId, p.orgId);
  return { processed: true };
});
