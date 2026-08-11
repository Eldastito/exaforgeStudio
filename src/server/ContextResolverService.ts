import db from "./db.js";
import {
  ContextRequest,
  ContextPacket,
  ContextScope,
  ContextFact,
  ContextMoment,
  ContextQuality,
  SkillHint,
  makeScope,
  scopeRef,
  resolveBudget,
  factFromSignal,
  clampConfidence,
  CONTEXT_PACKET_SCHEMA_VERSION,
} from "./contextModel.js";
import type { ContextConstraint } from "./contextModel.js";
import { ContextGraphService } from "./ContextGraphService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { BusinessConstraintService } from "./BusinessConstraintService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ContextQualityService } from "./ContextQualityService.js";

/**
 * ContextResolverService — PRD 3 F3 (§18/§19/§20/§6/§73): o CORAÇÃO do Business
 * Context Engine. Recebe um `ContextRequest` (intent + escopo + orçamento) e monta
 * um `ContextPacket` MÍNIMO E RELEVANTE (§6 Progressive Disclosure) — não o
 * panorama inteiro. É COMPOSIÇÃO pura sobre serviços que já existem; a "cola" é
 * nova, o conteúdo é reúso (a auditoria da Fase 0 mostrou ~80% já pronto):
 *
 *   momento   ← `BusinessSignalService.attention`          (§17 Business Moment)
 *   fatos     ← `business_signals` traduzidos por `factFromSignal` (F1, §11/§26)
 *   grafo     ← `ContextGraphService.build`                (F2 — vizinhança da âncora)
 *   metas     ← `BusinessGoalService.progress`             (§9/§14 distância à meta)
 *   pistas    ← `ImpactPrioritizationService.prioritize`   (§21 recommendedActionType)
 *   qualidade ← `BusinessHealthService.dataQuality`        (§75 cobertura + lacunas)
 *
 * O `ContextPacket` é a INTERFACE que o PRD 4 (SkillOS) consome (AC-A05/§127).
 *
 * GUARDRAILS (duros, testados):
 *   - RN-CR-1 READ + DERIVE, nunca EXECUTE (AC-A02/§90): só leitura/derivação.
 *     A SÍNTESE é advisória — o gate real segue no RBAC/ApprovalPolicy (RN §35).
 *   - RN-CR-2 NÃO INVENTAR (§25): sem sinal → `facts:[]`; sem âncora que resolva →
 *     grafo do esqueleto da org; dado ausente vira LACUNA na qualidade, nunca um
 *     valor fabricado. `skillHints` são PISTAS (não selecionam/executam skill).
 *   - RN-CR-3 ISOLAMENTO (§66): `orgId` 1º arg; toda leitura herda o filtro
 *     `organization_id` dos serviços compostos (todos já isolam).
 *   - RN-CR-4 MÍNIMO (§6/§123): cada seção é limitada pelo orçamento do perfil
 *     (minimal/standard/deep) + overrides; `truncated` avisa quando cortou.
 *   - RN-CR-5 ESTENDE, não duplica (AC-A01): o resolver NÃO reimplementa snapshot/
 *     attention/metas/priorização — compõe. O `ContextEngineService` ganha um
 *     `resolve()` que delega aqui, mantendo o Engine como fachada única.
 */

// Escopo (§8) → âncora do grafo (F2). Mapeia o nível mais específico presente pro
// tipo de entidade do grafo. `focus` explícito no request sobrepõe isto.
const LEVEL_TO_ENTITY: Record<string, string> = {
  CUSTOMER: "customer", SUPPLIER: "supplier", PRODUCT: "product",
  USER: "user", LOCATION: "store", BUSINESS_UNIT: "store",
  DEPARTMENT: "department", ORGANIZATION: "organization",
};
// Mais específico → menos específico (a âncora deve ser a entidade mais fina).
const ANCHOR_PRIORITY = ["CUSTOMER", "SUPPLIER", "PRODUCT", "USER", "LOCATION", "BUSINESS_UNIT", "DEPARTMENT", "ORGANIZATION"];

// Tipo de entidade do grafo → subject_type do ledger (pra escopar os fatos ao
// sujeito da âncora). Só os que fazem sentido como sujeito de sinal.
const ENTITY_TO_SUBJECT: Record<string, string> = {
  customer: "customer", supplier: "supplier", product: "product",
  store: "store", department: "department", user: "user",
};

