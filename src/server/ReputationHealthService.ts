/**
 * ReputationHealthService (ADR-162 / PRD 5 §67-§69, §84-§87, F14) — PRODUCTION HARDENING:
 * a leitura ÚNICA de prontidão do módulo de reputação + o backstop de rate-limit da
 * resposta pública (o único efeito externo). Tudo DERIVADO POR QUERY (RN-004, sem tabela
 * nova) — molde do "health · budget · runbook" do Radar (ADR-161 F12) e do SkillOS.
 *
 *   - HEALTH (§67): por provider, o estado do conector (connected/auth_expired/
 *     rate_limited/degraded/unavailable), frescor do sync (stale se parou de sincronizar)
 *     e o BACKLOG operacional (casos abertos, riscos de escalada, respostas publicadas
 *     aguardando fechamento). Vira um status único healthy/degraded/blocked + recomendações.
 *   - RATE-LIMIT (§68-69): teto diário de RESPOSTAS PÚBLICAS por org — um BACKSTOP de
 *     runaway (não gate de negócio; fail-safe), derivado do `action_execution_log`. O
 *     `publish` da F8 consulta `canReply` antes do efeito externo.
 *
 * Isolado por org (RN-CRR-9). Não age; só lê o estado e protege o efeito externo.
 */
import db from "./db.js";
import { ReputationConnectorService } from "./ReputationConnectorService.js";

const STALE_HOURS = 24;                 // conector habilitado sem sync há >24h = stale.
const MAX_REPLIES_PER_DAY = 30;         // backstop de runaway (§68); não é gate de negócio.
const REPLY_HANDLER = "ReputationPublishReplyCommandHandler";
const PROVIDERS = ["reclame_aqui", "stub"];

export interface ReputationHealthReport {
  generatedAt: string;
  status: "healthy" | "degraded" | "blocked";
  connectors: Array<{ provider: string; configured: boolean; enabled: boolean; health: string; lastSyncedAt: string | null; ageHours: number | null; stale: boolean }>;
  backlog: { openCases: number; escalationRisks: number; pendingReplyConfirmations: number };
  rateLimit: { repliesLast24h: number; maxRepliesPerDay: number; canReply: boolean };
  recommendations: string[];
}

export class ReputationHealthService {
  static readonly MAX_REPLIES_PER_DAY = MAX_REPLIES_PER_DAY;

  /** Respostas públicas publicadas com sucesso nas últimas 24h (efeito externo real). */
  static repliesLast24h(orgId: string): number {
    return (db.prepare(
      `SELECT COUNT(*) n FROM action_execution_log
        WHERE organization_id = ? AND handler = ? AND mode = 'execute' AND status = 'done'
          AND datetime(started_at) >= datetime('now','-1 day')`
    ).get(orgId, REPLY_HANDLER) as any).n as number;
  }

  /** Backstop de rate-limit (§68): pode publicar mais uma resposta agora? */
  static canReply(orgId: string): boolean {
    return this.repliesLast24h(orgId) < MAX_REPLIES_PER_DAY;
  }

  /** Relatório de prontidão do módulo. Derivado por query; isolado por org. */
  static report(orgId: string, opts: { now?: number } = {}): ReputationHealthReport {
    const now = opts.now || Date.now();
    const connectors = PROVIDERS.map((provider) => {
      const s = ReputationConnectorService.status(orgId, provider);
      const ageHours = s.lastSyncedAt ? Math.max(0, Math.round((now - Date.parse(s.lastSyncedAt)) / 3600e3)) : null;
      // Stale só importa pra conector LIGADO e CONFIGURADO (o stub/não-configurado não sincroniza).
      const stale = s.enabled && s.configured && (ageHours == null || ageHours > STALE_HOURS);
      return { provider, configured: s.configured, enabled: s.enabled, health: s.health, lastSyncedAt: s.lastSyncedAt, ageHours, stale };
    });

    const count = (sql: string, ...params: any[]) => (db.prepare(sql).get(orgId, ...params) as any).n as number;
    const backlog = {
      openCases: count(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'reputation' AND signal_type = 'public_complaint' AND status = 'open'`),
      escalationRisks: count(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'reputation' AND signal_type = 'reputational_escalation_risk' AND status = 'open'`),
      pendingReplyConfirmations: count(`SELECT COUNT(*) n FROM action_confirmations WHERE organization_id = ? AND confirmation_method = 'reputation_reply' AND status = 'pending'`),
    };

    const repliesLast24h = this.repliesLast24h(orgId);
    const canReply = repliesLast24h < MAX_REPLIES_PER_DAY;
    const rateLimit = { repliesLast24h, maxRepliesPerDay: MAX_REPLIES_PER_DAY, canReply };

    // Status agregado + recomendações (gestão por exceção).
    const recommendations: string[] = [];
    let status: "healthy" | "degraded" | "blocked" = "healthy";
    for (const c of connectors) {
      if (!c.enabled) continue;
      if (c.health === "auth_expired" || c.health === "unavailable") { status = "blocked"; recommendations.push(`Conector ${c.provider}: ${c.health} — reconfigurar credenciais/checar provedor (§66-67).`); }
      else if (c.health === "rate_limited" || c.health === "degraded") { if (status !== "blocked") status = "degraded"; recommendations.push(`Conector ${c.provider}: ${c.health} — throttle/retry em curso (§68).`); }
      if (c.stale) { if (status !== "blocked") status = "degraded"; recommendations.push(`Conector ${c.provider}: sync stale (${c.ageHours == null ? "nunca sincronizou" : c.ageHours + "h"}) — rodar POST /api/reputation/sync.`); }
    }
    if (!canReply) { status = "blocked"; recommendations.push(`Rate-limit de resposta atingido (${repliesLast24h}/${MAX_REPLIES_PER_DAY} em 24h) — segurar publicações até a janela abrir (§68).`); }
    if (backlog.openCases >= 20) { if (status === "healthy") status = "degraded"; recommendations.push(`Backlog alto: ${backlog.openCases} casos abertos — priorizar triagem (Smart Inbox, F7).`); }

    return { generatedAt: new Date(now).toISOString(), status, connectors, backlog, rateLimit, recommendations };
  }
}

export default ReputationHealthService;
