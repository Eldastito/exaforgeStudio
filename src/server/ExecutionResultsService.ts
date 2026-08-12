/**
 * ExecutionResultsService — PRD 6 / ADR-163 F8 (§45-49): as superfícies
 * "Executando" e "Resultados". É COMPOSIÇÃO pura (D1/CA17) — nenhum engine novo,
 * nenhuma tabela, nenhum alerta. Só LÊ o que a espinha já produziu e reagrupa
 * pro humano.
 *
 * "Executando" (§45-47): "o que o ZapFlow está fazendo agora?" → processos ATIVOS
 * do `ProcessRuntimeService` agrupados por OBJETIVO (o `correlation_id` da espinha
 * ADR-158), não por tipo técnico. O objetivo vem da decisão que abriu o fio
 * (`decision_actions.title`), ex.: "Recuperar carrinho". Estados no vocabulário
 * humano da F4 (`UxPresentationService.humanState`). Drill-down opcional pela
 * thread (`GET /api/falatu/thread/:correlationId`).
 *
 * "Resultados" (§48-49): "quanto o ZapFlow produziu?" → o `UnifiedImpactLedger`
 * (categorias NUNCA somadas entre si — R$ recuperado ≠ minutos economizados) +
 * distância à meta (`BusinessGoalService`). NUNCA tokens/custo de IA (§48/§50 —
 * essa fronteira é do Admin Master, não desta tela).
 *
 * Guardrails: escopo por papel (RN-UX-2 — `canSeeDomain`); DINHEIRO role-gated
 * (§73 — quem não tem visão completa vê que HÁ execução/impacto, não o valor);
 * derivado por query (RN-004); isolado por org.
 */
import db from "./db.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { UnifiedImpactLedgerService } from "./UnifiedImpactLedgerService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { UxPresentationService } from "./UxPresentationService.js";
import { OutcomeAssuranceService } from "./OutcomeAssuranceService.js";

const PROC_ACTIVE = new Set(["planned", "authorized", "queued", "executing", "waiting_external_response"]);
const MONEY_UNITS = new Set(["BRL", "R$", "brl"]);

interface ExecObjective {
  key: string; correlationId: string | null; objective: string; domain: string | null;
  impact: { amount: number | null; unit: string | null; restricted: boolean };
  count: number;
  states: Array<{ key: string; label: string; tone: string; count: number }>;
  processes: Array<{ id: string; processType: string; status: string; state: string; startedAt: string | null; riskLevel: string | null }>;
  // ADR-165 F9 — garantia do objetivo: `assured` (efeito confirmado E impacto medido) vs
  // só `executed`/`planned` (DONE ≠ RESULTADO). NÃO é dinheiro — o FATO da garantia é
  // sempre visível (RN-OA-2/§73); só o valor em R$ é role-gated (campo `impact`).
  assurance: { state: string; hasGaps: boolean; gaps: string[] } | null;
  drillDown: string | null;
}

export class ExecutionResultsService {
  /** §45-47 — processos ativos agrupados por objetivo (correlation_id), role-scoped. */
  static executing(orgId: string, user: any): { total: number; groups: ExecObjective[]; generatedAt: string } {
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const active = ProcessRuntimeService.listInstances(orgId, { limit: 300 }).filter((p) => PROC_ACTIVE.has(p.status));
    const groups = new Map<string, ExecObjective>();
    let total = 0;

    for (const p of active) {
      const cid: string | null = p.correlation_id || null;
      const obj = cid ? this.resolveObjective(orgId, cid) : null;
      const domain = obj?.domain || null;
      // Escopo por papel: objetivo com domínio sensível invisível ao usuário é ocultado.
      if (!ContextProjectionService.canSeeDomain(orgId, user, domain)) continue;
      total++;

      const key = cid || `proc:${p.id}`;
      if (!groups.has(key)) {
        const rawAmount = obj?.expected_impact ?? (p.expected_value ?? null);
        const hasImpact = rawAmount != null;
        const unit = obj?.impact_unit || (p.expected_value != null ? "BRL" : null);
        // Dinheiro role-gated (§73): o FATO da execução nunca some; só o valor.
        const impact = hasImpact
          ? (full ? { amount: Number(rawAmount), unit: unit || "BRL", restricted: false }
                  : { amount: null, unit: unit || "BRL", restricted: true })
          : { amount: null, unit: null, restricted: false };
        // Garantia derivada do fio (F1) — read-only, sempre visível (não é dinheiro).
        let assurance: { state: string; hasGaps: boolean; gaps: string[] } | null = null;
        if (cid) {
          const a = OutcomeAssuranceService.assessCorrelation(orgId, cid);
          if (a.actionCount > 0) assurance = { state: a.overall, hasGaps: a.gaps.length > 0, gaps: a.gaps };
        }
        groups.set(key, {
          key, correlationId: cid,
          objective: obj?.title || this.humanizeType(p.process_type),
          domain, impact, count: 0, states: [], processes: [], assurance,
          drillDown: cid ? `/api/falatu/thread/${cid}` : null,
        });
      }
      const g = groups.get(key)!;
      const st = UxPresentationService.humanState(p.status);
      g.count++;
      g.processes.push({ id: p.id, processType: p.process_type, status: p.status, state: st.label, startedAt: p.started_at ?? null, riskLevel: p.risk_level ?? null });
      const bucket = g.states.find((s) => s.key === st.key);
      if (bucket) bucket.count++;
      else g.states.push({ key: st.key, label: st.label, tone: st.tone, count: 1 });
    }

    // Objetivo com mais processos (ou maior urgência) primeiro.
    const list = [...groups.values()].sort((a, b) => b.count - a.count);
    return { total, groups: list, generatedAt: new Date().toISOString() };
  }

