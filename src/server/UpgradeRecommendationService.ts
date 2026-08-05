/**
 * UpgradeRecommendationService (ADR-153 F7.3) — histórico + cooldown das
 * recomendações de upgrade emitidas pelo motor (`PlanFitDetectorService` +
 * `PlanFitSignalPublisher`).
 *
 * PRD §14/§15 + Decisão #7. Motivação: sem cooldown, um sinal recorrente
 * (ex.: uso AI ≥90% há 4 meses) vira spam mensal mesmo depois de dono
 * dispensar 3 vezes. LGPD §14 exige que "rejeição pausa nova oferta".
 *
 * Contratos:
 *  - `record(orgId, signal, source)` — chamado pelo publisher no publish;
 *    idempotente por (org, target_plan_id, target_module_key) — atualiza a
 *    linha existente OU cria nova quando `pending` já foi resolvida.
 *  - `dismiss(orgId, id, actor)` — marca dispensada, incrementa rejection_count,
 *    seta cooldown_until (30d → 90d → 180d).
 *  - `accept(orgId, id, actor)` — marca aceita. NÃO executa upgrade (G-153-3).
 *    Fluxo real de checkout vem em F5.3.
 *  - `dismissBySignalId(orgId, signalId, actor)` — hook do route /api/signals/:id/dismiss.
 *    Achata "dono dispensou sinal genérico" em "cooldown ativado". No-op se não
 *    houver recomendação linkada.
 *  - `hasActiveCooldown(orgId, targetPlanId, moduleKey?, opts?)` — publisher usa
 *    ANTES de publicar. Cooldown ativo = `cooldown_until > now AND status='dismissed'`.
 *
 * RN-153-F7.3-001: cooldown escala 30d na 1ª rejeição, 90d na 2ª, 180d ≥3ª.
 * RN-153-F7.3-002: 180d é o teto (nunca cresce mais).
 * RN-153-F7.3-003: cooldown NÃO se aplica a severity=critical — cliente
 *                  travado (uso ≥100%) precisa saber mesmo dentro do window.
 *                  Publisher passa `opts.skipForCritical` ligado.
 *
 * Isolamento multi-tenant: organization_id em TODA query.
 * G-153-3: nada executa upgrade sem clique explícito em Cobrança.
 * G-153-6: cooldown determinístico (30/90/180 duro), sem IA.
 */
import db from "./db.js";
import { randomUUID } from "crypto";

export interface UpgradeRecommendation {
  id: string;
  organizationId: string;
  signalId: string | null;
  signalType: string;
  targetPlanId: string | null;
  targetModuleKey: string | null;
  score: number;
  impactAmount: number | null;
  impactUnit: string | null;
  evidence: any;
  status: "pending" | "accepted" | "dismissed" | "expired";
  rejectionCount: number;
  cooldownUntil: string | null;
  actor: string | null;
  createdAt: string;
  updatedAt: string;
  dismissedAt: string | null;
  acceptedAt: string | null;
}

export interface RecordInput {
  signalId: string;
  signalType: string;
  targetPlanId: string | null;
  targetModuleKey?: string | null;
  score: number;
  impactAmount?: number | null;
  impactUnit?: string | null;
  evidence?: any;
}

const COOLDOWN_LADDER_DAYS = [30, 90, 180] as const;

function computeCooldownUntil(rejectionCountAfterDismiss: number): string {
  // rejectionCountAfterDismiss = quantas vezes o dono JÁ dispensou (incluindo
  // a ação atual). 1 → 30d; 2 → 90d; ≥3 → 180d (teto).
  const idx = Math.min(rejectionCountAfterDismiss - 1, COOLDOWN_LADDER_DAYS.length - 1);
  const days = COOLDOWN_LADDER_DAYS[Math.max(0, idx)];
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  return now.toISOString();
}

