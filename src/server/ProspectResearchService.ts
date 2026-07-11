import db from "./db.js";
import { randomUUID } from "node:crypto";
import { chat } from "./llm.js";
import { logAuthEvent } from "./auditLog.js";
import { ProspectExecutionService } from "./ProspectExecutionService.js";

/**
 * AutoProspect Research Engine (ADR-079, Fase C).
 *
 * Método do autoresearch adaptado à prospecção:
 *  - ORÇAMENTO FIXO pré-declarado: amostra por variante + janela de medição
 *    definidas na criação; a decisão só acontece quando o orçamento fecha
 *    (ou a janela expira) — sem "espiar" resultado parcial.
 *  - UMA variável por experimento (message | channel | niche | timing).
 *  - Decisão DETERMINÍSTICA: teste de duas proporções entre a melhor variante
 *    e a segunda; z >= confidence_z → keep; senão INCONCLUSIVE (o default).
 *    A IA só redige o resumo (best-effort) — nunca decide.
 *  - Champion/challenger: a vencedora vira is_champion da campanha; a
 *    baseline nunca se perde.
 *
 * As métricas vêm do ciclo real da Fase B (prospect_outreach + eventos):
 * enviado → respondeu → reunião → convertido. Aprovação humana continua
 * obrigatória em cada abordagem — o experimento não é licença para disparo.
 */
const VARIABLES = ["message", "channel", "niche", "timing"];
const METRICS = ["response_rate", "meeting_rate", "conversion_rate"];
const MIN_SAMPLE = 10; // abaixo disso qualquer teste é ruído — recusa criar

