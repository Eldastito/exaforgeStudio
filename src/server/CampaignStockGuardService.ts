import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { StorefrontStockService } from "./StorefrontStockService.js";

/**
 * CampaignStockGuardService (ADR-207 F12) — estoque ↔ campanha: não atrair cliente para uma peça que a operação não consegue entregar.
 *
 * O PRD pede duas coisas: (1) NÃO promover antes de criar (a regra vive em `ProductOpportunityService.candidates`, que passa a exigir
 * saldo vendável confortável) e (2) vigiar DURANTE a campanha — quando o saldo cai, avisar para reduzir exposição / parar / trocar de peça.
 * Esta classe cuida da (2) e centraliza a régua de saldo.
 *
 * Regras:
 *  - Saldo = o MESMO `StorefrontStockService.sellable` que a vitrine usa para mostrar "esgotado" (disponível − reservado, estoque próprio +
 *    por loja). Nenhuma conta de estoque nova (sem 2ª fonte de verdade).
 *  - Produto SEM controle de estoque não tem "esgotado": estado `unknown`, nunca bloqueia nem alerta (null ≠ zero).
 *  - "Em campanha" = produto de um link curto ATIVO (F5) ou de um post do Instagram ligado pelo dono (F9a). Não adivinhamos campanha por palpite.
 *  - O aviso mora em `business_signals` (convenção nº 12), um por produto, que muda de "baixo" para "esgotado" e se resolve sozinho quando
 *    o saldo volta. Sinal sem dinheiro (só unidades). Nada é pausado/alterado: o sistema AVISA e o dono decide (a vitrine já marca esgotado
 *    sozinha; link curto e anúncio não são mexidos — recomendação ≠ execução).
 *  - Limiar de "baixo" é uma constante conservadora e NÃO calibrada com dado real (declarado no ADR).
 */
export const LOW_STOCK_UNITS = 5;
export type StockState = "ok" | "low" | "out" | "unknown";

const key = (productId: string) => `campaign.stock|${productId}`;

export class CampaignStockGuardService {
  /** Estado do saldo vendável de um produto (mesma régua da vitrine). */
  static status(orgId: string, productId: string): { productId: string; name: string | null; controlled: boolean; units: number | null; state: StockState } | null {
    const p = db.prepare("SELECT id, name, stock_control_enabled FROM products_services WHERE id = ? AND organization_id = ?").get(productId, orgId) as any;
    if (!p) return null;
    if (!p.stock_control_enabled) return { productId: p.id, name: p.name, controlled: false, units: null, state: "unknown" };
    const units = Math.trunc(StorefrontStockService.sellable(p.id));
    const state: StockState = units <= 0 ? "out" : units <= LOW_STOCK_UNITS ? "low" : "ok";
    return { productId: p.id, name: p.name, controlled: true, units: Math.max(0, units), state };
  }

  /** Produtos hoje "em campanha": link curto ativo com produto (F5) ou post do Instagram ligado a produto (F9a). */
  static watched(orgId: string): Array<{ productId: string; sources: Array<"short_link" | "instagram_post"> }> {
    const by = new Map<string, Set<"short_link" | "instagram_post">>();
    const add = (pid: string | null, src: "short_link" | "instagram_post") => { if (!pid) return; (by.get(pid) || by.set(pid, new Set()).get(pid)!).add(src); };
    for (const r of db.prepare("SELECT DISTINCT product_id FROM storefront_short_links WHERE organization_id = ? AND active = 1 AND product_id IS NOT NULL").all(orgId) as any[]) add(r.product_id, "short_link");
    for (const r of db.prepare("SELECT DISTINCT product_id FROM instagram_media_products WHERE organization_id = ?").all(orgId) as any[]) add(r.product_id, "instagram_post");
    return [...by.entries()].map(([productId, s]) => ({ productId, sources: [...s] }));
  }

  /** Foto atual: produtos em campanha com o estado do saldo (read-only). Ordena do mais crítico. */
  static overview(orgId: string) {
    const rank: Record<StockState, number> = { out: 0, low: 1, ok: 2, unknown: 3 };
    const items = this.watched(orgId).map((w) => {
      const s = this.status(orgId, w.productId);
      return s ? { ...s, sources: w.sources } : null;
    }).filter(Boolean) as any[];
    items.sort((a, b) => rank[a.state as StockState] - rank[b.state as StockState]);
    return {
      lowThreshold: LOW_STOCK_UNITS, items,
      note: "Saldo vendável = o mesmo da vitrine (disponível − reservado). Produto sem controle de estoque não entra no alerta. O sistema avisa; pausar anúncio ou trocar a peça é decisão sua.",
    };
  }