function rowToRec(row: any): UpgradeRecommendation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    signalId: row.signal_id || null,
    signalType: row.signal_type,
    targetPlanId: row.target_plan_id || null,
    targetModuleKey: row.target_module_key || null,
    score: Number(row.score || 0),
    impactAmount: row.impact_amount != null ? Number(row.impact_amount) : null,
    impactUnit: row.impact_unit || null,
    evidence: row.evidence_json ? safeParse(row.evidence_json) : null,
    status: row.status || "pending",
    rejectionCount: Number(row.rejection_count || 0),
    cooldownUntil: row.cooldown_until || null,
    actor: row.actor || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dismissedAt: row.dismissed_at || null,
    acceptedAt: row.accepted_at || null,
  };
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

export class UpgradeRecommendationService {
  static readonly COOLDOWN_LADDER_DAYS = COOLDOWN_LADDER_DAYS;

  /**
   * Grava/atualiza uma recomendação a partir de um sinal publicado. Idempotente
   * por (org, target_plan_id, target_module_key) — se já existe uma `pending`
   * pro mesmo alvo, atualiza (score/evidence/signal_id/updated_at). Se existe
   * mas está `dismissed`/`accepted`/`expired`, cria linha nova (histórico).
   */
  static record(orgId: string, input: RecordInput): UpgradeRecommendation {
    if (!orgId) throw new Error("orgId é obrigatório");
    if (!input.signalId || !input.signalType) throw new Error("signalId e signalType obrigatórios");

    const existing = db.prepare(
      `SELECT * FROM upgrade_recommendations
        WHERE organization_id = ?
          AND target_plan_id IS ?
          AND target_module_key IS ?
          AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
    ).get(orgId, input.targetPlanId, input.targetModuleKey || null) as any;

    if (existing) {
      db.prepare(
        `UPDATE upgrade_recommendations SET
           signal_id = ?, signal_type = ?, score = ?,
           impact_amount = ?, impact_unit = ?, evidence_json = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND organization_id = ?`,
      ).run(
        input.signalId, input.signalType, Math.round(input.score || 0),
        input.impactAmount ?? null, input.impactUnit ?? null,
        JSON.stringify(input.evidence ?? {}),
        existing.id, orgId,
      );
      return this.getById(orgId, existing.id)!;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO upgrade_recommendations
         (id, organization_id, signal_id, signal_type, target_plan_id, target_module_key,
          score, impact_amount, impact_unit, evidence_json, status, rejection_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
    ).run(
      id, orgId, input.signalId, input.signalType,
      input.targetPlanId, input.targetModuleKey || null,
      Math.round(input.score || 0),
      input.impactAmount ?? null, input.impactUnit ?? null,
      JSON.stringify(input.evidence ?? {}),
    );
    return this.getById(orgId, id)!;
  }

  static getById(orgId: string, id: string): UpgradeRecommendation | null {
    const row = db.prepare(
      `SELECT * FROM upgrade_recommendations WHERE id = ? AND organization_id = ?`,
    ).get(id, orgId) as any;
    return row ? rowToRec(row) : null;
  }

  /**
   * Lista recomendações da org. `status` opcional; sem status retorna todas.
   * `includeExpired` (default false) exclui `expired`. Ordem: pending primeiro
   * (score desc), depois histórico por updated_at desc.
   */
  static list(orgId: string, opts?: { status?: string; includeExpired?: boolean; limit?: number }): UpgradeRecommendation[] {
    const clauses: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (opts?.status) { clauses.push("status = ?"); params.push(opts.status); }
    else if (!opts?.includeExpired) { clauses.push("status != 'expired'"); }
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 100));
    const rows = db.prepare(
      `SELECT * FROM upgrade_recommendations
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                 score DESC, updated_at DESC
        LIMIT ${limit}`,
    ).all(...params) as any[];
    return rows.map(rowToRec);
  }

  /**
   * Marca dispensada. Incrementa rejection_count (usa MAX pra manter histórico
   * de rejeições do mesmo alvo — se dono já dispensou 2×, próxima vira 3×
   * mesmo em linha nova). Seta cooldown_until pela escada 30/90/180.
   */
  static dismiss(orgId: string, id: string, actor?: string | null): { ok: boolean; recommendation?: UpgradeRecommendation } {
    const rec = this.getById(orgId, id);
    if (!rec) return { ok: false };
    if (rec.status === "dismissed") return { ok: true, recommendation: rec };

    // Histórico de rejeições pro mesmo alvo (não só a linha atual).
    const priorRejections = db.prepare(
      `SELECT COALESCE(MAX(rejection_count), 0) as maxRej
         FROM upgrade_recommendations
        WHERE organization_id = ?
          AND target_plan_id IS ?
          AND target_module_key IS ?`,
    ).get(orgId, rec.targetPlanId, rec.targetModuleKey) as any;
    const newCount = Number(priorRejections?.maxRej || 0) + 1;
    const cooldownUntil = computeCooldownUntil(newCount);

    db.prepare(
      `UPDATE upgrade_recommendations SET
         status = 'dismissed', rejection_count = ?, cooldown_until = ?,
         actor = COALESCE(?, actor),
         dismissed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
    ).run(newCount, cooldownUntil, actor || null, id, orgId);

