/**
 * Propostas de solução do gerente — conhecimento HUMANO governado (PRD Moda/
 * TOULON, frente LEARN; ADR-174).
 *
 * Princípio (§7.6): NÃO é treino automático de modelo. A sugestão do gerente é
 * conhecimento com PROCEDÊNCIA, REVISÃO, EXPERIMENTO e RESULTADO MENSURÁVEL —
 * só depois de VALIDADA + com resultado ASSEGURADO ela pode ser publicada na
 * memória de padrões EXISTENTE (`retail_store_patterns`, sem motor novo — §37/D6).
 *
 * Guardas:
 *  - Máquina de estados (LEARN-002): draft → in_review → approved_for_test →
 *    testing → validated → promoted; + rejected/archived/revoked.
 *  - Aprovação (LEARN-003): papel autorizado (owner/admin, imposto na rota);
 *    o AUTOR não pode aprovar sozinho uma proposta que afete VÁRIAS lojas
 *    (escopo de organização, store_id nulo).
 *  - Sanitização (LEARN-007): limpa/limita o texto; barra injeção de instrução,
 *    segredos e ruído — conteúdo rejeitado não entra em recuperação confiável.
 *  - Promoção (LEARN-005): só validated+assegurado → memória; revogável.
 * Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const MAX_LEN = 2000;
// Padrões de injeção/segredo barrados (LEARN-007). Não é IA — é higiene de texto.
const INJECTION = /(ignore\s+(all\s+)?previous|disregard\s+(the\s+)?above|system\s*:|assistant\s*:|<\|.*?\|>|api[_-]?key|secret[_-]?key|password\s*[:=])/i;

export function sanitizeText(raw: any, max = MAX_LEN): string {
  let s = String(raw ?? "");
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " "); // controles (mantem \n e \t)
  // Remove linhas que parecem instrução de sistema / segredo.
  s = s.split(/\r?\n/).filter((line) => !INJECTION.test(line)).join("\n");
  s = s.replace(/\s{3,}/g, "  ").trim();
  return s.slice(0, max);
}

type CreateInput = {
  storeId?: string | null;
  refType?: "signal" | "pattern" | "task" | null;
  refId?: string | null;
  title: string;
  proposal: string;
  conditions?: string;
  expectedMetric?: string;
  baseline?: number | null;
  observationDeadline?: string | null;
  risks?: string;
};

const num = (v: any): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export class ManagerSolutionService {
  static get(orgId: string, id: string): any | null {
    return (db.prepare(`SELECT * FROM manager_solution_proposals WHERE organization_id = ? AND id = ?`).get(orgId, id) as any) || null;
  }

  static list(orgId: string, opts: { state?: string } = {}): any[] {
    const where = ["organization_id = ?"]; const args: any[] = [orgId];
    if (opts.state) { where.push("state = ?"); args.push(opts.state); }
    return db.prepare(`SELECT * FROM manager_solution_proposals WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`).all(...args) as any[];
  }

  /** Cria a proposta (nasce `draft`). Sanitiza os textos livres. */
  static create(orgId: string, input: CreateInput, authorId?: string): any {
    const title = sanitizeText(input.title, 160);
    const proposal = sanitizeText(input.proposal);
    if (!title) throw new Error("Informe um título.");
    if (!proposal) throw new Error("Descreva a proposta.");
    const id = randomUUID();
    db.prepare(`
      INSERT INTO manager_solution_proposals
        (id, organization_id, store_id, ref_type, ref_id, author_user_id, title, proposal_text, conditions, expected_metric, baseline, observation_deadline, risks, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      id, orgId, input.storeId || null,
      ["signal", "pattern", "task"].includes(String(input.refType)) ? input.refType : null,
      input.refId || null, authorId || null, title, proposal,
      sanitizeText(input.conditions || "", 500) || null,
      sanitizeText(input.expectedMetric || "", 160) || null,
      num(input.baseline),
      input.observationDeadline ? String(input.observationDeadline).slice(0, 10) : null,
      sanitizeText(input.risks || "", 500) || null,
    );
    try { logAuthEvent(orgId, authorId || "system", id, "MANAGER_SOLUTION_CREATED", { title }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  private static setState(orgId: string, id: string, state: string, patch: Record<string, any> = {}, actorId?: string, event = "MANAGER_SOLUTION_STATE"): any {
    const cols = ["state = ?"]; const vals: any[] = [state];
    for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
    db.prepare(`UPDATE manager_solution_proposals SET ${cols.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(...vals, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, event, { state }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** draft → in_review (autor submete para revisão). */
  static submit(orgId: string, id: string, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (p.state !== "draft") throw new Error("só rascunho pode ir para revisão");
    return this.setState(orgId, id, "in_review", {}, actorId, "MANAGER_SOLUTION_SUBMITTED");
  }

  /**
   * in_review → approved_for_test. Papel autorizado é imposto na ROTA (owner/
   * admin). Aqui vale a regra de negócio: o AUTOR não aprova sozinho uma
   * proposta de escopo ORG (várias lojas) — LEARN-003.
   */
  static approveForTest(orgId: string, id: string, approverId: string | undefined, actorIsAuthorized: boolean): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (p.state !== "in_review") throw new Error("só proposta em revisão pode ser aprovada para teste");
    if (!actorIsAuthorized) throw new Error("apenas papel autorizado aprova");
    const multiStore = !p.store_id; // escopo de organização = várias lojas
    if (multiStore && approverId && approverId === p.author_user_id) {
      throw new Error("o autor não pode aprovar sozinho uma proposta que afeta várias lojas");
    }
    return this.setState(orgId, id, "approved_for_test", { approver_user_id: approverId || null }, approverId, "MANAGER_SOLUTION_APPROVED_TEST");
  }

  /** approved_for_test → testing (opcionalmente vincula a ação/tarefa do experimento). */
  static startTest(orgId: string, id: string, actionTaskId: string | null | undefined, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (p.state !== "approved_for_test") throw new Error("proposta não está aprovada para teste");
    return this.setState(orgId, id, "testing", { action_task_id: actionTaskId || null }, actorId, "MANAGER_SOLUTION_TESTING");
  }

  /**
   * Registra o RESULTADO do experimento (LEARN-004). Com métrica final +
   * confiança, a proposta fica `validated` (resultado ASSEGURADO); sem, segue
   * em teste. Nunca "valida sozinha" sem número.
   */
  static recordOutcome(orgId: string, id: string, input: { final?: number | null; confidence?: number | null; period?: string | null }, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (!["testing", "approved_for_test"].includes(p.state)) throw new Error("registre resultado só durante o teste");
    const final = num(input.final);
    const conf = num(input.confidence);
    const assured = final !== null && conf !== null && conf > 0;
    return this.setState(orgId, id, assured ? "validated" : "testing", {
      outcome_final: final, outcome_confidence: conf, outcome_period: input.period ? String(input.period).slice(0, 40) : null,
    }, actorId, "MANAGER_SOLUTION_OUTCOME");
  }

  /**
   * PROMOVE à memória de padrões (LEARN-005): só `validated`. Escreve uma linha
   * em `retail_store_patterns` (pattern_type 'manager_solution') com PROCEDÊNCIA;
   * revogável. Papel autorizado imposto na rota.
   */
  static promote(orgId: string, id: string, actorId: string | undefined, actorIsAuthorized: boolean): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (p.promoted_pattern_id) return p; // idempotente (já promovida)
    if (!actorIsAuthorized) throw new Error("apenas papel autorizado promove");
    if (p.state !== "validated") throw new Error("só proposta validada (com resultado assegurado) pode ir para a memória");
    const patternId = randomUUID();
    const evidence = {
      source: "manager_solution", proposalId: id, author_user_id: p.author_user_id,
      conditions: p.conditions, expectedMetric: p.expected_metric,
      baseline: p.baseline, final: p.outcome_final, confidence: p.outcome_confidence, period: p.outcome_period,
    };
    db.prepare(`
      INSERT INTO retail_store_patterns (id, organization_id, store_id, pattern_type, pattern_key, description, evidence_json, confidence, status, occurrences, created_by_type)
      VALUES (?, ?, ?, 'manager_solution', ?, ?, ?, ?, 'validated', 1, 'user')
    `).run(patternId, orgId, p.store_id || null, `solution:${id}`, p.title + " — " + p.proposal_text.slice(0, 400), JSON.stringify(evidence), num(p.outcome_confidence) ?? 0.5);
    const out = this.setState(orgId, id, "promoted", { promoted_pattern_id: patternId }, actorId, "MANAGER_SOLUTION_PROMOTED");
    return out;
  }

  /** Revoga uma proposta promovida: tira o padrão da recuperação confiável (dormant). */
  static revoke(orgId: string, id: string, reason: string | undefined, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (p.state !== "promoted") throw new Error("só proposta promovida pode ser revogada");
    if (p.promoted_pattern_id) {
      db.prepare(`UPDATE retail_store_patterns SET status = 'dormant', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, p.promoted_pattern_id);
    }
    return this.setState(orgId, id, "revoked", { rejection_reason: sanitizeText(reason || "", 300) || null }, actorId, "MANAGER_SOLUTION_REVOKED");
  }

  /** Rejeita a proposta (qualquer estado ativo) com motivo. */
  static reject(orgId: string, id: string, reason: string | undefined, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    if (["promoted", "revoked", "archived"].includes(p.state)) throw new Error("proposta não pode ser rejeitada neste estado");
    return this.setState(orgId, id, "rejected", { rejection_reason: sanitizeText(reason || "", 300) || null }, actorId, "MANAGER_SOLUTION_REJECTED");
  }

  static archive(orgId: string, id: string, actorId?: string): any {
    const p = this.get(orgId, id); if (!p) return null;
    return this.setState(orgId, id, "archived", {}, actorId, "MANAGER_SOLUTION_ARCHIVED");
  }
}
