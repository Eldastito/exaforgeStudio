/**
 * CompetitorClassificationService — Closure Track B do PRD-PEL-01, fatia F3.
 *
 * Classifica posts de concorrentes por recipe do VRE (Track A). Cada post
 * pode acumular várias classificações ao longo do tempo (histórico permitido);
 * a "atual" é sempre a de maior classified_at.
 *
 * Integra com StudioVisualRecipeService.suggestForBriefing (F3.5), que já
 * cobre LLM classifier + fallback keyword + normalização de acentos.
 *
 * Regras (RN-CI-10..13):
 *   10. Isolamento multi-tenant: acesso via chain post → competitor → org.
 *   11. Classificação SEM caption cai direto no fallback (via suggest).
 *   12. Reclassificar é permitido — cria linha nova, não substitui.
 *   13. Cascade automático quando post é deletado (FK ON DELETE CASCADE),
 *       ainda que foreign_keys=OFF: cascade manual no deletePost/cascade
 *       manual em deleteAllForCompetitor.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { StudioVisualRecipeService, SupportedFormat } from "./StudioVisualRecipeService.js";
import { CompetitorPost, CompetitorPostsService } from "./CompetitorPostsService.js";

export interface ClassificationRow {
  id: string;
  post_id: string;
  recipe_key: string | null;
  recipe_version: number | null;
  confidence: number | null;
  method: string;
  reasoning: string | null;
  classified_at: string;
}

export interface Classification {
  id: string;
  post_id: string;
  recipe_key: string | null;
  recipe_version: number | null;
  confidence: number | null;
  method: "llm" | "fallback_keyword" | "manual";
  reasoning: string | null;
  classified_at: string;
}

export interface ClassificationWithPost extends Classification {
  post_caption: string | null;
  post_url: string | null;
  competitor_platform: string;
  competitor_handle: string;
}

export class ClassificationError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg); this.code = code; this.name = "ClassificationError";
  }
}

function rowToClassification(r: ClassificationRow): Classification {
  const validMethods = ["llm", "fallback_keyword", "manual"] as const;
  const method = (validMethods as readonly string[]).includes(r.method)
    ? r.method as typeof validMethods[number]
    : "fallback_keyword";
  return {
    id: r.id,
    post_id: r.post_id,
    recipe_key: r.recipe_key,
    recipe_version: r.recipe_version,
    confidence: r.confidence,
    method,
    reasoning: r.reasoning,
    classified_at: r.classified_at,
  };
}

function verifyPostOwnership(orgId: string, postId: string): CompetitorPost | null {
  return CompetitorPostsService.getPost(orgId, postId);
}

export class CompetitorClassificationService {

  /**
   * Classifica 1 post via suggestForBriefing do VRE. Grava linha nova
   * em competitor_post_classifications (histórico preservado).
   *
   * @throws ClassificationError('post_not_found') se post não pertence à org.
   */
  static async classifyPost(input: {
    orgId: string;
    postId: string;
    format?: SupportedFormat | null;
  }): Promise<Classification> {
    if (!input.orgId) throw new ClassificationError("missing_org", "orgId é obrigatório");
    if (!input.postId) throw new ClassificationError("missing_post", "postId é obrigatório");

    const post = verifyPostOwnership(input.orgId, input.postId);
    if (!post) {
      throw new ClassificationError("post_not_found",
        "post não encontrado ou não pertence à sua organização");
    }

    // Sem caption → briefing sintético a partir do handle+platform pra evitar
    // missing_briefing do suggest. Nesses casos o fallback keyword provavelmente
    // resulta em confidence baixa, o que é a resposta correta.
    let briefing = (post.caption || "").trim();
    if (!briefing) briefing = `${post.kind} sem caption`;

    const suggestion = await StudioVisualRecipeService.suggestForBriefing({
      briefing,
      format: input.format || null,
    });

    return this.saveClassification(input.postId, {
      recipe_key: suggestion.suggestion?.recipe_key || null,
      recipe_version: null,          // suggest não expõe version; buscar via get() se precisar
      confidence: suggestion.suggestion?.confidence ?? null,
      method: suggestion.method,
      reasoning: suggestion.suggestion?.reasoning || null,
    });
  }

  /**
   * Uso interno: grava uma linha de classificação. Retorna a Classification
   * criada. Também usado por classifyManual pra permitir override humano.
   */
  private static saveClassification(postId: string, data: {
    recipe_key: string | null;
    recipe_version: number | null;
    confidence: number | null;
    method: string;
    reasoning: string | null;
  }): Classification {
    const id = uuidv4();
    // Se o recipe_key foi resolvido, tenta enriquecer com recipe_version pra
    // guardar a versão vigente da recipe naquele momento (útil pra auditoria).
    let version = data.recipe_version;
    if (data.recipe_key && version == null) {
      const recipe = StudioVisualRecipeService.get(data.recipe_key);
      version = recipe?.version ?? null;
    }
    db.prepare(
      `INSERT INTO competitor_post_classifications
       (id, post_id, recipe_key, recipe_version, confidence, method, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, postId,
      data.recipe_key,
      version,
      data.confidence,
      data.method,
      data.reasoning,
    );
    return rowToClassification(db.prepare(
      "SELECT * FROM competitor_post_classifications WHERE id = ?"
    ).get(id) as ClassificationRow);
  }

  /**
   * Classifica manualmente (humano override). Requer ownership. Grava
   * método='manual'.
   */
  static classifyManual(input: {
    orgId: string;
    postId: string;
    recipe_key: string;
    reasoning?: string;
    confidence?: number;
  }): Classification {
    if (!input.orgId) throw new ClassificationError("missing_org", "orgId é obrigatório");
    if (!input.postId) throw new ClassificationError("missing_post", "postId é obrigatório");
    if (!input.recipe_key) throw new ClassificationError("missing_recipe", "recipe_key é obrigatório");

    const post = verifyPostOwnership(input.orgId, input.postId);
    if (!post) {
      throw new ClassificationError("post_not_found",
        "post não encontrado ou não pertence à sua organização");
    }

    const recipe = StudioVisualRecipeService.get(input.recipe_key);
    if (!recipe) {
      throw new ClassificationError("recipe_not_found",
        `recipe não encontrada: ${input.recipe_key}`);
    }

    return this.saveClassification(input.postId, {
      recipe_key: recipe.key,
      recipe_version: recipe.version,
      confidence: typeof input.confidence === "number"
        ? Math.max(0, Math.min(1, input.confidence)) : 1.0,
      method: "manual",
      reasoning: input.reasoning || "Classificação manual",
    });
  }

  /**
   * Classifica em lote todos os posts do competitor que ainda não têm
   * classificação (ou reclassifica todos se `reclassifyAll=true`).
   *
   * Retorna { classified: N, skipped: M } — skipped são posts que já tinham
   * classificação quando reclassifyAll=false.
   */
  static async classifyBatchForCompetitor(input: {
    orgId: string;
    competitorId: string;
    limit?: number;
    reclassifyAll?: boolean;
    format?: SupportedFormat | null;
  }): Promise<{ classified: number; skipped: number; errors: number }> {
    if (!input.orgId) throw new ClassificationError("missing_org", "orgId é obrigatório");
    if (!input.competitorId) throw new ClassificationError("missing_competitor", "competitorId é obrigatório");

    const posts = CompetitorPostsService.listPostsForCompetitor(
      input.orgId, input.competitorId, { limit: input.limit || 100 });

    let classified = 0;
    let skipped = 0;
    let errors = 0;

    for (const p of posts) {
      if (!input.reclassifyAll) {
        const existing = this.getLatestClassificationInternal(p.id);
        if (existing) { skipped++; continue; }
      }
      try {
        await this.classifyPost({ orgId: input.orgId, postId: p.id, format: input.format });
        classified++;
      } catch {
        errors++;
      }
    }
    return { classified, skipped, errors };
  }

  /** Retorna a classificação mais recente de um post (verificando ownership). */
  static getLatestClassification(orgId: string, postId: string): Classification | null {
    if (!verifyPostOwnership(orgId, postId)) return null;
    return this.getLatestClassificationInternal(postId);
  }

  private static getLatestClassificationInternal(postId: string): Classification | null {
    const row = db.prepare(
      `SELECT * FROM competitor_post_classifications
        WHERE post_id = ?
        ORDER BY classified_at DESC, rowid DESC
        LIMIT 1`
    ).get(postId) as ClassificationRow | undefined;
    return row ? rowToClassification(row) : null;
  }

  /**
   * Lista TODAS as classificações de um post (histórico), mais recentes
   * primeiro. Vazio se post não é da org.
   */
  static listClassificationsForPost(orgId: string, postId: string): Classification[] {
    if (!verifyPostOwnership(orgId, postId)) return [];
    const rows = db.prepare(
      `SELECT * FROM competitor_post_classifications
        WHERE post_id = ?
        ORDER BY classified_at DESC, rowid DESC`
    ).all(postId) as ClassificationRow[];
    return rows.map(rowToClassification);
  }

  /**
   * Distribuição de recipes usados pelos concorrentes da org. Considera só
   * a classificação MAIS RECENTE de cada post. Filtros opcionais: platform,
   * competitorId (dentro da org), since (classified_at ≥ since).
   *
   * Retorno: { total_classified, by_recipe: [{recipe_key, name|null, uses}] }
   */
  static distributionForOrg(orgId: string, opts: {
    platform?: string;
    competitorId?: string;
    since?: string | null;
  } = {}): {
    total_classified: number;
    by_recipe: Array<{ recipe_key: string; name: string | null; uses: number }>;
  } {
    if (!orgId) return { total_classified: 0, by_recipe: [] };

    // Estratégia: subquery com ROW_NUMBER por post ordenado por classified_at
    // DESC + rowid DESC. SQLite tem window functions desde 3.25.
    // Pegamos rn=1 (última classificação de cada post).
    const wheres: string[] = ["c.organization_id = ?"];
    const params: any[] = [orgId];
    if (opts.platform) { wheres.push("c.platform = ?"); params.push(opts.platform); }
    if (opts.competitorId) { wheres.push("c.id = ?"); params.push(opts.competitorId); }
    if (opts.since) { wheres.push("cls.classified_at >= ?"); params.push(opts.since); }

    const rows = db.prepare(`
      WITH latest AS (
        SELECT cls.*,
               ROW_NUMBER() OVER (PARTITION BY cls.post_id
                                  ORDER BY cls.classified_at DESC, cls.rowid DESC) AS rn
          FROM competitor_post_classifications cls
      )
      SELECT latest.recipe_key AS recipe_key, COUNT(*) AS uses
        FROM latest
        JOIN competitor_posts p ON p.id = latest.post_id
        JOIN competitor_accounts c ON c.id = p.competitor_id
       WHERE latest.rn = 1
         AND latest.recipe_key IS NOT NULL
         AND ${wheres.join(" AND ")}
       GROUP BY latest.recipe_key
       ORDER BY uses DESC, recipe_key
    `).all(...params) as Array<{ recipe_key: string; uses: number }>;

    // Enriquece com nome
    const catalog = new Map<string, string>();
    const recipesRows = db.prepare(
      "SELECT recipe_key, name FROM studio_visual_recipes WHERE active = 1"
    ).all() as Array<{ recipe_key: string; name: string }>;
    for (const r of recipesRows) catalog.set(r.recipe_key, r.name);

    const by_recipe = rows.map(r => ({
      recipe_key: r.recipe_key,
      name: catalog.get(r.recipe_key) ?? null,
      uses: r.uses,
    }));
    const total_classified = by_recipe.reduce((acc, r) => acc + r.uses, 0);
    return { total_classified, by_recipe };
  }

  /**
   * Feed de posts anotados com sua classificação atual. Útil pra UI listar
   * "10 posts recentes dos concorrentes" com o recipe correspondente ao lado.
   */
  static listRecentClassifiedPostsForOrg(orgId: string, opts: {
    limit?: number;
    platform?: string;
    recipeKey?: string;
  } = {}): ClassificationWithPost[] {
    if (!orgId) return [];
    const limit = Math.min(Math.max(opts.limit || 50, 1), 500);

    const wheres: string[] = ["c.organization_id = ?", "c.active = 1", "latest.rn = 1"];
    const params: any[] = [orgId];
    if (opts.platform) { wheres.push("c.platform = ?"); params.push(opts.platform); }
    if (opts.recipeKey) { wheres.push("latest.recipe_key = ?"); params.push(opts.recipeKey); }

    const rows = db.prepare(`
      WITH latest AS (
        SELECT cls.*,
               ROW_NUMBER() OVER (PARTITION BY cls.post_id
                                  ORDER BY cls.classified_at DESC, cls.rowid DESC) AS rn
          FROM competitor_post_classifications cls
      )
      SELECT latest.id AS id, latest.post_id AS post_id, latest.recipe_key AS recipe_key,
             latest.recipe_version AS recipe_version, latest.confidence AS confidence,
             latest.method AS method, latest.reasoning AS reasoning,
             latest.classified_at AS classified_at,
             p.caption AS post_caption, p.url AS post_url,
             c.platform AS competitor_platform, c.handle AS competitor_handle
        FROM latest
        JOIN competitor_posts p ON p.id = latest.post_id
        JOIN competitor_accounts c ON c.id = p.competitor_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY latest.classified_at DESC
       LIMIT ?
    `).all(...params, limit) as Array<ClassificationRow & {
      post_caption: string | null;
      post_url: string | null;
      competitor_platform: string;
      competitor_handle: string;
    }>;

    return rows.map(r => ({
      ...rowToClassification(r),
      post_caption: r.post_caption,
      post_url: r.post_url,
      competitor_platform: r.competitor_platform,
      competitor_handle: r.competitor_handle,
    }));
  }
}
