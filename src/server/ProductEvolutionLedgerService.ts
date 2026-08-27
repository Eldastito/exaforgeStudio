/**
 * ProductEvolutionLedgerService — ADR-193 F1.
 *
 * CRUD determinístico do Product Evolution Ledger. GLOBAL, Admin Master only:
 * nenhum método recebe `orgId` — o ledger vive fora do isolamento multi-tenant
 * porque é ferramenta interna de produto/engenharia (§4/PEL-07 do PRD-PEL-01).
 *
 * Regras codificadas aqui:
 *
 *   RN-PEL-1  evolution_key imutável e casa `^[A-Z][A-Z0-9_]{2,63}$`.
 *   RN-PEL-2  sem organization_id em nenhuma das tabelas (RN de escopo).
 *   RN-PEL-3  transição de estado obedece o grafo (STATUS_GRAPH abaixo).
 *   RN-PEL-4  VALIDATED requer ≥1 evidência com verified=1.
 *   RN-PEL-5  SUPERSEDED requer superseded_by preenchido.
 *   RN-PEL-6  evidence_type e source_type restritos aos enums de CONVENCOES.md.
 *
 * Sem LLM. Se a reconciliação futura precisar sugerir estado, será um serviço
 * separado (ADR-193 §8 remete a F3). Aqui só existe transição validada.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

// --- Constantes ---
export const EVOLUTION_KEY_REGEX = /^[A-Z][A-Z0-9_]{2,63}$/;

export const STATUSES = [
  "IDEA", "ANALYZED", "PRD_READY", "APPROVED", "IMPLEMENTING",
  "CODED", "TESTED", "PILOT", "PRODUCTION", "VALIDATED",
  "DEFERRED", "REJECTED", "SUPERSEDED",
] as const;
export type Status = typeof STATUSES[number];

// Grafo de transições permitidas (RN-PEL-3). Linear + terminais alternativos.
// SUPERSEDED, DEFERRED, REJECTED podem sair de qualquer estado ativo.
const STATUS_GRAPH: Record<Status, Status[]> = {
  IDEA:         ["ANALYZED", "DEFERRED", "REJECTED"],
  ANALYZED:     ["PRD_READY", "IDEA", "DEFERRED", "REJECTED"],
  PRD_READY:    ["APPROVED", "ANALYZED", "DEFERRED", "REJECTED"],
  APPROVED:     ["IMPLEMENTING", "DEFERRED", "REJECTED"],
  IMPLEMENTING: ["CODED", "APPROVED", "DEFERRED", "REJECTED", "SUPERSEDED"],
  CODED:        ["TESTED", "IMPLEMENTING", "SUPERSEDED"],
  TESTED:       ["PILOT", "PRODUCTION", "CODED", "SUPERSEDED"],
  PILOT:        ["PRODUCTION", "TESTED", "SUPERSEDED"],
  PRODUCTION:   ["VALIDATED", "PILOT", "SUPERSEDED"],
  VALIDATED:    ["SUPERSEDED"], // uma vez validado, só substitui
  DEFERRED:     ["IDEA", "ANALYZED", "PRD_READY", "APPROVED"], // pode retomar
  REJECTED:     [], // terminal absoluto
  SUPERSEDED:   [], // terminal absoluto
};

export const EVIDENCE_TYPES = [
  "code", "migration", "route", "ui", "test", "test_run",
  "pr", "commit", "rollout", "production_check", "runbook",
  "metric", "customer_validation",
] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

export const SOURCE_TYPES = [
  "chat", "prd", "adr", "file", "github_pr", "github_commit",
  "issue", "meeting", "manual", "external_repository",
] as const;
export type SourceType = typeof SOURCE_TYPES[number];

// --- Tipos ---
export interface Item {
  id: string;
  evolution_key: string;
  title: string;
  domain: string | null;
  summary: string | null;
  status: Status;
  priority: string | null;
  risk_level: string | null;
  owner_user_id: string | null;
  source_of_truth: string | null;
  target_release: string | null;
  blocked_reason: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  archived_at: string | null;
}

export interface Evidence {
  id: string;
  item_id: string;
  evidence_type: EvidenceType;
  reference: string;
  description: string | null;
  verified: number; // 0/1
  verified_by: string | null;
  verified_at: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface Source {
  id: string;
  item_id: string;
  source_type: SourceType;
  title: string;
  source_date: string | null;
  source_reference: string | null;
  external_url: string | null;
  file_ref: string | null;
  notes: string | null;
  created_at: string;
}

// --- Erros tipados (rotas convertem em 400/404/etc.) ---
export class LedgerValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LedgerValidationError";
  }
}
export class LedgerNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = "LedgerNotFoundError"; }
}

export class ProductEvolutionLedgerService {

  // ═══════════════ Items ═══════════════

  static createItem(input: {
    evolution_key: string;
    title: string;
    domain?: string | null;
    summary?: string | null;
    priority?: string | null;
    risk_level?: string | null;
    owner_user_id?: string | null;
    source_of_truth?: string | null;
    target_release?: string | null;
  }): Item {
    if (!EVOLUTION_KEY_REGEX.test(input.evolution_key)) {
      throw new LedgerValidationError("invalid_key",
        `evolution_key inválido: ${input.evolution_key}. Formato esperado: ${EVOLUTION_KEY_REGEX.source}`);
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new LedgerValidationError("missing_title", "title é obrigatório");
    }
    const existing = db.prepare("SELECT id FROM product_evolution_items WHERE evolution_key = ?")
      .get(input.evolution_key) as any;
    if (existing) {
      throw new LedgerValidationError("duplicate_key", `evolution_key já existe: ${input.evolution_key}`);
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO product_evolution_items
        (id, evolution_key, title, domain, summary, status, priority, risk_level, owner_user_id, source_of_truth, target_release)
      VALUES (?, ?, ?, ?, ?, 'IDEA', ?, ?, ?, ?, ?)
    `).run(
      id, input.evolution_key, input.title.trim(),
      input.domain ?? null, input.summary ?? null,
      input.priority ?? null, input.risk_level ?? null,
      input.owner_user_id ?? null, input.source_of_truth ?? null,
      input.target_release ?? null,
    );
    return this.getItem(input.evolution_key)!;
  }

  static getItem(evolution_key: string): Item | null {
    const row = db.prepare("SELECT * FROM product_evolution_items WHERE evolution_key = ?")
      .get(evolution_key) as any;
    return row || null;
  }

  static listItems(filters: {
    status?: Status;
    domain?: string;
    q?: string; // busca em title/summary
  } = {}): Item[] {
    const conds: string[] = [];
    const params: any[] = [];
    if (filters.status) { conds.push("status = ?"); params.push(filters.status); }
    if (filters.domain) { conds.push("domain = ?"); params.push(filters.domain); }
    if (filters.q) {
      conds.push("(LOWER(title) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ?)");
      const like = `%${filters.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return db.prepare(`SELECT * FROM product_evolution_items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Item[];
  }

  /**
   * PATCH parcial. NUNCA aceita evolution_key nem status (transição vai por
   * setStatus). Ignora campos undefined; null explícito limpa a coluna.
   */
  static updateItem(evolution_key: string, patch: Partial<Pick<Item,
    "title" | "domain" | "summary" | "priority" | "risk_level"
    | "owner_user_id" | "source_of_truth" | "target_release" | "blocked_reason"
  >>): Item {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    const fields: string[] = [];
    const params: any[] = [];
    const allowed: (keyof typeof patch)[] = [
      "title", "domain", "summary", "priority", "risk_level",
      "owner_user_id", "source_of_truth", "target_release", "blocked_reason",
    ];
    for (const k of allowed) {
      if (k in patch) { fields.push(`${k} = ?`); params.push(patch[k] ?? null); }
    }
    if (fields.length === 0) return item; // no-op
    fields.push("updated_at = CURRENT_TIMESTAMP");
    params.push(evolution_key);
    db.prepare(`UPDATE product_evolution_items SET ${fields.join(", ")} WHERE evolution_key = ?`)
      .run(...params);
    return this.getItem(evolution_key)!;
  }

  /**
   * Transição de estado. Aplica RN-PEL-3/4/5.
   * `reason` é obrigatório (auditoria mínima; F1.5 escreve num histórico).
   * `superseded_by` vira NOT NULL só quando new_status = SUPERSEDED.
   */
  static setStatus(evolution_key: string, input: {
    new_status: Status;
    reason: string;
    superseded_by?: string | null;
  }): Item {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    if (!STATUSES.includes(input.new_status)) {
      throw new LedgerValidationError("invalid_status", `Estado inválido: ${input.new_status}`);
    }
    if (!input.reason || input.reason.trim().length === 0) {
      throw new LedgerValidationError("missing_reason", "reason é obrigatório em transição de estado");
    }
    if (item.status === input.new_status) return item; // no-op
    const allowed = STATUS_GRAPH[item.status as Status];
    if (!allowed.includes(input.new_status)) {
      throw new LedgerValidationError("invalid_transition",
        `Transição inválida: ${item.status} → ${input.new_status}. Permitidas: ${allowed.join(", ") || "(nenhuma — terminal)"}`);
    }
    // RN-PEL-4
    if (input.new_status === "VALIDATED") {
      const has = db.prepare(
        "SELECT 1 FROM product_evolution_evidence WHERE item_id = ? AND verified = 1 LIMIT 1"
      ).get(item.id);
      if (!has) {
        throw new LedgerValidationError("no_verified_evidence",
          "VALIDATED requer ≥1 evidência verificada (RN-PEL-4)");
      }
    }
    // RN-PEL-5
    let supersededBy: string | null = null;
    if (input.new_status === "SUPERSEDED") {
      if (!input.superseded_by || input.superseded_by.trim().length === 0) {
        throw new LedgerValidationError("missing_superseded_by",
          "SUPERSEDED requer superseded_by (RN-PEL-5)");
      }
      // valida que a chave existe
      const target = this.getItem(input.superseded_by);
      if (!target) {
        throw new LedgerValidationError("invalid_superseded_by",
          `superseded_by não encontrado: ${input.superseded_by}`);
      }
      supersededBy = input.superseded_by;
    }
    db.prepare(`
      UPDATE product_evolution_items
      SET status = ?, superseded_by = ?, updated_at = CURRENT_TIMESTAMP,
          validated_at = CASE WHEN ? = 'VALIDATED' THEN CURRENT_TIMESTAMP ELSE validated_at END
      WHERE evolution_key = ?
    `).run(input.new_status, supersededBy, input.new_status, evolution_key);

    // ADR-193 F1.5 — grava review imutável. Fonte de verdade da progressão.
    // Snapshot das evidências verificadas no momento da transição — útil para
    // o Reconciliation Engine (F3+) auditar por que um item chegou a VALIDATED.
    try {
      const snapshot = this.listEvidence(evolution_key).map(e => ({
        id: e.id,
        evidence_type: e.evidence_type,
        reference: e.reference,
        verified: e.verified,
      }));
      db.prepare(`
        INSERT INTO product_evolution_reviews (id, item_id, previous_status, new_status, reason, evidence_snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), item.id, item.status, input.new_status, input.reason.trim(), JSON.stringify(snapshot));
    } catch (e) {
      // Best-effort — não falha a transição se o review não conseguir gravar.
      // A tabela pode não existir em migrations antigas; o setStatus principal
      // já aconteceu com sucesso.
      console.error("[PEL] falha ao gravar review (transição já efetivada)", e);
    }

    return this.getItem(evolution_key)!;
  }

  // ═══════════════ Evidence ═══════════════

  static addEvidence(evolution_key: string, input: {
    evidence_type: EvidenceType;
    reference: string;
    description?: string | null;
    metadata_json?: string | null;
  }): Evidence {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    if (!EVIDENCE_TYPES.includes(input.evidence_type)) {
      throw new LedgerValidationError("invalid_evidence_type",
        `evidence_type inválido: ${input.evidence_type}. Aceitos: ${EVIDENCE_TYPES.join(", ")}`);
    }
    if (!input.reference || input.reference.trim().length === 0) {
      throw new LedgerValidationError("missing_reference", "reference é obrigatório");
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO product_evolution_evidence
        (id, item_id, evidence_type, reference, description, verified, metadata_json)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(id, item.id, input.evidence_type, input.reference.trim(),
      input.description ?? null, input.metadata_json ?? null);
    return db.prepare("SELECT * FROM product_evolution_evidence WHERE id = ?").get(id) as Evidence;
  }

  static listEvidence(evolution_key: string): Evidence[] {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    return db.prepare(
      "SELECT * FROM product_evolution_evidence WHERE item_id = ? ORDER BY created_at DESC"
    ).all(item.id) as Evidence[];
  }

  /**
   * Marca uma evidência como verified=1. Idempotente (re-verify por outro
   * usuário atualiza verified_by/verified_at).
   */
  static verifyEvidence(evidence_id: string, verified_by: string): Evidence {
    if (!verified_by || verified_by.trim().length === 0) {
      throw new LedgerValidationError("missing_verified_by", "verified_by é obrigatório");
    }
    const evid = db.prepare("SELECT * FROM product_evolution_evidence WHERE id = ?")
      .get(evidence_id) as any;
    if (!evid) throw new LedgerNotFoundError(`Evidência não encontrada: ${evidence_id}`);
    db.prepare(`
      UPDATE product_evolution_evidence
      SET verified = 1, verified_by = ?, verified_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(verified_by.trim(), evidence_id);
    return db.prepare("SELECT * FROM product_evolution_evidence WHERE id = ?").get(evidence_id) as Evidence;
  }

  // ═══════════════ Sources ═══════════════

  static addSource(evolution_key: string, input: {
    source_type: SourceType;
    title: string;
    source_date?: string | null;
    source_reference?: string | null;
    external_url?: string | null;
    file_ref?: string | null;
    notes?: string | null;
  }): Source {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    if (!SOURCE_TYPES.includes(input.source_type)) {
      throw new LedgerValidationError("invalid_source_type",
        `source_type inválido: ${input.source_type}. Aceitos: ${SOURCE_TYPES.join(", ")}`);
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new LedgerValidationError("missing_title", "title é obrigatório na fonte");
    }
    const id = uuidv4();
    db.prepare(`
      INSERT INTO product_evolution_sources
        (id, item_id, source_type, title, source_date, source_reference, external_url, file_ref, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, item.id, input.source_type, input.title.trim(),
      input.source_date ?? null, input.source_reference ?? null,
      input.external_url ?? null, input.file_ref ?? null, input.notes ?? null);
    return db.prepare("SELECT * FROM product_evolution_sources WHERE id = ?").get(id) as Source;
  }

  static listSources(evolution_key: string): Source[] {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    return db.prepare(
      "SELECT * FROM product_evolution_sources WHERE item_id = ? ORDER BY created_at DESC"
    ).all(item.id) as Source[];
  }

  // ═══════════════ Gaps view ═══════════════

  /**
   * Filtro pré-canned: items em estados "gap" (não IDEA/ANALYZED, mas fora de
   * PILOT/PRODUCTION/VALIDATED) que ainda não têm evidência verificada. Usado
   * pela aba Gaps da futura F2. Ordenado por prioridade (P0 primeiro).
   */
  static gaps(): Item[] {
    return db.prepare(`
      SELECT i.*
      FROM product_evolution_items i
      WHERE i.status IN ('PRD_READY', 'APPROVED', 'IMPLEMENTING', 'CODED', 'TESTED')
        AND NOT EXISTS (
          SELECT 1 FROM product_evolution_evidence e
          WHERE e.item_id = i.id AND e.verified = 1
        )
        AND i.archived_at IS NULL
      ORDER BY
        CASE i.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
        i.updated_at DESC
    `).all() as Item[];
  }

  // ═══════════════ Reviews (ADR-193 F1.5) ═══════════════

  /**
   * Histórico imutável de transições de um item. Ordenado por mais recente
   * primeiro. Cada linha vem com evidence_snapshot deserializado.
   */
  static listReviews(evolution_key: string): Array<{
    id: string; item_id: string; previous_status: Status; new_status: Status;
    reason: string; evidence_snapshot: any[]; reviewer_user_id: string | null;
    created_at: string;
  }> {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    // Ordena por rowid DESC (ordem de inserção reversa) — tie-break estável
    // quando várias transições caem no mesmo segundo do created_at.
    const rows = db.prepare(
      "SELECT * FROM product_evolution_reviews WHERE item_id = ? ORDER BY rowid DESC"
    ).all(item.id) as any[];
    return rows.map(r => ({
      id: r.id,
      item_id: r.item_id,
      previous_status: r.previous_status,
      new_status: r.new_status,
      reason: r.reason,
      evidence_snapshot: r.evidence_snapshot_json ? JSON.parse(r.evidence_snapshot_json) : [],
      reviewer_user_id: r.reviewer_user_id,
      created_at: r.created_at,
    }));
  }

  // ═══════════════ Dependencies (ADR-193 F1.5) ═══════════════

  /**
   * Adiciona uma aresta no grafo de dependências. Idempotente por UNIQUE
   * (item_id, depends_on_item_id, dependency_type). Rejeita self-loops
   * (item não pode depender de si mesmo).
   */
  static addDependency(input: {
    evolution_key: string;
    depends_on_key: string;
    dependency_type: 'requires' | 'enhances' | 'blocks' | 'related';
    notes?: string | null;
  }): {
    id: string; item_id: string; depends_on_item_id: string;
    dependency_type: string; notes: string | null; created_at: string;
  } {
    const ALLOWED = ['requires', 'enhances', 'blocks', 'related'] as const;
    if (!ALLOWED.includes(input.dependency_type)) {
      throw new LedgerValidationError("invalid_dependency_type",
        `dependency_type inválido: ${input.dependency_type}. Aceitos: ${ALLOWED.join(', ')}`);
    }
    if (input.evolution_key === input.depends_on_key) {
      throw new LedgerValidationError("self_dependency",
        "item não pode depender de si mesmo");
    }
    const from = this.getItem(input.evolution_key);
    if (!from) throw new LedgerNotFoundError(`Item não encontrado: ${input.evolution_key}`);
    const to = this.getItem(input.depends_on_key);
    if (!to) throw new LedgerNotFoundError(`Item alvo não encontrado: ${input.depends_on_key}`);

    // Verifica se já existe (idempotente)
    const existing = db.prepare(
      "SELECT * FROM product_evolution_dependencies WHERE item_id = ? AND depends_on_item_id = ? AND dependency_type = ?"
    ).get(from.id, to.id, input.dependency_type) as any;
    if (existing) return existing;

    const id = uuidv4();
    db.prepare(`
      INSERT INTO product_evolution_dependencies (id, item_id, depends_on_item_id, dependency_type, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, from.id, to.id, input.dependency_type, input.notes ?? null);
    return db.prepare("SELECT * FROM product_evolution_dependencies WHERE id = ?").get(id) as any;
  }

  /**
   * Lista dependências de/para o item. Retorna arestas saindo (this→other) e
   * chegando (other→this) — útil para a UI mostrar "depende de X" e "X depende
   * disso".
   */
  static listDependencies(evolution_key: string): {
    outgoing: Array<{ id: string; depends_on_key: string; depends_on_title: string; dependency_type: string; notes: string | null; created_at: string; }>;
    incoming: Array<{ id: string; item_key: string; item_title: string; dependency_type: string; notes: string | null; created_at: string; }>;
  } {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);

    const outgoing = db.prepare(`
      SELECT d.id, d.dependency_type, d.notes, d.created_at,
             i.evolution_key AS depends_on_key, i.title AS depends_on_title
      FROM product_evolution_dependencies d
      JOIN product_evolution_items i ON i.id = d.depends_on_item_id
      WHERE d.item_id = ?
      ORDER BY d.created_at DESC
    `).all(item.id) as any[];

    const incoming = db.prepare(`
      SELECT d.id, d.dependency_type, d.notes, d.created_at,
             i.evolution_key AS item_key, i.title AS item_title
      FROM product_evolution_dependencies d
      JOIN product_evolution_items i ON i.id = d.item_id
      WHERE d.depends_on_item_id = ?
      ORDER BY d.created_at DESC
    `).all(item.id) as any[];

    return { outgoing, incoming };
  }

  /**
   * Remove uma dependência por id. Retorna true se removeu, false se não existia.
   */
  static removeDependency(id: string): boolean {
    const result = db.prepare(
      "DELETE FROM product_evolution_dependencies WHERE id = ?"
    ).run(id);
    return result.changes > 0;
  }

  // ═══════════════ Seed helpers (ADR-193 F5) ═══════════════

  /**
   * Avança um item pelo grafo até `target_status`, respeitando as transições
   * permitidas. Usado por scripts de seed que precisam levar um item recém-
   * criado (IDEA) até um estado observável (ex.: PILOT/PRODUCTION) sem
   * repetir chamadas manuais de setStatus.
   *
   * NÃO tenta atingir VALIDATED (requer evidência verificada — RN-PEL-4).
   * Se `target_status` == VALIDATED, para em PRODUCTION.
   *
   * Idempotente: se já está no target_status ou além, retorna sem mudar.
   * Se o caminho não existir (ex.: item já REJECTED), retorna sem mudar.
   */
  static seedProgressTo(evolution_key: string, target_status: Status, reason: string): Item {
    const item = this.getItem(evolution_key);
    if (!item) throw new LedgerNotFoundError(`Item não encontrado: ${evolution_key}`);
    if (item.status === target_status) return item;
    // VALIDATED requer evidência — parar em PRODUCTION se alvo é VALIDATED
    const effectiveTarget: Status = target_status === "VALIDATED" ? "PRODUCTION" : target_status;
    if (item.status === effectiveTarget) return item;

    // BFS no grafo pra achar caminho mais curto (evita revisitar).
    const visited = new Set<Status>([item.status as Status]);
    const parent = new Map<Status, Status>();
    const queue: Status[] = [item.status as Status];
    let found = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === effectiveTarget) { found = true; break; }
      for (const next of (STATUS_GRAPH[cur] || [])) {
        if (visited.has(next)) continue;
        // Não passa por SUPERSEDED (precisa superseded_by) nem VALIDATED (precisa evid)
        if (next === "SUPERSEDED" || next === "VALIDATED") continue;
        visited.add(next);
        parent.set(next, cur);
        queue.push(next);
      }
    }
    if (!found) return item; // sem caminho — retorna sem mudar (idempotente)

    // Reconstrói caminho
    const path: Status[] = [effectiveTarget];
    let step: Status | undefined = effectiveTarget;
    while (step && step !== item.status) {
      const p = parent.get(step);
      if (!p) break;
      path.unshift(p);
      step = p;
    }

    // Avança passo a passo
    let last = item;
    for (let i = 1; i < path.length; i++) {
      last = this.setStatus(evolution_key, { new_status: path[i], reason });
    }
    return last;
  }
}

export default ProductEvolutionLedgerService;