export class ContextResolverService {
  /**
   * Resolve o contexto pra um intent. Devolve o `ContextPacket` (§20). Nunca
   * lança por dado ausente — degrada pra lacuna/qualidade (best-effort por seção).
   */
  static resolve(orgId: string, request: ContextRequest): ContextPacket {
    const budget = resolveBudget(request);
    const scope: ContextScope = request.scope ?? makeScope(orgId, []);
    const domains = (request.domains || []).filter(Boolean);

    // ── Âncora: focus explícito > dimensão mais específica do escopo. ──────────
    const anchor = this.resolveAnchor(orgId, request.focus, scope);

    // ── 1. Momento (§17) — attention, limitado. ───────────────────────────────
    let moment: ContextMoment = { total: 0, bySeverity: {}, byDomain: {}, top: [] };
    let momentTotal = 0;
    try {
      const att = BusinessSignalService.attention(orgId, { limit: Math.max(budget.maxSignals, 50) });
      let items = att.items as Array<Record<string, any>>;
      if (domains.length) items = items.filter((i) => domains.includes(String(i.domain)));
      momentTotal = domains.length ? items.length : att.total;
      moment = {
        total: momentTotal,
        bySeverity: att.bySeverity,
        byDomain: att.byDomain,
        top: items.slice(0, budget.maxSignals),
      };
    } catch { /* sem momento: segue com fatos/grafo (RN-CR-2) */ }

    // ── 2. Fatos (§11) — sinais crus traduzidos por factFromSignal (F1). ───────
    // Escopados ao SUJEITO da âncora quando houver (relevância §6); senão org-wide.
    const { facts, factsHitCap } = this.resolveFacts(orgId, anchor, domains, budget.maxFacts);

    // ── 3. Grafo (F2) — vizinhança da âncora (ou esqueleto da org sem âncora). ─
    const graph = ContextGraphService.build(orgId, anchor || `organization:${orgId}`, {
      maxDepth: anchor ? budget.graphDepth : 1,
      maxNodes: budget.maxEntities,
    });

    // ── 4. Metas (§9/§14) — atrasadas primeiro, limitadas. ────────────────────
    const goals = this.resolveGoals(orgId, domains, budget.maxGoals);

    // ── 4b. Restrições (§15) — aplicáveis à âncora (global + escopo). ──────────
    const constraints = this.resolveConstraints(orgId, anchor);

    // ── 5. Pistas de processo (§21) — de recommendedActionType/ACTION_MAP. ─────
    const skillHints = this.resolveSkillHints(orgId, domains, budget.maxGoals);

    // ── 6. Qualidade do contexto (§75). ───────────────────────────────────────
    const quality = this.computeQuality(orgId, facts);

    const truncated = graph.truncated || factsHitCap || momentTotal > moment.top.length;

    const sources = ["business_signals", "attention", "context_graph", "business_goals", "impact_prioritization", "data_quality"];

    return {
      tenantId: orgId,
      intent: request.intent,
      scope,
      anchor: graph.found ? anchor : null, // âncora que NÃO resolveu não é reportada como resolvida (RN-CR-2)
      moment,
      facts,
      entities: graph.entities,
      relationships: graph.relationships,
      goals,
      constraints,
      skillHints,
      quality,
      sources,
      truncated,
      budget,
      generatedAt: new Date().toISOString(),
      schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
    };
  }

  /** focus explícito (se resolver) > dimensão mais específica do escopo. null = org-wide. */
  private static resolveAnchor(orgId: string, focus: string | null | undefined, scope: ContextScope): string | null {
    if (focus && ContextGraphService.resolveEntity(orgId, focus)) return focus;
    for (const level of ANCHOR_PRIORITY) {
      const r = scopeRef(scope, level as any);
      if (!r) continue;
      const type = LEVEL_TO_ENTITY[level];
      if (!type) continue;
      const candidate = `${type}:${r}`;
      if (ContextGraphService.resolveEntity(orgId, candidate)) return candidate;
    }
    return null;
  }

  /**
   * Lê sinais ABERTOS e não expirados e os traduz em `ContextFact` (F1). Escopa
   * ao sujeito da âncora quando ela é sujeito de sinal (customer/product/…) — foco
   * mínimo-e-relevante (§6). Sem sinal → []. NUNCA inventa (RN-CR-2).
   */
  private static resolveFacts(orgId: string, anchor: string | null, domains: string[], maxFacts: number): { facts: ContextFact[]; factsHitCap: boolean } {
    const where: string[] = ["organization_id = ?", "status = 'open'", "(expires_at IS NULL OR datetime(expires_at) > datetime('now'))"];
    const params: any[] = [orgId];

    if (anchor) {
      const [type, id] = [anchor.slice(0, anchor.indexOf(":")), anchor.slice(anchor.indexOf(":") + 1)];
      const subjectType = ENTITY_TO_SUBJECT[type];
      if (subjectType && id) { where.push("subject_type = ?", "subject_id = ?"); params.push(subjectType, id); }
    }
    if (domains.length) { where.push(`domain IN (${domains.map(() => "?").join(",")})`); params.push(...domains); }

    let rows: any[] = [];
    try {
      // +1 pra detectar se estourou o teto (sem reportar cap falso).
      rows = db.prepare(
        `SELECT * FROM business_signals WHERE ${where.join(" AND ")} ORDER BY datetime(detected_at) DESC LIMIT ?`
      ).all(...params, maxFacts + 1) as any[];
    } catch { rows = []; }

    const factsHitCap = rows.length > maxFacts;
    const facts = rows.slice(0, maxFacts).map((r) => factFromSignal({ ...r, evidence: r.evidence_json ? safeParse(r.evidence_json) : undefined }));
    return { facts, factsHitCap };
  }

