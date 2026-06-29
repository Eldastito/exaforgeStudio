import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { chat, describeImage, generateImageB64 } from "./llm.js";

// Mesmo diretório de mídia servido em /media (avatares, imagens de chat, etc.).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

function saveB64(b64: string, ext = "png"): string {
  const name = `studio_${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(b64, "base64"));
  return `/media/${name}`;
}

export interface BrandProfile {
  palette: string[];
  tone: string;
  style: string;
  summary: string;
}

export type StudioFormat = "post" | "story" | "banner";

/**
 * Estúdio de Criação: identidade visual da marca (extraída de posts de
 * referência) + geração de imagens de campanha guiadas por essa identidade e
 * pelos dados da empresa.
 */
export class StudioService {
  static getBrand(orgId: string): BrandProfile | null {
    const r = db.prepare(
      "SELECT palette, tone, style, summary FROM brand_profiles WHERE organization_id = ?"
    ).get(orgId) as any;
    if (!r) return null;
    let palette: string[] = [];
    try { palette = JSON.parse(r.palette || "[]"); } catch { /* noop */ }
    return { palette: Array.isArray(palette) ? palette : [], tone: r.tone || "", style: r.style || "", summary: r.summary || "" };
  }

  /** Analisa 1-5 posts de referência (base64) e extrai a identidade da marca. */
  static async analyzeBrand(orgId: string, images: { base64: string; mime?: string }[]): Promise<BrandProfile> {
    const sample = (images || []).filter(i => i && i.base64).slice(0, 5);
    const analyses: string[] = [];
    for (const img of sample) {
      try {
        const d = await describeImage(
          img.base64,
          img.mime || "image/jpeg",
          "Analise este post/imagem de uma marca. Descreva: cores predominantes (em HEX aproximado), o estilo visual e o tom de comunicação. Seja conciso."
        );
        if (d) analyses.push(d);
      } catch { /* ignora imagem com falha */ }
    }

    let profile: BrandProfile = { palette: [], tone: "", style: "", summary: "" };
    if (analyses.length) {
      const prompt = `Com base nestas análises de posts de uma marca, gere o PERFIL DE IDENTIDADE VISUAL em JSON:
{"palette": ["até 5 cores em HEX"], "tone": "tom de voz/comunicação", "style": "estilo visual (ex.: minimalista, colorido, elegante, sofisticado...)", "summary": "1-2 frases resumindo a identidade da marca"}
Análises dos posts:
${analyses.map((a, i) => `(${i + 1}) ${a}`).join("\n")}`;
      try {
        const raw = await chat(prompt, { temperature: 0.3, json: true });
        const p = JSON.parse(raw);
        profile = {
          palette: Array.isArray(p.palette) ? p.palette.slice(0, 5).map(String) : [],
          tone: String(p.tone || ""),
          style: String(p.style || ""),
          summary: String(p.summary || ""),
        };
      } catch { /* mantém perfil vazio se a síntese falhar */ }
    }

    db.prepare(
      `INSERT INTO brand_profiles (organization_id, palette, tone, style, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id) DO UPDATE SET
         palette = excluded.palette, tone = excluded.tone, style = excluded.style,
         summary = excluded.summary, updated_at = CURRENT_TIMESTAMP`
    ).run(orgId, JSON.stringify(profile.palette), profile.tone, profile.style, profile.summary);

    return profile;
  }

  /** Gera uma arte de campanha guiada pela identidade da marca + dados da empresa. */
  static async generate(orgId: string, briefing: string, format: StudioFormat = "post"): Promise<{ id: string; mediaUrl: string; prompt: string }> {
    const size = format === "story" ? "1024x1536" : format === "banner" ? "1536x1024" : "1024x1024";
    const biz = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const brand = this.getBrand(orgId);
    const brandLine = brand && (brand.palette.length || brand.style || brand.tone)
      ? `Identidade da marca — paleta: ${brand.palette.join(", ") || "n/d"}; estilo: ${brand.style || "n/d"}; tom: ${brand.tone || "n/d"}.`
      : "";
    const fullPrompt = `Arte de marketing para a empresa "${biz?.business_name || "a empresa"}". ${briefing}. ${brandLine} Design profissional, alta qualidade, adequado para redes sociais. Evite textos longos e qualquer palavra com erro de ortografia.`;

    const b64 = await generateImageB64(fullPrompt, size as any);
    if (!b64) throw new Error("A IA não retornou a imagem. Tente novamente.");
    const mediaUrl = saveB64(b64, "png");
    const id = randomUUID();
    db.prepare("INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url) VALUES (?, ?, 'image', ?, ?)")
      .run(id, orgId, briefing, mediaUrl);
    return { id, mediaUrl, prompt: briefing };
  }

  static listCreations(orgId: string, limit = 30): any[] {
    return db.prepare(
      "SELECT id, kind, prompt, media_url, created_at FROM studio_creations WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(orgId, limit) as any[];
  }
}
