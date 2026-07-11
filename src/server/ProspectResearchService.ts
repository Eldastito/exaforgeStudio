import db from "./db.js";
import { randomUUID } from "node:crypto";
import { chat } from "./llm.js";
import { logAuthEvent } from "./auditLog.js";
import { ProspectExecutionService } from "./ProspectExecutionService.js";
import { ProspectService } from "./ProspectService.js";

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

    // Fase D: vitória com evidência vira MEMÓRIA reutilizável. Confiança
    // derivada do z (mais separação estatística → mais confiança).
    if (decision === "keep" && winner) {
      this.recordLearning(orgId, {
        campaignId: e.campaign_id, learningType: e.variable_under_test === "message" ? "message" : e.variable_under_test,
        insight: `Experimento "${e.name}": a variante "${winner.name}" venceu em ${metricKey} (${(winner[metricKey] * 100).toFixed(1)}% vs ${(second[metricKey] * 100).toFixed(1)}%). ${e.hypothesis ? `Hipótese confirmada: ${e.hypothesis}` : ""}`.trim(),
        confidence: Math.min(0.95, 0.5 + z / 10),
        evidence: { experimentId: id, metric: metricKey, z: Number(z.toFixed(3)), metrics },
        sourceExperimentId: id,
      }, actorId);
    }
    return this.getExperiment(orgId, id);
  }

  // ── Memória de aprendizados (ADR-079, Fase D — por tenant, D4) ──────────
  /**
   * Grava um aprendizado. Aprendizado ATIVO do mesmo tipo na mesma campanha é
   * SUPERSEDIDO (deprecated) — evidência nova vence dogma antigo.
   */
  static recordLearning(orgId: string, input: {
    campaignId?: string | null; scope?: string; segment?: string; region?: string; channel?: string;
    learningType?: string; insight?: string; confidence?: number; evidence?: any; sourceExperimentId?: string;
  }, actorId?: string): any {
    const insight = String(input?.insight || "").trim();
    if (!insight) throw new Error("Descreva o aprendizado.");
    const learningType = ["message", "niche", "timing", "objection", "offer"].includes(String(input?.learningType)) ? input.learningType : "message";
    db.prepare("UPDATE prospect_learning_memory SET status = 'deprecated', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND status = 'active' AND learning_type = ? AND COALESCE(campaign_id, '') = COALESCE(?, '')")
      .run(orgId, learningType, input?.campaignId || null);
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_learning_memory (id, organization_id, scope, campaign_id, segment, region, channel, learning_type, insight, confidence_score, evidence_json, source_experiment_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, ["campaign", "segment", "product"].includes(String(input?.scope)) ? input.scope : "campaign",
        input?.campaignId || null, String(input?.segment || "").trim() || null, String(input?.region || "").trim() || null,
        String(input?.channel || "").trim() || null, learningType, insight,
        Math.max(0, Math.min(1, Number(input?.confidence) || 0.5)), JSON.stringify(input?.evidence || {}), input?.sourceExperimentId || null, actorId || null);
    logAuthEvent(orgId, actorId, null, "PROSPECT_LEARNING_RECORDED", { learningId: id, learningType, campaignId: input?.campaignId || null, sourceExperimentId: input?.sourceExperimentId || null });
    return db.prepare("SELECT * FROM prospect_learning_memory WHERE id = ?").get(id);
  }

  static listLearnings(orgId: string, opts: { campaignId?: string; includeDeprecated?: boolean } = {}): any[] {
    let sql = "SELECT * FROM prospect_learning_memory WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (!opts.includeDeprecated) sql += " AND status = 'active'";
    if (opts.campaignId) { sql += " AND campaign_id = ?"; params.push(opts.campaignId); }
    return db.prepare(sql + " ORDER BY confidence_score DESC, created_at DESC LIMIT 200").all(...params) as any[];
  }

  static deprecateLearning(orgId: string, id: string, actorId?: string): boolean {
    const r = db.prepare("UPDATE prospect_learning_memory SET status = 'deprecated', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status = 'active'").run(id, orgId);
    if (r.changes > 0) logAuthEvent(orgId, actorId, null, "PROSPECT_LEARNING_DEPRECATED", { learningId: id });
    return r.changes > 0;
  }

  // ── Dashboard e ponte com o RIC (ADR-079, Fase E) ────────────────────────
  /** Números agregados do funil de prospecção (fonte: dados reais das Fases A–D). */
  static dashboard(orgId: string): any {
    const leads = db.prepare("SELECT COUNT(*) total, COUNT(CASE WHEN account_status IN ('qualified','contacted','converted') THEN 1 END) qualified FROM prospect_accounts WHERE organization_id = ?").get(orgId) as any;
    const camps = db.prepare("SELECT COUNT(*) n FROM prospect_campaigns WHERE organization_id = ? AND status IN ('draft','active')").get(orgId) as any;
    const funnel = db.prepare("SELECT COUNT(CASE WHEN status='sent' THEN 1 END) sent, COUNT(CASE WHEN replied_at IS NOT NULL THEN 1 END) replied FROM prospect_outreach WHERE organization_id = ?").get(orgId) as any;
    const meetings = db.prepare("SELECT COUNT(*) n FROM prospect_accounts WHERE organization_id = ? AND meeting_at IS NOT NULL").get(orgId) as any;
    const attr = ProspectService.attributionSummary(orgId);
    const champion = db.prepare("SELECT name, message_body FROM prospect_message_variants WHERE organization_id = ? AND is_champion = 1 ORDER BY updated_at DESC LIMIT 1").get(orgId) as any || null;
    const topSegments = db.prepare(`
      SELECT COALESCE(a.industry, '(sem segmento)') AS segment,
             COUNT(CASE WHEN o.status='sent' THEN 1 END) AS sent,
             COUNT(CASE WHEN o.replied_at IS NOT NULL THEN 1 END) AS responses
      FROM prospect_outreach o JOIN prospect_accounts a ON a.id = o.prospect_account_id AND a.organization_id = o.organization_id
      WHERE o.organization_id = ? GROUP BY segment HAVING sent >= 3 ORDER BY (responses * 1.0 / sent) DESC LIMIT 5
    `).all(orgId).map((s: any) => ({ ...s, rate: s.sent ? s.responses / s.sent : 0 }));
    return {
      leadsTotal: Number(leads?.total || 0), leadsQualified: Number(leads?.qualified || 0),
      campaignsActive: Number(camps?.n || 0), messagesSent: Number(funnel?.sent || 0),
      responses: Number(funnel?.replied || 0), responseRate: funnel?.sent ? Number(funnel.replied) / Number(funnel.sent) : 0,
      meetings: Number(meetings?.n || 0), converted: attr.wonCount,
      potentialRevenue: attr.pipelineCount * attr.avgDeal, wonRevenue: attr.totalWon,
      championMessage: champion, topSegments,
    };
  }

  /** Resumo para o RIC: nichos com maior resposta, mensagens vencedoras, receita. */
  static ricSummary(orgId: string): any {
    const d = this.dashboard(orgId);
    const learnings = this.listLearnings(orgId).slice(0, 5).map(l => ({ type: l.learning_type, insight: l.insight, confidence: l.confidence_score }));
    return {
      responseRate: d.responseRate, meetings: d.meetings, potentialRevenue: d.potentialRevenue, wonRevenue: d.wonRevenue,
      topSegments: d.topSegments, championMessage: d.championMessage ? d.championMessage.name : null, learnings,
    };
  }

  // ── IA: hipóteses testáveis e próxima ação (usa SÓ dados registrados) ───
  static async suggestHypotheses(orgId: string, campaignId?: string): Promise<any> {
    const learnings = this.listLearnings(orgId, { campaignId }).slice(0, 8);
    const champions = db.prepare("SELECT name, channel, message_body FROM prospect_message_variants WHERE organization_id = ? AND is_champion = 1 LIMIT 5").all(orgId) as any[];
    const stats = db.prepare(`
      SELECT COUNT(CASE WHEN status='sent' THEN 1 END) sent, COUNT(CASE WHEN replied_at IS NOT NULL THEN 1 END) replied
      FROM prospect_outreach WHERE organization_id = ?${campaignId ? " AND campaign_id = ?" : ""}
    `).get(...(campaignId ? [orgId, campaignId] : [orgId])) as any;
    const prompt = `Você é o AutoProspect Research Engine do ZappFlow OS. Proponha de 1 a 3 HIPÓTESES comerciais TESTÁVEIS (uma variável por experimento), com base SOMENTE nos dados abaixo. Não invente dados. Cada hipótese deve poder virar um A/B com métrica clara.
DADOS:
- Envios: ${stats?.sent || 0}; respostas: ${stats?.replied || 0}.
- Mensagens champion atuais: ${champions.map(c => `"${c.name}" (${c.channel})`).join("; ") || "(nenhuma)"}
- Aprendizados ativos: ${learnings.map(l => `[${l.learning_type}] ${l.insight} (confiança ${Math.round(l.confidence_score * 100)}%)`).join("\n") || "(nenhum)"}
Responda em JSON: {"hypotheses":[{"hypothesis":"...","variable":"message|channel|niche|timing","metric":"response_rate|meeting_rate|conversion_rate","variant_a":"...","variant_b":"..."}]}`;
    try {
      const j = JSON.parse(await chat(prompt, { temperature: 0.5, json: true }));
      return { hypotheses: Array.isArray(j?.hypotheses) ? j.hypotheses.slice(0, 3) : [] };
    } catch (e) {
      throw new Error("A IA não está disponível agora para sugerir hipóteses. Tente novamente.");
    }
  }

  static async recommendNextAction(orgId: string): Promise<{ advice: string }> {
    const running = db.prepare("SELECT name, sample_size, started_at FROM prospect_experiments WHERE organization_id = ? AND status = 'running'").all(orgId) as any[];
    const recent = db.prepare("SELECT name, decision, decision_reason FROM prospect_experiments WHERE organization_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 3").all(orgId) as any[];
    const learnings = this.listLearnings(orgId).slice(0, 5);
    const stats = db.prepare("SELECT COUNT(CASE WHEN status='sent' THEN 1 END) sent, COUNT(CASE WHEN replied_at IS NOT NULL THEN 1 END) replied FROM prospect_outreach WHERE organization_id = ?").get(orgId) as any;
    const fallback = running.length
      ? `Há ${running.length} experimento(s) em execução — aguarde o orçamento fechar antes de decidir. Enquanto isso, aloque leads às variantes e mantenha a fila de aprovação em dia.`
      : "Nenhum experimento em execução. Crie um experimento A/B (uma variável, amostra mínima de 10 por variante) desafiando a mensagem champion atual.";
    try {
      const prompt = `Você é o AutoProspect Research Engine. Recomende a PRÓXIMA AÇÃO de prospecção em no máximo 100 palavras, português do Brasil, com base SÓ nisto (não invente):
Envios: ${stats?.sent || 0}; respostas: ${stats?.replied || 0}. Experimentos rodando: ${running.map(r => r.name).join("; ") || "nenhum"}. Últimas decisões: ${recent.map(r => `${r.name} → ${r.decision}`).join("; ") || "nenhuma"}. Aprendizados: ${learnings.map(l => l.insight).join(" | ") || "nenhum"}.`;
      const advice = (await chat(prompt, { temperature: 0.4 })).trim();
      return { advice: advice || fallback };
    } catch { return { advice: fallback }; }
  }
}
