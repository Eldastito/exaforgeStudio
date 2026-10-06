/**
 * ResultsStoryService (ADR-203 F2.5 / PRD Fase 2 §17-§19) — "Resultados" contado do todo para o detalhe:
 * CONCLUSÃO primeiro → rede → lojas (quem precisa de atenção no topo) → "Entender" (por que uma loja está assim).
 * COMPÕE, não recalcula (RN-F2-4): `RetailDayBriefService.nightSnapshot` (fechamentos já enviados: dia/semana/mês,
 * meta mensal), `SellerDiagnosisService` (fato × hipótese por vendedor), `ExecutionResultsService.results` (o que o
 * ZappFlow resolveu). Sem tabela, sem motor, sem flag nova.
 *
 * Regras:
 *  - Uma definição por indicador (RN-F2-5): venda/cota/atingimento SÃO os da noite (fechamento), nunca o parcial do PDV
 *    (esse é do "Hoje"). A tela diz "só fechamentos já enviados".
 *  - Zero ≠ desconhecido ≠ estimativa (RN-F2-6): `MetricText` carrega o estado; sem fechamento = "—", nunca "vendeu 0";
 *    loja sem venda OU sem cota conhecida vai para `no_data` — nunca vira "abaixo".
 *  - "Entender" separa FATO de HIPÓTESE (SellerDiagnosis) e nunca aponta culpa/causa comprovada.
 *  - Dinheiro role-gated (§73): só visão completa recebe o varejo; os demais recebem `restricted` + os resultados NÃO
 *    monetários do ledger. Escopo de loja (ADR-173) respeitado. Isolado por org.
 */
import db from "./db.js";
import { RetailDayBriefService, type Period } from "./RetailDayBriefService.js";
import { SellerDiagnosisService } from "./SellerDiagnosisService.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { ExecutionResultsService } from "./ExecutionResultsService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { todaySP } from "./spDate.js";
import { mt, type MetricText } from "./TodayCockpitService.js";
import type { Metric } from "../lib/metric.js";

export type StoreStatus = "below" | "no_data" | "hit";
export interface PeriodText { venda: MetricText; cota: MetricText; atingimento: MetricText }
export interface ResultsStore { storeId: string; name: string; status: StoreStatus; day: PeriodText; month: PeriodText }
export interface ResultsStory {
  date: string;
  restricted: boolean;                    // sem visão completa: sem números do varejo
  hasRetail: boolean;
  headline: string | null;                // a conclusão, primeiro
  headlineReason: string | null;          // por que não há conclusão
  basis: string;                          // "só fechamentos já enviados"
  network: { day: PeriodText; week: PeriodText; month: PeriodText; storesHit: number | null; storesBelow: number | null; storesNoData: number } | null;
  stores: ResultsStore[];
  solved: { categories: Record<string, any>; disclaimer: string; reading?: any } | null;   // o que o ZappFlow resolveu (ledger)
  generatedAt: string;
}
export interface TeamFinding { sellerId: string; name: string; salesDeltaPct: number | null; findings: Array<{ kind: "fact" | "hypothesis"; text: string }> }
export interface Understand {
  date: string; storeId: string; storeName: string; restricted: boolean;
  periods: { day: PeriodText; week: PeriodText; month: PeriodText } | null;
  team: TeamFinding[];                    // quem mais caiu (até 3), fato × hipótese
  notes: string[];                        // limites honestos
}

const pt = (p: { venda: Metric; cota: Metric; atingimento: Metric }): PeriodText => ({ venda: mt(p.venda), cota: mt(p.cota), atingimento: mt(p.atingimento) });
const yesterdaySP = (now: Date) => todaySP(new Date(now.getTime() - 86400000));
const validDate = (d: any) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

