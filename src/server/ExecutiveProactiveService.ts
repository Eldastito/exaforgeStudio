import db from "./db.js";
import { ExecutiveConstraintService } from "./ExecutiveConstraintService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * Executive Proactive Briefing (ADR-190 — diferida "briefing proativo", agora entregue).
 *
 * O dono NÃO precisa nem perguntar "Como está minha empresa?": um DIGEST EXECUTIVO
 * SEMANAL, POR EXCEÇÃO (§115), é publicado na ESPINHA (`business_signals`, convenção
 * nº 12) de onde flui SOZINHO pras superfícies proativas que já existem (Smart Inbox /
 * "Hoje" / push do `FalaTuProactiveService`, que honra quiet-hours e limiar da ADR-163).
 * NÃO é um 2º motor proativo — é um publisher que COMPÕE a leitura executiva (F5) e o
 * progresso das metas, exatamente como o `HelpKnowledgeService.publishLearnOne` faz.
 *
 * HONESTIDADE / anti-ruído: só publica quando há ALGO estratégico a dizer (pior pilar,
 * restrição ou meta fora do ritmo). Negócio calmo → NÃO publica (o dono não é incomodado
 * — §115). Gate de 7 dias (idempotente por semana). Money-free: o resumo é QUALITATIVO
 * (pior pilar, restrição textual, contagem de metas atrasadas) — nunca R$ (§73). TTL de
 * 7 dias: o digest da semana expira sozinho (o `attention()` já filtra expirados).
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExecutiveBriefing {
  notable: boolean;
  worstPillar: { pillar: string; health: string } | null;
  constraintFact: string | null;
  constraintAction: string | null;
  offTrackGoals: number;
  text: string;
}

export class ExecutiveProactiveService {
  /** Compõe o briefing executivo (read-only, money-free). notable=false → negócio calmo. */
  static briefing(orgId: string): ExecutiveBriefing {
    const con = ExecutiveConstraintService.assess(orgId, { includeMoney: false });
    let offTrackGoals = 0;
    try { offTrackGoals = BusinessGoalService.progress(orgId).goals.filter((g) => g.paceStatus === "behind").length; } catch { /* sem metas */ }

    const worstPillar = con.worstPillar ? { pillar: con.worstPillar.pillar, health: con.worstPillar.health } : null;
    const constraintFact = con.constraint?.fact ?? null;
    const constraintAction = con.constraint?.recommendedAction ?? null;
    const notable = !!worstPillar || !!constraintFact || offTrackGoals > 0;

    const PT: Record<string, string> = { commercial: "Comercial", operations: "Operações", finance: "Financeiro" };
    const parts: string[] = [];
    if (worstPillar) parts.push(`Pilar em pior forma: ${PT[worstPillar.pillar] || worstPillar.pillar}`);
    if (constraintFact) parts.push(`Prioridade nº1 (hipótese): ${constraintFact}${constraintAction ? ` → ${constraintAction}` : ""}`);
    if (offTrackGoals > 0) parts.push(`${offTrackGoals} ${offTrackGoals > 1 ? "metas fora do ritmo" : "meta fora do ritmo"}`);
    const text = notable ? `Resumo da sua empresa: ${parts.join(" · ")}.` : "Tudo sob controle — nenhuma exceção estratégica esta semana.";

    return { notable, worstPillar, constraintFact, constraintAction, offTrackGoals, text };
  }

  /** Chave semanal estável (segunda-feira ISO da semana corrente) pra dedupe do digest. */
  private static weekKey(now = new Date()): string {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = (d.getUTCDay() + 6) % 7; // 0 = segunda
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }

  /** Publica o digest da semana na espinha (gate 7d + só-quando-notável). Idempotente. */
  static publish(orgId: string, opts: { force?: boolean } = {}): { published: boolean; reason?: string } {
    if (!opts.force) {
      const recent = db.prepare(
        `SELECT 1 FROM business_signals WHERE organization_id = ? AND domain='executive' AND signal_type='executive_briefing' AND detected_at > datetime('now','-7 days') LIMIT 1`
      ).get(orgId);
      if (recent) return { published: false, reason: "not_due" };
    }
    const b = this.briefing(orgId);
    if (!b.notable) return { published: false, reason: "nothing_notable" };
    try {
      BusinessSignalService.publish(orgId, {
        domain: "executive", signalType: "executive_briefing", severity: "info", basis: "fact", confidence: 1,
        impactAmount: null, impactUnit: null, sourceService: "ExecutiveProactiveService",
        evidence: { note: b.text, worstPillar: b.worstPillar, constraintFact: b.constraintFact, offTrackGoals: b.offTrackGoals },
        dedupeKey: `executive_briefing:${this.weekKey()}`,
        expiresAt: new Date(Date.now() + WEEK_MS).toISOString(),
      });
      return { published: true };
    } catch { return { published: false, reason: "publish_failed" }; }
  }

  /** Scheduler pass: digest semanal pras orgs ativas. Best-effort, nunca lança. */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE status = 'active'`).all() as any[]; } catch { return; }
    for (const o of orgs) { try { this.publish(o.organization_id); } catch (e) { console.error("[ExecutiveProactive] publish falhou", o.organization_id, e); } }
  }
}

export default ExecutiveProactiveService;