  /** Metas com progresso; atrasadas ('behind') primeiro; limitadas. Best-effort. */
  private static resolveGoals(orgId: string, domains: string[], maxGoals: number): Array<Record<string, unknown>> {
    try {
      const prog = BusinessGoalService.progress(orgId);
      // atrasadas > no_track > reached; desempate determinístico por métrica.
      const order: Record<string, number> = { behind: 0, on_track: 1, reached: 2 };
      const goals = [...prog.goals].sort((a, b) => (order[a.paceStatus] ?? 9) - (order[b.paceStatus] ?? 9) || a.metric.localeCompare(b.metric));
      return goals.slice(0, maxGoals);
    } catch { return []; }
  }

  /**
   * §15 — restrições APLICÁVEIS ao contexto: globais + as escopadas à âncora
   * (quando a âncora é uma entidade escopável: customer/supplier/product/store/…).
   * Traduz `business_constraints` → `ContextConstraint` (F1). Best-effort → [].
   */
  private static resolveConstraints(orgId: string, anchor: string | null): ContextConstraint[] {
    try {
      let scopeType: string | null = null;
      let scopeRef: string | null = null;
      if (anchor) {
        const type = anchor.slice(0, anchor.indexOf(":"));
        const id = anchor.slice(anchor.indexOf(":") + 1);
        // o tipo do grafo casa direto com o scope_type da restrição (customer/
        // supplier/product/store/department); org não escopa (só globais valem).
        if (type !== "organization") { scopeType = type; scopeRef = id; }
      }
      const rows = BusinessConstraintService.applicable(orgId, { scopeType, scopeRef });
      return rows.map((c: any) => ({
        id: String(c.id),
        kind: String(c.kind),
        name: String(c.name),
        scopeType: c.scope_type ?? null,
        scopeRef: c.scope_ref ?? null,
        operator: String(c.operator || "lte"),
        value: c.value_num != null ? Number(c.value_num) : null,
        unit: c.value_unit ?? null,
        text: c.value_text ?? null,
        source: { type: "APPROVED_CONFIG", service: "BusinessConstraintService", reference: String(c.source || "owner_declared") },
        active: !!c.active,
      }));
    } catch { return []; }
  }

  /**
   * PISTAS de processo (§21) — deriva de `ImpactPrioritizationService.prioritize`
   * (recommendedActionType/ACTION_MAP). NÃO seleciona/executa skill (isso é PRD 4)
   * — é só dica. Best-effort: qualquer falha degrada pra [] (RN-CR-2).
   */
  private static resolveSkillHints(orgId: string, domains: string[], maxHints: number): SkillHint[] {
    try {
      const pr = ImpactPrioritizationService.prioritize(orgId, { globalLimit: Math.max(maxHints, 5) });
      let items = (pr.global || []) as Array<Record<string, any>>;
      if (domains.length) items = items.filter((p) => domains.includes(String(p.domain)));
      return items.slice(0, maxHints).map((p) => ({
        domain: String(p.domain),
        hint: String(p.recommendedActionType || "create_task"),
        label: String(p.recommendedAction || "Registrar e acompanhar"),
        reason: String(p.reason || ""),
        priority: clampConfidence(Number(p.score) || 0),
        impactLevel: p.impactLevel ?? null,
      }));
    } catch { return []; }
  }

  /**
   * §75 — qualidade do próprio contexto. A partir da F8 é o `ContextQualityService`
   * quem consolida a matemática (cobertura + confiança + frescor + conflitos +
   * lacunas); o resolver DELEGA (fonte única, AC-A01) — comportamento idêntico.
   */
  private static computeQuality(orgId: string, facts: ContextFact[]): ContextQuality {
    return ContextQualityService.assessFromFacts(orgId, facts);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────
function safeParse(s: string | null | undefined): any { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } }

export default ContextResolverService;