    return { ok: true, recommendation: this.getById(orgId, id)! };
  }

  /**
   * Marca aceita — NÃO executa upgrade (G-153-3). Frontend é responsável por
   * levar dono pra Cobrança. Aqui é só ledger + audit.
   */
  static accept(orgId: string, id: string, actor?: string | null): { ok: boolean; recommendation?: UpgradeRecommendation } {
    const rec = this.getById(orgId, id);
    if (!rec) return { ok: false };
    if (rec.status === "accepted") return { ok: true, recommendation: rec };

    db.prepare(
      `UPDATE upgrade_recommendations SET
         status = 'accepted', actor = COALESCE(?, actor),
         accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`,
    ).run(actor || null, id, orgId);

    return { ok: true, recommendation: this.getById(orgId, id)! };
  }

  /**
   * Hook do route /api/signals/:id/dismiss — quando dono dispensa um sinal
   * genérico (F7.4 UI usa esse endpoint), se existe recomendação linkada, aplica
   * cooldown. Best-effort — sinal sem recomendação (ex.: legado F7.1 pré-F7.3)
   * é no-op. Nunca throw.
   */
  static dismissBySignalId(orgId: string, signalId: string, actor?: string | null): { ok: boolean; recommendation?: UpgradeRecommendation } {
    try {
      const row = db.prepare(
        `SELECT id FROM upgrade_recommendations
          WHERE organization_id = ? AND signal_id = ? AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`,
      ).get(orgId, signalId) as any;
      if (!row) return { ok: false };
      return this.dismiss(orgId, row.id, actor);
    } catch (e) {
      console.error("[UpgradeRecommendationService] dismissBySignalId falhou", e);
      return { ok: false };
    }
  }

  /**
   * Publisher usa antes de publicar um candidato — se true, NÃO publica.
   * `opts.skipForCritical` — se ligado + severity crítica, sempre retorna false
   * (RN-153-F7.3-003).
   */
  static hasActiveCooldown(
    orgId: string,
    targetPlanId: string | null,
    targetModuleKey?: string | null,
    opts?: { skipForCritical?: boolean; severity?: string | null },
  ): boolean {
    if (opts?.skipForCritical && opts?.severity === "critical") return false;

    const row = db.prepare(
      `SELECT cooldown_until FROM upgrade_recommendations
        WHERE organization_id = ?
          AND target_plan_id IS ?
          AND target_module_key IS ?
          AND status = 'dismissed'
          AND cooldown_until IS NOT NULL
          AND cooldown_until > CURRENT_TIMESTAMP
        ORDER BY cooldown_until DESC LIMIT 1`,
    ).get(orgId, targetPlanId, targetModuleKey || null) as any;
    return !!row;
  }

