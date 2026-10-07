import { randomUUID } from "node:crypto";
import db from "./db.js";
import { ScenarioEngine, toRange, type ScenarioOutcome, type ScenarioMetric } from "./ScenarioEngine.js";
import { wilsonInterval, intervalConfidenceLabel } from "./statsWilson.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { logAuthEvent } from "./auditLog.js";
import { todaySP } from "./spDate.js";

/**
 * StrategicDecisionService — ADR-205 F4.2: decisão estratégica → hipótese → resultado real, para o sistema APRENDER se os cenários acertam.
 *
 * Registra (a) a DECISÃO do dono, (b) o CENÁRIO que a embasou — snapshot CONGELADO, calculado pelo servidor (não vem do cliente) —, (c) a HIPÓTESE
 * (o que se espera) e (d) depois, o RESULTADO REAL informado por uma pessoa. `compare` diz se o real caiu dentro, abaixo ou acima da faixa esperada.
 * `principle` é a MEMÓRIA ESTRATÉGICA do PRD §40 ("priorizar margem sobre crescimento"): explícita, revisável (`revoke`), nunca inferida.
 *
 * Regras (RN-F4):
 *  - NUNCA executa (RN-F4-1): registrar não cria ação, pedido, pagamento nem tarefa. Quem decide é UMA PESSOA (só owner/admin — RN-F4-2); a IA não decide.
 *  - Snapshot congelado: depois de registrar, mudar caixa/vendas NÃO altera o que foi decidido nem o que se esperava (convenção nº 3).
 *  - Resultado APPEND-ONLY: corrigir = nova medição; a última vale (convenção nº 9 — sem DELETE). `basis` fact|estimate dito por quem informou.
 *  - Faixa esperada vem da faixa do cenário; cenário de caso ÚNICO não tem faixa → usa o valor ± tolerância (padrão 20%, DECLARADA e editável — premissa, não dado).
 *  - Sem expectativa ou sem resultado → `no_expectation`/`no_actual` (nunca "acertou"); calibração = taxa com intervalo de Wilson, null sem amostra (RN-F4-6/8).
 *  - O lembrete de revisão é um sinal no `business_signals` (conv. nº 12), resolvido sozinho quando o resultado entra. Não é ordem.
 *  - Texto livre (título/hipótese/justificativa) é DADO do dono, nunca instrução: truncado, sem controle, e quem o reutilizar num prompt trata como não confiável.
 */
export type DecisionCategory = "purchase" | "sales_change" | "hire" | "principle" | "other";
export type DecisionStatus = "considering" | "decided" | "rejected" | "revoked";
export const DEFAULT_TOLERANCE_PCT = 20;
const SCENARIO_CATEGORIES = ["purchase", "sales_change", "hire"] as const;
const CATEGORIES: DecisionCategory[] = ["purchase", "sales_change", "hire", "principle", "other"];
const DEFAULT_METRIC: Record<string, string> = { purchase: "min_cash_with_purchase", sales_change: "gross_profit_delta", hire: "extra_revenue_needed" };
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return s || null; };
const isOwner = (actor: any) => !!actor?.userId && ["owner", "admin"].includes(String(actor?.role || ""));
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });

function expectationFrom(sc: ScenarioOutcome, metricKey: string, tolerancePct: number): { unit: string; low: number | null; high: number | null; single: boolean } {
  const m = (sc.metrics || []).find((x: ScenarioMetric) => x.key === metricKey);
  if (!m) throw bad("metric_not_found", `A métrica ${metricKey} não existe neste cenário.`);
  const single = m.conservative == null && m.favorable == null;
  const r = m.range;
  if (r.low == null || r.high == null) return { unit: m.unit, low: null, high: null, single };
  if (!single) return { unit: m.unit, low: r.low, high: r.high, single };
  const a = r.low * (1 - tolerancePct / 100), b = r.low * (1 + tolerancePct / 100);
  return { unit: m.unit, low: round2(Math.min(a, b)), high: round2(Math.max(a, b)), single };
}