  /** Publica/atualiza/resolve os avisos de estoque dos produtos em campanha. Idempotente, isolado por org, nunca lança. */
  static scan(orgId: string): { checked: number; low: number; out: number; resolved: number } {
    const res = { checked: 0, low: 0, out: 0, resolved: 0 };
    let watched: ReturnType<typeof CampaignStockGuardService.watched> = [];
    try { watched = this.watched(orgId); } catch { return res; }
    const watchedIds = new Set(watched.map((w) => w.productId));
    for (const w of watched) {
      try {
        res.checked++;
        const s = this.status(orgId, w.productId);
        if (!s || s.state === "ok" || s.state === "unknown") {
          if (BusinessSignalService.resolveByDedupe(orgId, key(w.productId)).ok) res.resolved++;
          continue;
        }
        if (s.state === "out") res.out++; else res.low++;
        BusinessSignalService.reopenByDedupe(orgId, key(w.productId), { onlyAutoResolved: true });
        BusinessSignalService.publish(orgId, {
          domain: "retail_online", signalType: s.state === "out" ? "campaign_stock_out" : "campaign_stock_low",
          severity: s.state === "out" ? "risk" : "attention", basis: "fact", confidence: 1,
          sourceService: "CampaignStockGuardService", sourceEntityType: "product", sourceEntityId: s.productId,
          subjectType: "product", subjectId: s.productId,
          evidence: {
            productId: s.productId, product: s.name, units: s.units, state: s.state, sources: w.sources,
            note: s.state === "out"
              ? "Esgotado e ainda em campanha: pare de impulsionar este produto e não publique mais conteúdo dele (a vitrine já mostra esgotado). Considere oferecer outra peça."
              : `Restam ${s.units} unidade(s) e o produto está em campanha: reduza a exposição ou prepare outra peça.`,
          },
          dedupeKey: key(s.productId),
        } as any);
      } catch { /* o aviso é best-effort: um produto com problema não derruba os demais */ }
    }
    // Produto que saiu de campanha (link arquivado/post desligado): o aviso não vale mais.
    try {
      for (const r of db.prepare("SELECT dedupe_key FROM business_signals WHERE organization_id = ? AND status = 'open' AND dedupe_key LIKE 'campaign.stock|%'").all(orgId) as any[]) {
        const pid = String(r.dedupe_key).slice("campaign.stock|".length);
        if (!watchedIds.has(pid) && BusinessSignalService.resolveByDedupe(orgId, r.dedupe_key).ok) res.resolved++;
      }
    } catch { /* noop */ }
    return res;
  }

  /** Avisos de estoque ABERTOS (para a tela do Motor de Crescimento). Só unidades, nunca dinheiro. */
  static alerts(orgId: string): Array<{ productId: string; product: string | null; units: number | null; state: string; note: string | null }> {
    return (db.prepare("SELECT evidence_json FROM business_signals WHERE organization_id = ? AND status = 'open' AND dedupe_key LIKE 'campaign.stock|%' ORDER BY severity DESC, detected_at DESC LIMIT 20").all(orgId) as any[])
      .map((r) => { let ev: any = {}; try { ev = JSON.parse(r.evidence_json || "{}"); } catch { /* noop */ } return ev; })
      .map((ev) => ({ productId: ev.productId ?? "", product: ev.product ?? null, units: ev.units ?? null, state: ev.state ?? "low", note: ev.note ?? null }));
  }

  /** Passe do Scheduler: vigia as orgs que têm link curto ativo ou post ligado a produto. */
  static pass(): void {
    let orgs: string[] = [];
    try {
      orgs = [...new Set([
        ...(db.prepare("SELECT DISTINCT organization_id o FROM storefront_short_links WHERE active = 1 AND product_id IS NOT NULL").all() as any[]).map((r) => r.o),
        ...(db.prepare("SELECT DISTINCT organization_id o FROM instagram_media_products").all() as any[]).map((r) => r.o),
        // orgs com aviso aberto também entram, para o aviso se resolver quando o produto sair de campanha
        ...(db.prepare("SELECT DISTINCT organization_id o FROM business_signals WHERE status = 'open' AND dedupe_key LIKE 'campaign.stock|%'").all() as any[]).map((r) => r.o),
      ])];
    } catch { return; }
    for (const o of orgs) {
      try { this.scan(o); } catch (e: any) { console.error(`[CampaignStockGuard] pass falhou (org ${o})`, e?.message || e); }
    }
  }
}

export default CampaignStockGuardService;