export class ResultsStoryService {
  static build(orgId: string, user: any, opts: { date?: string; now?: Date } = {}): ResultsStory {
    const now = opts.now || new Date();
    const date = validDate(opts.date) ? (opts.date as string) : yesterdaySP(now);
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const role = String(user?.role || ""), uid = String(user?.userId || user?.id || "");
    const nStores = Number((db.prepare(`SELECT COUNT(*) n FROM retail_stores WHERE organization_id = ? AND active = 1`).get(orgId) as any)?.n) || 0;
    const solved = this.solved(orgId, user);
    const base = { date, basis: "Só fechamentos já enviados — o parcial do dia fica no Hoje.", solved, generatedAt: now.toISOString() };

    if (!nStores) return { ...base, restricted: false, hasRetail: false, headline: null, headlineReason: "Esta empresa ainda não tem lojas cadastradas.", network: null, stores: [] };
    if (!full) return { ...base, restricted: true, hasRetail: true, headline: null, headlineReason: "Os números das lojas são do gestor.", network: null, stores: [] };

    const snap = RetailDayBriefService.nightSnapshot(orgId, date);
    const visible = snap.stores.filter((s) => RetailStoreScopeService.canAccessStore(orgId, uid, role, s.storeId));
    const stores: ResultsStore[] = visible.map((s) => {
      const known = s.venda.state === "value" && s.cota.state === "value" && Number(s.cota.value) > 0;
      const status: StoreStatus = !known ? "no_data" : Number(s.venda.value) >= Number(s.cota.value) ? "hit" : "below";
      return { storeId: s.storeId, name: s.storeName, status, day: pt(s), month: pt(s.month) };
    });
    const rank: Record<StoreStatus, number> = { below: 0, no_data: 1, hit: 2 };
    stores.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

    const n = snap.network;
    const scoped = visible.length === snap.stores.length;   // rede inteira só quando o usuário vê todas as lojas
    const network = scoped ? {
      day: pt(n), week: pt(n.week), month: pt(n.month),
      storesHit: n.storesHit, storesBelow: n.storesBelow, storesNoData: n.storesNoData,
    } : null;

    // CONCLUSÃO primeiro — derivada, nunca inventada.
    let headline: string | null = null, headlineReason: string | null = null;
    if (network && n.month.atingimento.state === "value") {
      headline = `No mês, a rede está em ${network.month.atingimento.text} da meta (${network.month.venda.text} de ${network.month.cota.text}).`;
      if (n.storesBelow !== null && n.storesBelow > 0) headline += ` ${n.storesBelow} ${n.storesBelow === 1 ? "loja ficou abaixo" : "lojas ficaram abaixo"} da meta em ${date.slice(8, 10)}/${date.slice(5, 7)}.`;
    } else if (!network) headlineReason = "Você vê só parte das lojas — a leitura da rede inteira é do gestor.";
    else headlineReason = "Ainda faltam fechamentos ou meta do mês para concluir como a rede está.";

    return { ...base, restricted: false, hasRetail: true, headline, headlineReason, network, stores };
  }

  /** "Entender" (§19): por que uma loja está assim. Fato × hipótese; nunca causa comprovada. */
  static understand(orgId: string, user: any, storeId: string, opts: { date?: string; now?: Date } = {}): Understand | null {
    const now = opts.now || new Date();
    const date = validDate(opts.date) ? (opts.date as string) : yesterdaySP(now);
    const store = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    const role = String(user?.role || ""), uid = String(user?.userId || user?.id || "");
    if (!store || !RetailStoreScopeService.canAccessStore(orgId, uid, role, storeId)) return null;
    const out: Understand = { date, storeId, storeName: store.name, restricted: false, periods: null, team: [], notes: [] };
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) { out.restricted = true; out.notes.push("Os números da loja são do gestor."); return out; }

    const row = RetailDayBriefService.nightSnapshot(orgId, date).stores.find((s) => s.storeId === storeId);
    if (!row) { out.notes.push("A loja não abre nesta data."); return out; }
    out.periods = { day: pt(row), week: pt(row.week), month: pt(row.month) };

    const drops: Array<TeamFinding & { delta: number }> = [];
    for (const s of RetailSellerIdentityService.rosterOn(orgId, storeId, date)) {
      const d = SellerDiagnosisService.diagnose(orgId, s.id, date, 30);
      if (!d.found || !d.enough || d.current?.sales == null || d.previous?.sales == null || d.previous.sales === 0) continue;
      const delta = d.current.sales - d.previous.sales;
      if (delta >= 0) continue;
      drops.push({ sellerId: s.id, name: s.name || `Matrícula ${s.matricula}`, salesDeltaPct: Math.round((delta / d.previous.sales) * 100), findings: d.findings, delta });
    }
    drops.sort((a, b) => a.delta - b.delta);
    out.team = drops.slice(0, 3).map(({ delta, ...rest }) => { void delta; return rest; });
    out.notes.push("Fato = número lido do sistema; hipótese = leitura possível dele, não causa comprovada.");
    if (!out.team.length) out.notes.push("Nenhuma pessoa da equipe com queda de vendas mensurável nos últimos 30 dias.");
    return out;
  }

  /** O que o ZappFlow resolveu — ledger por categoria; categorias em R$ vêm `restricted` sem visão completa. */
  private static solved(orgId: string, user: any): { categories: Record<string, any>; disclaimer: string; reading: any } | null {
    try { const r = ExecutionResultsService.results(orgId, user); return { categories: r.impact.categories, disclaimer: r.impact.disclaimer, reading: r.impactReading }; } catch { return null; }
  }
}

export default ResultsStoryService;