export class StrategicDecisionService {
  /** Registra uma decisão EM CONSIDERAÇÃO. Para tipos de cenário, o servidor roda o motor e CONGELA o resultado. */
  static register(orgId: string, actor: { userId?: string; role?: string }, input: any): any {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador registra decisão estratégica.");
    const category = String(input?.category || "") as DecisionCategory;
    if (!CATEGORIES.includes(category)) throw bad("invalid_category", `Categoria inválida. Use: ${CATEGORIES.join(", ")}.`);
    const title = clean(input?.title, 160);
    if (!title || title.length < 3) throw bad("invalid_title", "Dê um título à decisão (mínimo 3 caracteres).");
    const hypothesis = clean(input?.hypothesis, 1000), rationale = clean(input?.rationale, 1000);
    let reviewOn: string | null = null;
    if (input?.reviewOn != null && input.reviewOn !== "") {
      reviewOn = String(input.reviewOn);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewOn) || Number.isNaN(Date.parse(reviewOn))) throw bad("invalid_review_date", "A data de revisão deve ser AAAA-MM-DD.");
      if (reviewOn < todaySP()) throw bad("invalid_review_date", "A data de revisão não pode ser no passado.");
    }
    const tol = input?.tolerancePct != null && input.tolerancePct !== "" ? Number(input.tolerancePct) : DEFAULT_TOLERANCE_PCT;
    if (!Number.isFinite(tol) || tol <= 0 || tol > 100) throw bad("invalid_tolerance", "A tolerância deve ficar entre 0 e 100%.");

    let scenario: ScenarioOutcome | null = null, metric: string | null = null, exp: ReturnType<typeof expectationFrom> | null = null;
    if ((SCENARIO_CATEGORIES as readonly string[]).includes(category)) {
      scenario = ScenarioEngine.run(orgId, category, input?.inputs && typeof input.inputs === "object" ? input.inputs : {});
      if (!scenario.ok) throw bad("scenario_failed", scenario.message || "Não foi possível simular esta decisão.");
      metric = String(input?.expectMetric || DEFAULT_METRIC[category]);
      exp = expectationFrom(scenario, metric, tol);
    } else if (input?.inputs) throw bad("invalid_input", "Princípio e 'outro' não têm cenário — remova 'inputs'.");

    const id = randomUUID();
    db.prepare(`INSERT INTO strategic_decisions (id, organization_id, category, title, status, hypothesis, rationale, scenario_json, assumptions_version, engine_version, confidence_level,
        expect_metric, expect_unit, expect_low, expect_high, expect_tolerance_pct, review_on, created_by, updated_at)
      VALUES (?,?,?,?, 'considering', ?,?,?,?,?,?, ?,?,?,?,?, ?,?, CURRENT_TIMESTAMP)`)
      .run(id, orgId, category, title, hypothesis, rationale, scenario ? JSON.stringify(scenario) : null, scenario?.assumptionsVersion ?? null, scenario?.engineVersion ?? null, scenario?.confidence?.level ?? null,
        metric, exp?.unit ?? null, exp?.low ?? null, exp?.high ?? null, exp?.single ? tol : null, reviewOn, actor.userId);
    this.audit(orgId, actor, id, "STRATEGIC_DECISION_REGISTERED", { category });
    return this.get(orgId, id);
  }

  /** O DONO decide (ou recusa). A decisão é humana; registrar não executa nada. */
  static decide(orgId: string, id: string, actor: { userId?: string; role?: string }, input: { status: unknown; rationale?: unknown }): any {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador decide.");
    const d = this.row(orgId, id);
    if (!d) throw bad("not_found", "Decisão não encontrada.");
    if (d.status !== "considering") throw bad("invalid_state", `Esta decisão já está '${d.status}'.`);
    const st = String(input?.status);
    if (st !== "decided" && st !== "rejected") throw bad("invalid_status", "Use 'decided' ou 'rejected'.");
    const why = clean(input?.rationale, 1000);
    db.prepare("UPDATE strategic_decisions SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, rationale = COALESCE(?, rationale), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?").run(st, actor.userId, why, orgId, id);
    this.audit(orgId, actor, id, st === "decided" ? "STRATEGIC_DECISION_DECIDED" : "STRATEGIC_DECISION_REJECTED", { category: d.category });
    return this.get(orgId, id);
  }

  /** Memória revisável: uma decisão/princípio decidido pode ser REVOGADO (some das diretrizes ativas, mas fica no histórico). */
  static revoke(orgId: string, id: string, actor: { userId?: string; role?: string }, reason?: unknown): any {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador revoga.");
    const d = this.row(orgId, id);
    if (!d) throw bad("not_found", "Decisão não encontrada.");
    if (d.status !== "decided") throw bad("invalid_state", "Só uma decisão 'decided' pode ser revogada.");
    const why = clean(reason, 500);
    db.prepare("UPDATE strategic_decisions SET status = 'revoked', rationale = CASE WHEN ? IS NULL THEN rationale ELSE COALESCE(rationale || ' | ', '') || 'Revogada: ' || ? END, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?").run(why, why, orgId, id);
    try { BusinessSignalService.resolveByDedupe(orgId, `strategic_review:${id}`); } catch { /* sinal opcional */ }
    this.audit(orgId, actor, id, "STRATEGIC_DECISION_REVOKED", { category: d.category });
    return this.get(orgId, id);
  }

  /** Reconfirma que a decisão/diretriz continua valendo e marca a PRÓXIMA revisão (resolve o lembrete da atual). */
  static revisit(orgId: string, id: string, actor: { userId?: string; role?: string }, input: { reviewOn: unknown; note?: unknown }): any {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador revisa.");
    const d = this.row(orgId, id);
    if (!d) throw bad("not_found", "Decisão não encontrada.");
    if (d.status !== "decided") throw bad("invalid_state", "Só uma decisão 'decided' pode ser revisitada.");
    const on = String(input?.reviewOn || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(on)) || on < todaySP()) throw bad("invalid_review_date", "Informe a próxima revisão (AAAA-MM-DD, hoje ou depois).");
    const note = clean(input?.note, 500);
    db.prepare("UPDATE strategic_decisions SET review_on = ?, rationale = CASE WHEN ? IS NULL THEN rationale ELSE COALESCE(rationale || ' | ', '') || 'Revisada: ' || ? END, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?").run(on, note, note, orgId, id);
    try { BusinessSignalService.resolveByDedupe(orgId, `strategic_review:${id}`); } catch { /* sinal opcional */ }
    this.audit(orgId, actor, id, "STRATEGIC_DECISION_REVISITED", { category: d.category });
    return this.get(orgId, id);
  }

  /** O que realmente aconteceu. APPEND-ONLY; a última medição da métrica vale. Só em decisão 'decided'. */
  static recordOutcome(orgId: string, id: string, actor: { userId?: string; role?: string }, input: { metric?: unknown; actual: unknown; basis?: unknown; note?: unknown }): any {
    if (!isOwner(actor)) throw bad("forbidden", "Só o dono ou o administrador registra o resultado.");
    const d = this.row(orgId, id);
    if (!d) throw bad("not_found", "Decisão não encontrada.");
    if (d.status !== "decided") throw bad("invalid_state", "Só se registra resultado de uma decisão 'decided'.");
    const metric = String(input?.metric || d.expect_metric || "");
    if (!metric) throw bad("invalid_metric", "Informe a métrica medida.");
    const actual = input?.actual === "" || input?.actual == null ? NaN : Number(input.actual);
    if (!Number.isFinite(actual)) throw bad("invalid_actual", "Informe o valor real medido (número).");
    const basis = input?.basis == null ? "fact" : String(input.basis);
    if (basis !== "fact" && basis !== "estimate") throw bad("invalid_basis", "A base deve ser 'fact' ou 'estimate'.");
    db.prepare("INSERT INTO strategic_decision_outcomes (id, organization_id, decision_id, metric_key, actual_value, unit, basis, source, note, recorded_by) VALUES (?,?,?,?,?,?,?, 'user', ?, ?)")
      .run(randomUUID(), orgId, id, metric, round2(actual), metric === d.expect_metric ? d.expect_unit : null, basis, clean(input?.note, 500), actor.userId);
    if (metric === d.expect_metric) { try { BusinessSignalService.resolveByDedupe(orgId, `strategic_review:${id}`); } catch { /* sinal opcional */ } }
    this.audit(orgId, actor, id, "STRATEGIC_DECISION_OUTCOME", { metric, basis });
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any | null {
    const d = this.row(orgId, id);
    if (!d) return null;
    const outcomes = db.prepare("SELECT metric_key metric, actual_value actual, unit, basis, source, note, recorded_by recordedBy, recorded_at recordedAt FROM strategic_decision_outcomes WHERE organization_id = ? AND decision_id = ? ORDER BY recorded_at ASC, rowid ASC").all(orgId, id);
    return { ...this.shape(d), scenario: d.scenario_json ? JSON.parse(d.scenario_json) : null, outcomes, comparison: this.compare(orgId, id) };
  }

  static list(orgId: string, opts: { status?: string; category?: string } = {}): any[] {
    const where = ["organization_id = ?"], args: any[] = [orgId];
    if (opts.status) { where.push("status = ?"); args.push(opts.status); }
    if (opts.category) { where.push("category = ?"); args.push(opts.category); }
    return (db.prepare(`SELECT * FROM strategic_decisions WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT 200`).all(...args) as any[]).map((r) => ({ ...this.shape(r), comparison: this.compare(orgId, r.id) }));
  }

  /** Diretrizes ATIVAS (princípios decididos e não revogados) — a memória estratégica. */
  static principles(orgId: string): any[] { return this.list(orgId, { status: "decided", category: "principle" }); }

  /** Esperado × real. Sem expectativa ou sem medição NÃO vira "acertou". */
  static compare(orgId: string, id: string): any {
    const d = this.row(orgId, id);
    if (!d) return null;
    if (d.expect_low == null || d.expect_high == null || !d.expect_metric) return { status: "no_expectation", isBacktest: false, note: d.category === "principle" ? "Diretriz: não tem número esperado." : "Sem faixa esperada (faltavam dados no cenário)." };
    const last = db.prepare("SELECT actual_value a, basis, recorded_at at FROM strategic_decision_outcomes WHERE organization_id = ? AND decision_id = ? AND metric_key = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1").get(orgId, id, d.expect_metric) as any;
    const unit = d.expect_unit || "BRL";
    const expected = { metric: d.expect_metric, low: d.expect_low, high: d.expect_high, display: toRange([d.expect_low, d.expect_high], unit).display, toleranceDeclared: d.expect_tolerance_pct ?? null };
    if (!last) return { status: "no_actual", isBacktest: false, expected, actual: null };
    const a = Number(last.a);
    const status = a < d.expect_low ? "below" : a > d.expect_high ? "above" : "within";
    const bound = status === "below" ? d.expect_low : status === "above" ? d.expect_high : null;
    const deviation = bound == null ? 0 : round2(Math.abs(a - bound));
    return { status, isBacktest: false, expected, actual: { value: a, display: toRange([a], unit).display, basis: last.basis, recordedAt: last.at }, deviation, deviationPct: bound != null && bound !== 0 ? Math.round((Math.abs(a - bound) / Math.abs(bound)) * 100) : null };
  }

  /** O cenário acerta? Taxa de "dentro da faixa" com intervalo de Wilson; null sem amostra. Só decisões decididas COM expectativa e resultado. */
  static calibration(orgId: string): any {
    const rows = (db.prepare("SELECT id, category FROM strategic_decisions WHERE organization_id = ? AND status = 'decided' AND expect_low IS NOT NULL").all(orgId) as any[])
      .map((r) => ({ category: r.category, c: this.compare(orgId, r.id) })).filter((r) => ["within", "below", "above"].includes(r.c?.status));
    const sum = (rs: typeof rows) => { const within = rs.filter((r) => r.c.status === "within").length, n = rs.length, iv = wilsonInterval(within, n);
      return { n, within, below: rs.filter((r) => r.c.status === "below").length, above: rs.filter((r) => r.c.status === "above").length, hitRate: n ? round2(within / n) : null, interval: iv ? { lower: iv.lower, upper: iv.upper } : null, confidence: intervalConfidenceLabel(iv) }; };
    const cats = [...new Set(rows.map((r) => r.category))];
    return { ...sum(rows), byCategory: Object.fromEntries(cats.map((c) => [c, sum(rows.filter((r) => r.category === c))])), note: rows.length ? "Taxa de resultados dentro da faixa esperada. Amostra pequena = intervalo largo: não é prova de que o motor acerta." : "Ainda sem decisões com resultado registrado." };
  }

  /** Decisões decididas cuja revisão venceu e que ainda não têm o resultado (ou diretrizes com revisão vencida). */
  static due(orgId: string, today: string = todaySP()): any[] {
    return (db.prepare("SELECT * FROM strategic_decisions WHERE organization_id = ? AND status = 'decided' AND review_on IS NOT NULL AND review_on <= ? ORDER BY review_on ASC").all(orgId, today) as any[])
      .filter((r) => r.category === "principle" || !["within", "below", "above"].includes(this.compare(orgId, r.id)?.status))
      .map((r) => this.shape(r));
  }

  /** Publica UM sinal por decisão com revisão vencida (conv. nº 12). Idempotente por dedupe; resolve sozinho quando o resultado entra. */
  static publishReviewReminders(orgId: string, today: string = todaySP()): { published: number } {
    let n = 0;
    for (const d of this.due(orgId, today)) {
      const principle = d.category === "principle";
      BusinessSignalService.publish(orgId, {
        domain: "strategic", signalType: "decision_review_due", severity: "attention", basis: "fact", confidence: 1,
        sourceService: "StrategicDecisionService", sourceEntityType: "strategic_decision", sourceEntityId: d.id,
        evidence: { decisionId: d.id, title: d.title, reviewOn: d.reviewOn, kind: principle ? "principle_review" : "outcome_missing", note: principle ? "Hora de revisar se esta diretriz continua valendo." : "Chegou a data de revisão e o resultado real ainda não foi registrado." },
        dedupeKey: `strategic_review:${d.id}`, subjectType: "strategic_decision", subjectId: d.id,
      });
      n++;
    }
    return { published: n };
  }

  static pass(now: Date = new Date()): void {
    const today = todaySP(now);
    let orgs: any[] = [];
    try { orgs = db.prepare("SELECT DISTINCT organization_id FROM strategic_decisions WHERE status = 'decided' AND review_on IS NOT NULL AND review_on <= ?").all(today) as any[]; } catch { return; }
    for (const o of orgs) { try { this.publishReviewReminders(o.organization_id, today); } catch (e) { console.error("[StrategicDecision] lembrete falhou", o.organization_id, e); } }
  }

  // ── internos ──
  private static row(orgId: string, id: string): any | null { return (db.prepare("SELECT * FROM strategic_decisions WHERE organization_id = ? AND id = ?").get(orgId, String(id)) as any) || null; }
  private static shape(d: any) {
    return { id: d.id, category: d.category, title: d.title, status: d.status, hypothesis: d.hypothesis, rationale: d.rationale, assumptionsVersion: d.assumptions_version, engineVersion: d.engine_version, confidenceAtDecision: d.confidence_level,
      expectation: d.expect_low != null ? { metric: d.expect_metric, unit: d.expect_unit, low: d.expect_low, high: d.expect_high, toleranceDeclared: d.expect_tolerance_pct } : null,
      reviewOn: d.review_on, createdBy: d.created_by, decidedBy: d.decided_by, decidedAt: d.decided_at, createdAt: d.created_at, executes: false };
  }
  private static audit(orgId: string, actor: any, id: string, event: string, meta: Record<string, any>) { try { logAuthEvent(orgId, actor?.userId, null, event, { decisionId: id, ...meta }); } catch { /* best-effort */ } }
}

export default StrategicDecisionService;
