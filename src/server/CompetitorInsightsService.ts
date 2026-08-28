/**
 * CompetitorInsightsService — Closure Track B do PRD-PEL-01, fatia F4.
 *
 * Sem tabela nova: agrega dados de duas fontes já existentes:
 *   - StudioVisualRecipeService.usageStats — quantas artes a org já gerou
 *     por recipe (Track A F4).
 *   - CompetitorClassificationService.distributionForOrg — quantos posts
 *     de concorrentes foram classificados por recipe (Track B F3).
 *
 * Perguntas respondidas:
 *   1. Que recipes meus concorrentes usam MUITO mais que eu? (gaps)
 *   2. Como cada recipe se compara (own share × competitor share)?
 *   3. Que recipes estão em tendência de crescimento nos concorrentes?
 */
import { StudioVisualRecipeService } from "./StudioVisualRecipeService.js";
import { CompetitorClassificationService } from "./CompetitorClassificationService.js";

type UsageStatsResult = ReturnType<typeof StudioVisualRecipeService.usageStats>;
type DistributionResult = ReturnType<typeof CompetitorClassificationService.distributionForOrg>;

export interface RecipeComparison {
  recipe_key: string;
  name: string | null;
  own_uses: number;
  own_share: number;             // 0..1
  competitor_uses: number;
  competitor_share: number;      // 0..1
  delta_share: number;           // competitor_share - own_share (positivo = concorrentes usam mais)
}

export interface RecipeGap {
  recipe_key: string;
  name: string | null;
  competitor_uses: number;
  competitor_share: number;
}

export interface RecipeTrend {
  recipe_key: string;
  name: string | null;
  current_uses: number;
  previous_uses: number;
  current_share: number;
  previous_share: number;
  delta_share: number;           // current_share - previous_share
  direction: "up" | "down" | "flat";
}

function shareOf(uses: number, total: number): number {
  if (total <= 0) return 0;
  return uses / total;
}

function nameFromResults(
  own: UsageStatsResult, comp: DistributionResult, key: string,
): string | null {
  const inOwn = own.by_recipe.find(r => r.recipe_key === key)?.name || null;
  const inComp = comp.by_recipe.find(r => r.recipe_key === key)?.name || null;
  return inOwn || inComp;
}

export class CompetitorInsightsService {

  /**
   * Compara uso por recipe: quanto A ORG gerou × quanto os CONCORRENTES
   * usaram (classificação). Faz union das keys das duas fontes; recipes
   * exclusivos de um lado aparecem com uses=0 no outro.
   *
   * @param opts.platform  — filtro para competitor distribution
   * @param opts.since     — janela pras duas fontes
   */
  static compareRecipeUsage(orgId: string, opts: {
    platform?: string;
    since?: string | null;
  } = {}): {
    own_total: number;
    competitor_total: number;
    by_recipe: RecipeComparison[];
  } {
    if (!orgId) return { own_total: 0, competitor_total: 0, by_recipe: [] };

    const own = StudioVisualRecipeService.usageStats({ orgId, since: opts.since || undefined });
    const comp = CompetitorClassificationService.distributionForOrg(orgId, {
      platform: opts.platform, since: opts.since,
    });

    const keys = new Set<string>();
    for (const r of own.by_recipe) keys.add(r.recipe_key);
    for (const r of comp.by_recipe) keys.add(r.recipe_key);

    const rows: RecipeComparison[] = Array.from(keys).map(key => {
      const ownUses = own.by_recipe.find(r => r.recipe_key === key)?.uses || 0;
      const compUses = comp.by_recipe.find(r => r.recipe_key === key)?.uses || 0;
      const ownShare = shareOf(ownUses, own.total_uses);
      const compShare = shareOf(compUses, comp.total_classified);
      return {
        recipe_key: key,
        name: nameFromResults(own, comp, key),
        own_uses: ownUses,
        own_share: ownShare,
        competitor_uses: compUses,
        competitor_share: compShare,
        delta_share: compShare - ownShare,
      };
    });

    // Ordenação: delta_share DESC (maior gap primeiro), depois competitor_uses DESC
    rows.sort((a, b) => {
      if (b.delta_share !== a.delta_share) return b.delta_share - a.delta_share;
      if (b.competitor_uses !== a.competitor_uses) return b.competitor_uses - a.competitor_uses;
      return a.recipe_key.localeCompare(b.recipe_key);
    });

    return {
      own_total: own.total_uses,
      competitor_total: comp.total_classified,
      by_recipe: rows,
    };
  }