  /**
   * §48-49 — "Resultados": o Impact Ledger unificado (categorias separadas) +
   * distância à meta. Dinheiro role-gated (§73); nunca custo/tokens (§48/§50).
   */
  static results(orgId: string, user: any): {
    fullVisibility: boolean;
    impact: { categories: Record<string, any>; sources: string[]; disclaimer: string };
    goals: { total: number; offTrack: number; items: any[] } | null;
    generatedAt: string;
  } {
    const full = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const ledger = UnifiedImpactLedgerService.build(orgId);

    // Projeção por papel: categorias em dinheiro têm o total reservado ao gestor
    // (§73). Categorias não-monetárias (minutos economizados) seguem visíveis —
    // simplicidade não mente (RN-UX-4): mostra que HÁ resultado, marca `restricted`.
    const categories: Record<string, any> = {};
    for (const [name, cat] of Object.entries(ledger.categories)) {
      const isMoney = MONEY_UNITS.has(cat.unit);
      if (isMoney && !full) {
        categories[name] = { unit: cat.unit, total: null, restricted: true, lineCount: cat.lines.length };
      } else {
        categories[name] = { unit: cat.unit, total: cat.total, restricted: false, lines: cat.lines };
      }
    }

    // Metas só pra gestor (visão completa), mesmo critério da Home (F3).
    let goals: { total: number; offTrack: number; items: any[] } | null = null;
    if (full) {
      const p = BusinessGoalService.progress(orgId);
      goals = {
        total: p.goals.length,
        offTrack: p.goals.filter((g: any) => g.paceStatus === "behind").length,
        items: p.goals.slice(0, 5).map((g: any) => ({ metric: g.metric, label: g.label, attainmentPct: g.attainmentPct, paceStatus: g.paceStatus })),
      };
    }

    return {
      fullVisibility: full,
      impact: { categories, sources: ledger.sources, disclaimer: ledger.disclaimer },
      goals,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Resolve o objetivo do fio: a decisão que o abriu (título/impacto/domínio). */
  private static resolveObjective(orgId: string, correlationId: string): { title: string; expected_impact: number | null; impact_unit: string | null; domain: string | null } | null {
    const a = db.prepare(
      `SELECT title, expected_impact, impact_unit, domain FROM decision_actions
        WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, correlationId) as any;
    if (a) return { title: a.title, expected_impact: a.expected_impact ?? null, impact_unit: a.impact_unit ?? null, domain: a.domain ?? null };
    // Sem decisão? Herda o domínio do sinal de origem (pra não vazar no role-scope).
    const s = db.prepare(`SELECT domain FROM business_signals WHERE organization_id = ? AND correlation_id = ? LIMIT 1`).get(orgId, correlationId) as any;
    return s ? { title: "", expected_impact: null, impact_unit: null, domain: s.domain ?? null } : null;
  }

  /** process_type técnico → rótulo legível quando não há objetivo nomeado. */
  private static humanizeType(t: string | null | undefined): string {
    if (!t) return "Processo";
    return String(t).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export default ExecutionResultsService;
