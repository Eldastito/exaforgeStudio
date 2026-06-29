import db from "./db.js";
import { chat, describeImage } from "./llm.js";
import { StudioService, type BrandProfile } from "./StudioService.js";

const GRAPH = "https://graph.instagram.com/v21.0";

/**
 * Análise da conta de Instagram conectada (Instagram API with Instagram Login).
 * Com o escopo básico já dá para ler o feed (posts, legendas, curtidas,
 * comentários) — usamos isso para captar a identidade da marca e o que
 * performa. Insights de conta (alcance, etc.) exigem o escopo de insights +
 * App Review da Meta; tentamos e ignoramos se não estiver liberado.
 */
export class InstagramService {
  static getChannel(orgId: string): { token: string; igId: string; username: string } | null {
    const ch = db.prepare(
      "SELECT identifier, name, token_encrypted FROM channels WHERE provider = 'instagram' AND organization_id = ? AND status != 'disabled'"
    ).get(orgId) as any;
    if (!ch || !ch.token_encrypted) return null;
    const username = (ch.name || "").replace(/^Instagram\s*@?/i, "").trim();
    return { token: ch.token_encrypted, igId: ch.identifier, username };
  }

  static isConnected(orgId: string): boolean {
    return !!this.getChannel(orgId);
  }

  /** Posts recentes do feed (precisa só do escopo básico). */
  static async fetchMedia(orgId: string, limit = 24): Promise<any[]> {
    const ch = this.getChannel(orgId);
    if (!ch) return [];
    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
    const url = `${GRAPH}/me/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(ch.token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Instagram ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data: any = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  }

  /** Insights de conta (opcional — só com escopo de insights + App Review). */
  static async fetchAccountInsights(orgId: string): Promise<any | null> {
    const ch = this.getChannel(orgId);
    if (!ch) return null;
    try {
      const url = `${GRAPH}/${encodeURIComponent(ch.igId)}/insights?metric=reach,impressions,profile_views&period=days_28&access_token=${encodeURIComponent(ch.token)}`;
      const res = await fetch(url);
      if (!res.ok) return null; // sem escopo/app review: ignora
      const data: any = await res.json();
      const out: Record<string, number> = {};
      for (const m of (data?.data || [])) {
        const val = m?.total_value?.value ?? m?.values?.[m.values.length - 1]?.value;
        if (typeof val === "number") out[m.name] = val;
      }
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  private static async urlToB64(url: string): Promise<{ base64: string; mime: string } | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const mime = res.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await res.arrayBuffer());
      return { base64: buf.toString("base64"), mime };
    } catch { return null; }
  }

  /**
   * Analisa a conta: capta a IDENTIDADE (paleta/estilo/tom) dos posts que mais
   * performam e resume O QUE FUNCIONA. Salva a identidade no perfil da marca.
   */
  static async analyzeAccount(orgId: string): Promise<{ connected: boolean; username?: string; brand?: BrandProfile; performance?: string; top?: any[]; insights?: any }> {
    const ch = this.getChannel(orgId);
    if (!ch) return { connected: false };

    const media = await this.fetchMedia(orgId, 24);
    if (!media.length) return { connected: true, username: ch.username, performance: "Ainda não há posts no feed para analisar." };

    const eng = (m: any) => (m.like_count || 0) + (m.comments_count || 0);
    const top = [...media].sort((a, b) => eng(b) - eng(a)).slice(0, 6);

    // Visão nas imagens dos melhores posts (identidade visual).
    const analyses: string[] = [];
    for (const m of top.slice(0, 4)) {
      const imgUrl = m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url;
      if (!imgUrl) continue;
      const img = await this.urlToB64(imgUrl);
      if (!img) continue;
      try {
        const d = await describeImage(img.base64, img.mime, "Analise este post de uma marca: cores predominantes (HEX aproximado), estilo visual e tom. Seja conciso.");
        if (d) analyses.push(d);
      } catch { /* ignora */ }
    }

    const topCaptions = top.map(m => (m.caption || "").slice(0, 200)).filter(Boolean);
    const prompt = `Você analisa a conta de Instagram de uma marca. Com base nas análises visuais dos posts que MAIS engajaram e nas legendas, gere JSON:
{"palette": ["até 5 cores HEX"], "tone": "tom de comunicação", "style": "estilo visual", "summary": "1-2 frases sobre a identidade", "performance": "1-2 frases sobre O QUE MAIS FUNCIONA nesta conta (temas/formatos) para orientar próximas campanhas"}
Análises visuais dos top posts:
${analyses.map((a, i) => `(${i + 1}) ${a}`).join("\n") || "(sem imagens analisáveis)"}
Legendas dos top posts:
${topCaptions.map((c, i) => `(${i + 1}) ${c}`).join("\n") || "(sem legendas)"}`;

    let brand: BrandProfile = { palette: [], tone: "", style: "", summary: "" };
    let performance = "";
    try {
      const raw = await chat(prompt, { temperature: 0.3, json: true });
      const p = JSON.parse(raw);
      brand = {
        palette: Array.isArray(p.palette) ? p.palette.slice(0, 5).map(String) : [],
        tone: String(p.tone || ""), style: String(p.style || ""), summary: String(p.summary || ""),
      };
      performance = String(p.performance || "");
    } catch { /* mantém vazio */ }

    StudioService.saveBrand(orgId, brand);
    const insights = await this.fetchAccountInsights(orgId);

    return {
      connected: true,
      username: ch.username,
      brand,
      performance,
      top: top.map(m => ({ permalink: m.permalink, caption: (m.caption || "").slice(0, 120), likes: m.like_count || 0, comments: m.comments_count || 0, media_type: m.media_type })),
      insights,
    };
  }
}