  /**
   * Recipes que os concorrentes usam ≥ minCompetitorUses vezes E que a
   * org ainda não usou (own_uses = 0). Ordenados por competitor_uses DESC.
   */
  static topGapsForOrg(orgId: string, opts: {
    platform?: string;
    since?: string | null;
    minCompetitorUses?: number;
  } = {}): RecipeGap[] {
    const cmp = this.compareRecipeUsage(orgId, { platform: opts.platform, since: opts.since });
    const minUses = Math.max(1, opts.minCompetitorUses || 1);
    return cmp.by_recipe
      .filter(r => r.own_uses === 0 && r.competitor_uses >= minUses)
      .map(r => ({
        recipe_key: r.recipe_key,
        name: r.name,
        competitor_uses: r.competitor_uses,
        competitor_share: r.competitor_share,
      }))
      .sort((a, b) => b.competitor_uses - a.competitor_uses || a.recipe_key.localeCompare(b.recipe_key));
  }

  /**
   * Recipes em tendência de crescimento no lado dos concorrentes.
   * Compara janela atual (`windowStart..now`) com janela anterior
   * (`previousStart..windowStart`).
   *
   * Cada janela é derivada de `sinceCurrent` e `windowDays`:
   *   - sinceCurrent = agora - windowDays (default 14 dias)
   *   - previousStart = sinceCurrent - windowDays
   *
   * Se ambas as janelas estão vazias, retorna [].
   */
  static trendingRecipes(orgId: string, opts: {
    platform?: string;
    windowDays?: number;
    now?: Date;                              // override pra testes
  } = {}): RecipeTrend[] {
    if (!orgId) return [];
    const windowDays = Math.max(1, opts.windowDays || 14);
    const now = opts.now || new Date();
    const currentStart = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
    const previousStart = new Date(currentStart.getTime() - windowDays * 24 * 3600 * 1000);

    const iso = (d: Date) => d.toISOString();

    // Janela atual: desde currentStart
    const current = CompetitorClassificationService.distributionForOrg(orgId, {
      platform: opts.platform, since: iso(currentStart),
    });
    // Total até previousStart = "todos até previousStart"; a distribuição do
    // service filtra por since (≥). Simular "janela anterior" chamando
    // distributionForOrg com since=previousStart, depois subtraindo o current.
    const sincePrev = CompetitorClassificationService.distributionForOrg(orgId, {
      platform: opts.platform, since: iso(previousStart),
    });

    // by_recipe da janela anterior = sincePrev - current
    const currentMap = new Map(current.by_recipe.map(r => [r.recipe_key, r.uses]));
    const previousMap = new Map<string, number>();
    for (const r of sincePrev.by_recipe) {
      const currUses = currentMap.get(r.recipe_key) || 0;
      const prevUses = r.uses - currUses;
      if (prevUses > 0) previousMap.set(r.recipe_key, prevUses);
    }

    const currentTotal = current.total_classified;
    const previousTotal = sincePrev.total_classified - currentTotal;

    if (currentTotal === 0 && previousTotal === 0) return [];

    // Enriquecimento de nome via distribution.by_recipe.name
    const nameMap = new Map<string, string | null>();
    for (const r of current.by_recipe) nameMap.set(r.recipe_key, r.name);
    for (const r of sincePrev.by_recipe) {
      if (!nameMap.has(r.recipe_key)) nameMap.set(r.recipe_key, r.name);
    }

    const keys = new Set<string>([...currentMap.keys(), ...previousMap.keys()]);
    const rows: RecipeTrend[] = Array.from(keys).map(key => {
      const currentUses = currentMap.get(key) || 0;
      const previousUses = previousMap.get(key) || 0;
      const currentShare = shareOf(currentUses, currentTotal);
      const previousShare = shareOf(previousUses, previousTotal);
      const deltaShare = currentShare - previousShare;
      const direction: "up" | "down" | "flat" =
        Math.abs(deltaShare) < 0.001 ? "flat" : (deltaShare > 0 ? "up" : "down");
      return {
        recipe_key: key,
        name: nameMap.get(key) || null,
        current_uses: currentUses,
        previous_uses: previousUses,
        current_share: currentShare,
        previous_share: previousShare,
        delta_share: deltaShare,
        direction,
      };
    });

    // Ordena por magnitude do delta (positivo primeiro)
    rows.sort((a, b) => b.delta_share - a.delta_share ||
                       b.current_uses - a.current_uses ||
                       a.recipe_key.localeCompare(b.recipe_key));
    return rows;
  }
}