export class ProspectResearchService {
  // ── Criação e ciclo de vida ──────────────────────────────────────────────
  static createExperiment(orgId: string, input: {
    campaignId?: string; name?: string; hypothesis?: string; variableUnderTest?: string;
    successMetric?: string; sampleSize?: number; windowDays?: number;
    variants?: { name?: string; hypothesis?: string; channel?: string; subject?: string; body?: string; tone?: string; cta?: string }[];
  }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao experimento.");
    const variants = Array.isArray(input?.variants) ? input.variants.filter(v => String(v?.body || "").trim()) : [];
    if (variants.length < 2) throw new Error("Experimento exige ao menos 2 variantes com mensagem.");
    const sampleSize = parseInt(String(input?.sampleSize), 10) || 0;
    if (sampleSize < MIN_SAMPLE) throw new Error(`Amostra mínima por variante é ${MIN_SAMPLE} (declare o orçamento antes de começar).`);
    if (input?.campaignId) {
      const c = db.prepare("SELECT id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(input.campaignId, orgId);
      if (!c) throw new Error("Campanha não encontrada.");
    }
    const variable = VARIABLES.includes(String(input?.variableUnderTest)) ? input.variableUnderTest : "message";
    const metric = METRICS.includes(String(input?.successMetric)) ? input.successMetric : "response_rate";
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_experiments (id, organization_id, campaign_id, name, hypothesis, variable_under_test, success_metric, sample_size, window_days, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, input?.campaignId || null, name, String(input?.hypothesis || "").trim() || null, variable, metric, sampleSize, Math.max(1, parseInt(String(input?.windowDays), 10) || 14), actorId || null);
    const insVar = db.prepare(`INSERT INTO prospect_message_variants (id, organization_id, campaign_id, experiment_id, name, hypothesis, channel, subject, message_body, tone, cta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    variants.forEach((v, i) => insVar.run(randomUUID(), orgId, input?.campaignId || null, id,
      String(v?.name || "").trim() || `Variante ${String.fromCharCode(65 + i)}`, String(v?.hypothesis || "").trim() || null,
      v?.channel === "email" ? "email" : "whatsapp", String(v?.subject || "").trim() || null, String(v!.body).trim(),
      String(v?.tone || "").trim() || null, String(v?.cta || "").trim() || null));
    logAuthEvent(orgId, actorId, null, "PROSPECT_EXPERIMENT_CREATED", { experimentId: id, name, variable, metric, sampleSize, variants: variants.length });
    return this.getExperiment(orgId, id);
  }

  static startExperiment(orgId: string, id: string, actorId?: string): any {
    const e = db.prepare("SELECT status FROM prospect_experiments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!e) throw new Error("Experimento não encontrado.");
    if (e.status !== "draft") throw new Error(`Experimento em '${e.status}' não pode ser iniciado.`);
    db.prepare("UPDATE prospect_experiments SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
    logAuthEvent(orgId, actorId, null, "PROSPECT_EXPERIMENT_STARTED", { experimentId: id });
    return this.getExperiment(orgId, id);
  }

  static listExperiments(orgId: string): any[] {
    return db.prepare("SELECT * FROM prospect_experiments WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").all(orgId) as any[];
  }

  static getExperiment(orgId: string, id: string): any {
    const e = db.prepare("SELECT * FROM prospect_experiments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!e) return null;
    e.variants = db.prepare("SELECT * FROM prospect_message_variants WHERE experiment_id = ? AND organization_id = ? ORDER BY created_at ASC").all(id, orgId) as any[];
    e.metrics = this.metricsForExperiment(orgId, id);
    e.results = db.prepare("SELECT * FROM prospect_experiment_results WHERE experiment_id = ? AND organization_id = ?").all(id, orgId) as any[];
    return e;
  }

  // ── Alocação de leads a variantes (round-robin pelo menor uso) ──────────
  /**
   * Cria um RASCUNHO de abordagem para a conta usando a variante menos usada
   * do experimento, respeitando o orçamento (sample_size por variante). O
   * rascunho segue o fluxo normal: aprovação do gestor → envio real (Fase B).
   */
  static draftFromVariant(orgId: string, experimentId: string, accountId: string, contactId?: string, actorId?: string): any {
    const e = db.prepare("SELECT * FROM prospect_experiments WHERE id = ? AND organization_id = ?").get(experimentId, orgId) as any;
    if (!e) throw new Error("Experimento não encontrado.");
    if (e.status !== "running") throw new Error("Inicie o experimento antes de alocar leads.");
    const acc = db.prepare("SELECT id, campaign_id FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const usage = db.prepare(`
      SELECT v.id, COUNT(o.id) AS used
      FROM prospect_message_variants v
      LEFT JOIN prospect_outreach o ON o.variant_id = v.id AND o.organization_id = v.organization_id AND o.status != 'rejected'
      WHERE v.experiment_id = ? AND v.organization_id = ? AND v.status = 'active'
      GROUP BY v.id ORDER BY used ASC, v.created_at ASC
    `).all(experimentId, orgId) as any[];
    const slot = usage.find(u => Number(u.used) < Number(e.sample_size));
    if (!slot) throw new Error("Orçamento do experimento atingido — todas as variantes completaram a amostra.");
    const v = db.prepare("SELECT * FROM prospect_message_variants WHERE id = ? AND organization_id = ?").get(slot.id, orgId) as any;
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status, variant_id, experiment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(id, orgId, e.campaign_id || acc.campaign_id || null, accountId, contactId || null, v.channel, v.subject || null, v.message_body, JSON.stringify({ experiment: e.name, variant: v.name }), v.id, experimentId);
    logAuthEvent(orgId, actorId, null, "PROSPECT_OUTREACH_COMPOSED", { outreachId: id, accountId, variantId: v.id, experimentId, createdByAi: false });
    return { outreachId: id, variantId: v.id, variantName: v.name };
  }

  // ── Métricas (do ciclo real da Fase B) ───────────────────────────────────
  static metricsForExperiment(orgId: string, experimentId: string): any[] {
    return (db.prepare(`
      SELECT v.id AS variant_id, v.name,
        COUNT(CASE WHEN o.status = 'sent' THEN 1 END) AS messages_sent,
        COUNT(CASE WHEN o.status = 'sent' AND o.replied_at IS NOT NULL THEN 1 END) AS responses_count,
        COUNT(CASE WHEN o.status = 'sent' AND a.meeting_at IS NOT NULL THEN 1 END) AS meetings_count,
        COUNT(CASE WHEN o.status = 'sent' AND a.account_status = 'converted' THEN 1 END) AS converted_count
      FROM prospect_message_variants v
      LEFT JOIN prospect_outreach o ON o.variant_id = v.id AND o.organization_id = v.organization_id
      LEFT JOIN prospect_accounts a ON a.id = o.prospect_account_id AND a.organization_id = v.organization_id
      WHERE v.experiment_id = ? AND v.organization_id = ?
      GROUP BY v.id ORDER BY v.created_at ASC
    `).all(experimentId, orgId) as any[]).map(m => ({
      ...m,
      response_rate: m.messages_sent ? m.responses_count / m.messages_sent : 0,
      meeting_rate: m.messages_sent ? m.meetings_count / m.messages_sent : 0,
      conversion_rate: m.messages_sent ? m.converted_count / m.messages_sent : 0,
    }));
  }

  // ── Decisão (determinística; IA só redige o resumo) ─────────────────────
  /** Teste de duas proporções: z entre a melhor e a segunda melhor variante. */
  static twoProportionZ(s1: number, n1: number, s2: number, n2: number): number {
    if (!n1 || !n2) return 0;
    const p = (s1 + s2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se > 0 ? (s1 / n1 - s2 / n2) / se : 0;
  }

  static async completeExperiment(orgId: string, id: string, actorId?: string): Promise<any> {
    const e = db.prepare("SELECT * FROM prospect_experiments WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!e) throw new Error("Experimento não encontrado.");
    if (e.status !== "running") throw new Error("Somente experimento em execução pode ser concluído.");
    const metrics = this.metricsForExperiment(orgId, id);
    // Regra anti-espiada: só decide quando TODAS as variantes fecharam a
    // amostra OU a janela de medição expirou desde o início.
    const budgetMet = metrics.length >= 2 && metrics.every(m => Number(m.messages_sent) >= Number(e.sample_size));
    const windowOver = e.started_at ? (db.prepare("SELECT julianday('now') - julianday(?) AS d").get(e.started_at) as any).d >= Number(e.window_days) : false;
    if (!budgetMet && !windowOver) {
      throw new Error(`Orçamento pré-declarado ainda aberto (amostra de ${e.sample_size}/variante não fechou e a janela de ${e.window_days} dia(s) não expirou). Decidir agora seria espiar o resultado.`);
    }

    const metricKey = e.success_metric as string; // response_rate | meeting_rate | conversion_rate
    const countKey = metricKey === "meeting_rate" ? "meetings_count" : metricKey === "conversion_rate" ? "converted_count" : "responses_count";
    const sorted = [...metrics].sort((a, b) => b[metricKey] - a[metricKey]);
    const [best, second] = sorted;
    let decision = "inconclusive";
    let reason: string;
    const enough = Number(best?.messages_sent) >= MIN_SAMPLE && Number(second?.messages_sent) >= MIN_SAMPLE;
    const z = enough ? this.twoProportionZ(Number(best[countKey]), Number(best.messages_sent), Number(second[countKey]), Number(second.messages_sent)) : 0;
    if (!enough) {
      reason = `Amostra insuficiente (mínimo ${MIN_SAMPLE} envios por variante) — resultado inconclusivo por padrão.`;
    } else if (z >= Number(e.confidence_z)) {
      decision = "keep";
      reason = `"${best.name}" venceu em ${metricKey} (${(best[metricKey] * 100).toFixed(1)}% vs ${(second[metricKey] * 100).toFixed(1)}%, z=${z.toFixed(2)} ≥ ${e.confidence_z}). Vira champion da campanha.`;
    } else {
      reason = `Diferença entre variantes não é estatisticamente significativa (z=${z.toFixed(2)} < ${e.confidence_z}) — inconclusivo. Estenda a amostra ou reformule a hipótese.`;
    }

    // Resumo textual (best-effort, sem inventar dados; falha → texto padrão).
    let summary = reason;
    try {
      const lines = metrics.map(m => `${m.name}: ${m.messages_sent} envios, ${m.responses_count} respostas, ${m.meetings_count} reuniões, ${m.converted_count} conversões`).join("\n");
      const s = (await chat(`Você é o AutoProspect Research Engine. Resuma em 2 frases, português do Brasil, o resultado do experimento "${e.name}" (métrica: ${metricKey}). Use SOMENTE os números abaixo, sem inventar nada.\n${lines}\nDecisão: ${decision}. Motivo: ${reason}`, { temperature: 0.3 })).trim();
      if (s) summary = s;
    } catch { /* mantém o resumo determinístico */ }

    const winner = decision === "keep" ? best : null;
    const insRes = db.prepare(`INSERT INTO prospect_experiment_results (id, organization_id, experiment_id, variant_id, messages_sent, responses_count, meetings_count, converted_count, response_rate, meeting_rate, conversion_rate, result_status, analysis_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const m of metrics) {
      const status = decision === "inconclusive" ? "inconclusive" : (winner && m.variant_id === winner.variant_id ? "keep" : "discard");
      insRes.run(randomUUID(), orgId, id, m.variant_id, m.messages_sent, m.responses_count, m.meetings_count, m.converted_count, m.response_rate, m.meeting_rate, m.conversion_rate, status, m.variant_id === (winner?.variant_id || sorted[0]?.variant_id) ? summary : null);
    }
    db.prepare("UPDATE prospect_experiments SET status = 'completed', decision = ?, winner_variant_id = ?, decision_reason = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?")
      .run(decision, winner?.variant_id || null, reason, id, orgId);
    // Champion/challenger: vencedora assume o posto da campanha; perdedoras aposentam.
    if (winner && e.campaign_id) {
      db.prepare("UPDATE prospect_message_variants SET is_champion = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND campaign_id = ? AND is_champion = 1").run(orgId, e.campaign_id);
      db.prepare("UPDATE prospect_message_variants SET is_champion = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(winner.variant_id, orgId);
    }
    if (decision !== "inconclusive") {
      db.prepare("UPDATE prospect_message_variants SET status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE experiment_id = ? AND organization_id = ? AND id != ?").run(id, orgId, winner?.variant_id || "");
    }
    ProspectExecutionService.emit(orgId, "experiment.completed", { campaignId: e.campaign_id, payload: { experimentId: id, decision, winnerVariantId: winner?.variant_id || null } });
    if (decision === "keep") ProspectExecutionService.emit(orgId, "experiment.winner_found", { campaignId: e.campaign_id, payload: { experimentId: id, winnerVariantId: winner!.variant_id } });
    logAuthEvent(orgId, actorId, null, "PROSPECT_EXPERIMENT_DECISION", { experimentId: id, decision, winnerVariantId: winner?.variant_id || null, z: Number(z.toFixed(3)) });
    return this.getExperiment(orgId, id);
  }
}