  /**
   * ADR-153 F7.6 — LISTAGEM CROSS-TENANT PRA MASTER ADMIN.
   *
   * Retorna recomendações de TODAS as organizações, com o nome da empresa
   * embutido pra tela `AdminUpgradeRecommendationsView` exibir sem N+1.
   * ATENÇÃO: rota chamadora DEVE gatear com `requireMasterAdmin` — este
   * método pula o filtro `organization_id`. É a única exceção documentada
   * ao "toda query filtra organization_id" (RN convenção crítica #1) e existe
   * porque Master Admin precisa ver o funil consolidado (aceitas aguardando
   * checkout de todas as orgs) pra processar upgrade manual até Fase 5
   * automatizar via Asaas.
   *
   * Filtros: status (accepted/pending/dismissed/expired), targetPlanId,
   * targetModuleKey, organizationId (se admin filtrar por uma). Ordem: mais
   * recentes primeiro (updated_at DESC). Cap 500 pra proteger o payload
   * (Master Admin com 200+ orgs — improvável, mas defensivo).
   */
  static listAcrossOrgs(opts?: {
    status?: string;
    targetPlanId?: string;
    targetModuleKey?: string;
    organizationId?: string;
    limit?: number;
  }): Array<UpgradeRecommendation & { organizationName?: string | null }> {
    const clauses: string[] = ["1=1"];
    const params: any[] = [];
    if (opts?.status) { clauses.push("ur.status = ?"); params.push(opts.status); }
    if (opts?.targetPlanId) { clauses.push("ur.target_plan_id = ?"); params.push(opts.targetPlanId); }
    if (opts?.targetModuleKey) { clauses.push("ur.target_module_key = ?"); params.push(opts.targetModuleKey); }
    if (opts?.organizationId) { clauses.push("ur.organization_id = ?"); params.push(opts.organizationId); }
    const limit = Math.min(500, Math.max(1, opts?.limit ?? 200));

    const rows = db.prepare(
      `SELECT ur.*, os.business_name AS org_name
         FROM upgrade_recommendations ur
         LEFT JOIN organization_settings os ON os.organization_id = ur.organization_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY CASE ur.status
                   WHEN 'accepted' THEN 0
                   WHEN 'pending' THEN 1
                   WHEN 'dismissed' THEN 2
                   ELSE 3
                 END,
                 ur.updated_at DESC
        LIMIT ${limit}`,
    ).all(...params) as any[];

    return rows.map((r) => ({
      ...rowToRec(r),
      organizationName: r.org_name || null,
    }));
  }

  /**
   * ADR-153 F7.6 — resumo agregado pro dashboard admin (Master Admin only).
   * Conta por status (todas as orgs). Custo O(1) via GROUP BY sobre a tabela
   * inteira. Sem cache — a tabela é pequena (< 1M linhas mesmo em escala).
   */
  static summaryAcrossOrgs(): {
    byStatus: Record<string, number>;
    acceptedAwaitingCheckout: number;
    totalPendingUplift: number;
  } {
    const rows = db.prepare(
      `SELECT status, COUNT(*) as cnt FROM upgrade_recommendations GROUP BY status`,
    ).all() as any[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[String(r.status)] = Number(r.cnt || 0);

    const uplift = db.prepare(
      `SELECT COALESCE(SUM(impact_amount), 0) as total
         FROM upgrade_recommendations
        WHERE status = 'pending' AND impact_unit = 'BRL'`,
    ).get() as any;

    return {
      byStatus,
      acceptedAwaitingCheckout: byStatus["accepted"] || 0,
      totalPendingUplift: Number(uplift?.total || 0),
    };
  }

  /**
   * Cleanup lazy: recomendações `dismissed` com cooldown_until já passado viram
   * `expired`. Sweep opt-in (chamável por scheduler/manutenção). Não é crítico —
   * `hasActiveCooldown` já filtra por `cooldown_until > now`.
   */
  static expireOldCooldowns(orgId?: string): number {
    const clause = orgId ? "AND organization_id = ?" : "";
    const params = orgId ? [orgId] : [];
    const r = db.prepare(
      `UPDATE upgrade_recommendations SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'dismissed'
          AND cooldown_until IS NOT NULL
          AND cooldown_until <= CURRENT_TIMESTAMP
          ${clause}`,
    ).run(...params);
    return r.changes;
  }
}

export default UpgradeRecommendationService;
