/**
 * ADR-206 F5.7 — APRENDIZADO NEGATIVO ESTRUTURADO (ESTENDE `PatternMemoryService`/`LearningEpisodeService` — sem motor novo, RN-F5-12).
 *
 * O que já existia: o ledger `business_pattern_outcomes` mede o desfecho NEGATIVO (`no_effect`/`backfired`) e o `learningPrior`
 * assimétrico só adiciona cautela. O que faltava é o PORQUÊ: ninguém perguntava "por que não funcionou?" e o motivo, quando
 * existia, era texto livre. Aqui o sistema PERGUNTA (sinal na espinha) e a pessoa responde com um motivo ESTRUTURADO.
 *
 * Regras (RN-F5-*, RN-EL-*):
 *  - A PERGUNTA é ativa mas não incomoda: `business_signals` (domain `learning`, dedupe por padrão), nunca tabela de alerta nova;
 *    some sozinha quando todos os desfechos negativos do padrão têm resposta.
 *  - A RESPOSTA é decisão de PESSOA (rótulo de sistema recusado), só sobre desfecho NEGATIVO da própria empresa, com motivo de uma
 *    lista fechada (até 3 por desfecho; `outra` exige nota). Append-only, idempotente por (desfecho, motivo) — nada é apagado.
 *  - O texto livre é DADO NÃO CONFIÁVEL: higienizado (mesmo filtro do LEARN-007) e limitado; nunca vai a modelo.
 *  - É EVIDÊNCIA, não ordem (RN-EL-2): o agregado mostra os motivos mais frequentes; só aponta um motivo "dominante" com ≥3
 *    desfechos explicados e ≥50% deles — abaixo disso é `null` (não inventa causa). Não altera confiança, política nem `learningPrior`.
 *  - Motivo ≠ prova de causa: é o que a pessoa diz. Percentuais sem denominador são `null`, nunca 0.
 *  - Isolado por organização; opt-in herdado do `pattern_memory`.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { PatternMemoryService } from "./PatternMemoryService.js";
import { sanitizeText } from "./ManagerSolutionService.js";

export const REASONS: Array<{ code: string; label: string; hint: string }> = [
  { code: "timing", label: "Momento errado", hint: "Fizemos cedo ou tarde demais (época, dia, horário)." },
  { code: "audience", label: "Público errado", hint: "Não era para esse tipo de cliente ou região." },
  { code: "offer", label: "Preço ou oferta", hint: "O preço, o desconto ou a condição não convenceu." },
  { code: "execution", label: "Não foi executado como planejado", hint: "A equipe não fez, ou fez diferente do combinado." },
  { code: "capacity", label: "Faltou estoque ou equipe", hint: "Não havia produto, tamanho ou gente para atender." },
  { code: "external", label: "Fator externo", hint: "Clima, feriado, concorrente, algo fora do nosso controle." },
  { code: "diagnosis", label: "O diagnóstico estava errado", hint: "O dado ou a leitura que motivou a ação não se confirmou." },
  { code: "no_reaction", label: "O cliente não reagiu", hint: "Fizemos certo, mas não houve resposta." },
  { code: "other", label: "Outro motivo", hint: "Explique na nota." },
];
const CODES = new Set(REASONS.map((r) => r.code));
export const MAX_REASONS_PER_OUTCOME = 3;
export const DOMINANT_MIN_EXPLAINED = 3;
export const DOMINANT_MIN_SHARE = 0.5;
const SYSTEM_ACTOR = /^(rule|ai|runtime|system|scheduler|agent|autopilot|mission|playbook|process|cron|bot)([:_\-\s]|$)/i;
const NEGATIVE = ["no_effect", "backfired"];
const dedupeKey = (patternId: string) => `negative_learning:pattern:${patternId}`;
const label = (code: string) => REASONS.find((r) => r.code === code)?.label || code;

export class NegativeLearningService {
  static question() {
    return { text: "Por que isso não funcionou? (pode marcar até 3 motivos)", options: REASONS.map((r) => ({ ...r })) };
  }

  /** Desfechos NEGATIVOS ainda sem nenhum motivo — a fila de perguntas, mais novos primeiro. */
  static pending(orgId: string, opts: { limit?: number } = {}): any[] {
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
    return db.prepare(`
      SELECT o.id AS outcomeId, o.pattern_id AS patternId, o.domain, o.outcome, o.realized_impact AS realizedImpact, o.source, o.created_at AS at, p.description
        FROM business_pattern_outcomes o
        LEFT JOIN business_patterns p ON p.id = o.pattern_id AND p.organization_id = o.organization_id
       WHERE o.organization_id = ? AND o.outcome IN ('no_effect','backfired')
         AND NOT EXISTS (SELECT 1 FROM pattern_negative_reasons r WHERE r.organization_id = o.organization_id AND r.outcome_id = o.id)
       ORDER BY o.created_at DESC, o.id DESC LIMIT ?`).all(orgId, limit) as any[];
  }

  /** A pessoa responde "por que não funcionou?". Só desfecho negativo da própria empresa; append-only. */
  static answer(orgId: string, outcomeId: string, input: { reasons?: unknown; note?: unknown }, actor: string | null | undefined): { ok: boolean; error?: string; reasons?: string[]; added?: string[] } {
    const by = String(actor || "").trim();
    if (!by) return { ok: false, error: "Responder exige uma pessoa identificada." };
    if (SYSTEM_ACTOR.test(by)) return { ok: false, error: "Só uma pessoa explica por que não funcionou." };
    const o = db.prepare("SELECT id, pattern_id, outcome FROM business_pattern_outcomes WHERE organization_id = ? AND id = ?").get(orgId, String(outcomeId || "")) as any;
    if (!o) return { ok: false, error: "Desfecho não encontrado." };
    if (!NEGATIVE.includes(o.outcome)) return { ok: false, error: "Só desfecho que não funcionou (sem efeito ou saiu pior) pede motivo." };

    const raw = Array.isArray(input?.reasons) ? input.reasons : [];
    const codes = [...new Set(raw.map((x) => String(x).trim()))].filter(Boolean);
    if (!codes.length) return { ok: false, error: "Escolha pelo menos um motivo." };
    const bad = codes.find((c) => !CODES.has(c));
    if (bad) return { ok: false, error: `Motivo desconhecido: ${bad.slice(0, 40)}` };
    const note = sanitizeText(input?.note, 300);
    if (codes.includes("other") && note.length < 3) return { ok: false, error: "\"Outro motivo\" exige uma nota explicando." };

    const existing = (db.prepare("SELECT reason_code c FROM pattern_negative_reasons WHERE organization_id = ? AND outcome_id = ?").all(orgId, o.id) as any[]).map((r) => r.c);
    const toAdd = codes.filter((c) => !existing.includes(c));
    if (existing.length + toAdd.length > MAX_REASONS_PER_OUTCOME) return { ok: false, error: `No máximo ${MAX_REASONS_PER_OUTCOME} motivos por desfecho.` };

    const tx = db.transaction(() => {
      for (const c of toAdd) {
        db.prepare("INSERT INTO pattern_negative_reasons (id, organization_id, outcome_id, pattern_id, reason_code, note, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), orgId, o.id, o.pattern_id, c, note || null, by);
      }
    });
    tx();
    if (toAdd.length) { try { logAuthEvent(orgId, by, o.pattern_id, "PATTERN_NEGATIVE_REASON", { outcomeId: o.id, reasons: toAdd }); } catch { /* best-effort */ } }
    try { this.publishQuestions(orgId); } catch { /* o sinal se ajusta sozinho na próxima varredura */ }
    return { ok: true, reasons: [...existing, ...toAdd], added: toAdd };
  }

  static reasonsFor(orgId: string, outcomeId: string): Array<{ code: string; label: string; note: string | null; answeredBy: string; at: string }> {
    return (db.prepare("SELECT reason_code, note, answered_by, created_at FROM pattern_negative_reasons WHERE organization_id = ? AND outcome_id = ? ORDER BY created_at ASC, id ASC").all(orgId, outcomeId) as any[])
      .map((r) => ({ code: r.reason_code, label: label(r.reason_code), note: r.note, answeredBy: r.answered_by, at: r.created_at }));
  }

  /** Agregado DERIVADO por query (RN-004): evidência dos motivos. Sem denominador → null; "dominante" só com amostra e maioria. */
  static summary(orgId: string, opts: { patternId?: string; domain?: string } = {}): any {
    const where: string[] = ["o.organization_id = ?", "o.outcome IN ('no_effect','backfired')"]; const params: any[] = [orgId];
    if (opts.patternId) { where.push("o.pattern_id = ?"); params.push(opts.patternId); }
    if (opts.domain) { where.push("o.domain = ?"); params.push(opts.domain); }
    const W = where.join(" AND ");
    const total = Number((db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes o WHERE ${W}`).get(...params) as any).n || 0);
    const explained = Number((db.prepare(`SELECT COUNT(DISTINCT o.id) n FROM business_pattern_outcomes o JOIN pattern_negative_reasons r ON r.organization_id = o.organization_id AND r.outcome_id = o.id WHERE ${W}`).get(...params) as any).n || 0);
    const rows = db.prepare(`SELECT r.reason_code c, COUNT(DISTINCT o.id) n FROM business_pattern_outcomes o JOIN pattern_negative_reasons r ON r.organization_id = o.organization_id AND r.outcome_id = o.id WHERE ${W} GROUP BY r.reason_code ORDER BY n DESC, r.reason_code ASC`).all(...params) as any[];
    const byReason = rows.map((r) => ({ code: r.c, label: label(r.c), outcomes: Number(r.n), share: explained ? Number(r.n) / explained : null }));
    const top = byReason[0];
    const dominant = top && explained >= DOMINANT_MIN_EXPLAINED && (top.share as number) >= DOMINANT_MIN_SHARE && top.code !== "other" ? { code: top.code, label: top.label, share: top.share } : null;
    return {
      negativeOutcomes: total, explained, unexplained: total - explained,
      explainedPct: total ? Math.round((explained / total) * 1000) / 10 : null,
      byReason, dominant,
      thresholds: { dominantMinExplained: DOMINANT_MIN_EXPLAINED, dominantMinShare: DOMINANT_MIN_SHARE },
      note: "Motivo é o que a pessoa disse, não prova de causa; serve de evidência e não altera confiança nem política.",
    };
  }

  /** Publica/atualiza a PERGUNTA ativa (um sinal por padrão com desfecho negativo sem motivo) e resolve as que ficaram sem pendência. */
  static publishQuestions(orgId: string): { published: number; resolved: number } {
    if (!PatternMemoryService.isEnabled(orgId)) return { published: 0, resolved: 0 };
    const rows = db.prepare(`
      SELECT o.pattern_id AS patternId, MAX(p.description) AS description, COUNT(*) AS n
        FROM business_pattern_outcomes o
        LEFT JOIN business_patterns p ON p.id = o.pattern_id AND p.organization_id = o.organization_id
       WHERE o.organization_id = ? AND o.outcome IN ('no_effect','backfired')
         AND NOT EXISTS (SELECT 1 FROM pattern_negative_reasons r WHERE r.organization_id = o.organization_id AND r.outcome_id = o.id)
       GROUP BY o.pattern_id`).all(orgId) as any[];
    let published = 0;
    for (const r of rows) {
      BusinessSignalService.publish(orgId, {
        domain: "learning", signalType: "negative_outcome_unexplained", severity: "attention", basis: "fact", confidence: 1,
        sourceService: "NegativeLearningService", sourceEntityType: "pattern", sourceEntityId: r.patternId, dedupeKey: dedupeKey(r.patternId),
        evidence: { patternId: r.patternId, description: r.description || null, unexplained: Number(r.n), question: "Por que isso não funcionou?", note: "Marque o motivo para o sistema aprender com o que não deu certo." },
      });
      published++;
    }
    const open = new Set(rows.map((r) => r.patternId));
    const stale = db.prepare("SELECT dedupe_key k FROM business_signals WHERE organization_id = ? AND signal_type = 'negative_outcome_unexplained' AND status = 'open'").all(orgId) as any[];
    let resolved = 0;
    for (const s of stale) { const pid = String(s.k).replace("negative_learning:pattern:", ""); if (!open.has(pid)) { const x = BusinessSignalService.resolveByDedupe(orgId, s.k); if (x.ok) resolved++; } }
    return { published, resolved };
  }

  /** Varre empresas com a memória de padrões ligada. Best-effort. */
  static runAll(): { orgs: number; published: number; resolved: number } {
    const orgs = db.prepare("SELECT organization_id orgId FROM organization_settings WHERE COALESCE(pattern_memory, 0) = 1").all() as any[];
    let published = 0, resolved = 0;
    for (const o of orgs) { try { const r = this.publishQuestions(String(o.orgId)); published += r.published; resolved += r.resolved; } catch (e) { console.error("[Learning F5.7] falhou pra org", o.orgId, e); } }
    return { orgs: orgs.length, published, resolved };
  }
}

export default NegativeLearningService;
