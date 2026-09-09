/**
 * FalaTuBridgeReconService (ADR-160 / Onda A D5, F10) — RECONCILIAÇÃO da porta I/O.
 *
 * As fatias F5–F9 fizeram o Fala Tu virar porta pro domínio canônico em DUAL-WRITE: o
 * silo (`falatu_tasks/events/lists`) e o canônico (`tasks`/`appointments`/
 * `purchase_requisitions`) coexistem, ligados por `bridged_*_id`. A remoção do silo é
 * evolução futura "quando o espelho canônico provar ESTÁVEL" (nota da D5). Esta fatia
 * entrega a PROVA: uma leitura de saúde da ponte — cobertura, elos QUEBRADOS (drift) e
 * prontidão — mais um BACKFILL pra ligar itens históricos capturados antes da flag.
 *
 * Tudo DERIVADO POR QUERY (RN-004), isolado por org (nº 1), aditivo/reversível (não toca
 * os stores). O backfill respeita o MESMO gate da porta viva (só com a flag ligada) e
 * espelha o MESMO mapeamento do `FalaTuService.confirm` (nunca inventa — RN-151).
 */
import db from "./db.js";
import { TaskService } from "./TaskService.js";
import { PurchaseRequisitionService } from "./PurchaseRequisitionService.js";

const round1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;

interface BridgeStat {
  enabled: boolean;
  total: number;
  bridged: number;
  unbridged: number;
  brokenLinks: number;   // vínculo aponta pra canônico inexistente (deletado) — drift
  coveragePct: number | null;
  ready: boolean;        // flag ON + tudo espelhado + zero drift → candidato à aposentadoria do silo
  note?: string;
}

export interface BridgeReconReport {
  generatedAt: string;
  bridges: { tasks: BridgeStat; events: BridgeStat; lists: BridgeStat };
  overallReady: boolean;
}

/**
 * Classificação POR REGISTRO (RF-09 §15.1). Determinística, derivada por query:
 * - linked_ok            → vínculo válido e coerente (reusar objeto/ID).
 * - linked_state_divergent → vínculo válido MAS estados diferem (ex.: tarefa
 *   concluída num lado e não no outro) — conflito de estado, resolver na
 *   convergência (F4.3). Só tarefas têm paridade de conclusão comparável aqui.
 * - broken_link          → vínculo aponta pra canônico inexistente (não recriar
 *   silenciosamente — registrar conflito).
 * - unlinked_migratable  → registro operacional sem vínculo, com dados
 *   suficientes pra migrar (tarefa; lista shopping).
 * - personal_only        → nota/evento pessoal sem equivalente operacional
 *   (preservar no silo; NÃO forçar tarefa/contato).
 * NÃO existe categoria "dois objetos possíveis" derivada por heurística: §15.1
 * proíbe deduplicar por título/valor/data — só com evidência de origem, que o
 * silo não guarda. Por isso não é inferida aqui.
 */
export type RecordClassification =
  | "linked_ok"
  | "linked_state_divergent"
  | "broken_link"
  | "unlinked_migratable"
  | "personal_only";

export interface ReconRecord {
  recordType: "task" | "event" | "list";
  id: string;
  title: string;
  bridged: boolean;
  bridgedId: string | null;
  canonicalExists: boolean;
  classification: RecordClassification;
  reason: string;
}

export interface RecordsReport {
  generatedAt: string;
  counts: Record<RecordClassification, number>;
  total: number;
  returned: number;
  offset: number;
  truncated: boolean; // total > offset + returned
  records: ReconRecord[];
}

export class FalaTuBridgeReconService {
  private static flag(orgId: string, col: string): boolean {
    const r = db.prepare(`SELECT COALESCE(${col}, 0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }
  private static n(sql: string, ...p: any[]): number { return (db.prepare(sql).get(...p) as any).n as number; }

  /** Saúde da ponte, por tipo. Derivado por query; não toca os stores. */
  static report(orgId: string): BridgeReconReport {
    // ── TASKS: espelho incondicional (toda tarefa confirmada deve ter canônico). ──
    const tEnabled = this.flag(orgId, "falatu_bridge_tasks_enabled");
    const tTotal = this.n(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ?`, orgId);
    const tBridged = this.n(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NOT NULL`, orgId);
    const tBroken = this.n(`SELECT COUNT(*) n FROM falatu_tasks f WHERE f.organization_id = ? AND f.bridged_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = f.bridged_task_id AND t.organization_id = f.organization_id)`, orgId);
    const tasks: BridgeStat = {
      enabled: tEnabled, total: tTotal, bridged: tBridged, unbridged: tTotal - tBridged, brokenLinks: tBroken,
      coveragePct: tTotal > 0 ? round1((tBridged / tTotal) * 100) : null,
      ready: tEnabled && tTotal - tBridged === 0 && tBroken === 0 && tTotal > 0,
    };

    // ── EVENTS: espelho é CONTACT-GATED (só com contato real + data/hora). Muitos ──
    // eventos são silo-only por design (lembrete pessoal), então "unbridged" NÃO é
    // drift — só reportamos cobertura sobre os que TÊM espelho + elos quebrados.
    const eEnabled = this.flag(orgId, "falatu_bridge_events_enabled");
    const eTotal = this.n(`SELECT COUNT(*) n FROM falatu_events WHERE organization_id = ?`, orgId);
    const eBridged = this.n(`SELECT COUNT(*) n FROM falatu_events WHERE organization_id = ? AND bridged_appointment_id IS NOT NULL`, orgId);
    const eBroken = this.n(`SELECT COUNT(*) n FROM falatu_events f WHERE f.organization_id = ? AND f.bridged_appointment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = f.bridged_appointment_id AND a.organization_id = f.organization_id)`, orgId);
    const events: BridgeStat = {
      enabled: eEnabled, total: eTotal, bridged: eBridged, unbridged: eTotal - eBridged, brokenLinks: eBroken,
      coveragePct: null, // cobertura não é significativa (contact-gated); só drift importa
      ready: eEnabled && eBroken === 0,
      note: "Eventos são contact-gated (RN-151): itens sem espelho são lembretes pessoais por design, não drift. Backfill não se aplica.",
    };

    // ── LISTS: só listas 'shopping' têm equivalente canônico (requisição). ──
    const lEnabled = this.flag(orgId, "falatu_bridge_lists_enabled");
    const lTotal = this.n(`SELECT COUNT(*) n FROM falatu_lists WHERE organization_id = ? AND list_type = 'shopping'`, orgId);
    const lBridged = this.n(`SELECT COUNT(*) n FROM falatu_lists WHERE organization_id = ? AND list_type = 'shopping' AND bridged_requisition_id IS NOT NULL`, orgId);
    const lBroken = this.n(`SELECT COUNT(*) n FROM falatu_lists f WHERE f.organization_id = ? AND f.list_type = 'shopping' AND f.bridged_requisition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_requisitions r WHERE r.id = f.bridged_requisition_id AND r.organization_id = f.organization_id)`, orgId);
    const lists: BridgeStat = {
      enabled: lEnabled, total: lTotal, bridged: lBridged, unbridged: lTotal - lBridged, brokenLinks: lBroken,
      coveragePct: lTotal > 0 ? round1((lBridged / lTotal) * 100) : null,
      ready: lEnabled && lBroken === 0,
      note: "Cobertura parcial é esperada: só itens que casam com o catálogo viram requisição (RN-151). Backfill de listas fica pra fatia futura.",
    };

    return {
      generatedAt: new Date().toISOString(),
      bridges: { tasks, events, lists },
      overallReady: tasks.ready && events.ready && lists.ready,
    };
  }

  /**
   * Relatório POR REGISTRO (RF-09 §15.1): classifica cada registro do silo numa
   * das situações da política de migração, para o operador RESOLVER vínculos e
   * conflitos antes de migrar/aposentar. Read-only, derivado por query (RN-004),
   * isolado por org. `counts` cobre TODA a população; `records` é o detalhe
   * paginado (offset/limit) na MESMA ordem (tasks→events→lists, created_at ASC).
   */
  static records(orgId: string, opts: { limit?: number; offset?: number } = {}): RecordsReport {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const CAP = 20000; // guarda de memória por tipo (report é gated owner/admin)

    const all: ReconRecord[] = [];

    // ── TASKS: sempre operacionais. Compara conclusão silo × canônico. ──
    const taskRows = db.prepare(
      `SELECT f.id, f.title, f.completed, f.bridged_task_id AS bid,
              t.id AS canon_id, t.status AS canon_status
         FROM falatu_tasks f
         LEFT JOIN tasks t ON t.id = f.bridged_task_id AND t.organization_id = f.organization_id
        WHERE f.organization_id = ? ORDER BY f.created_at ASC LIMIT ?`,
    ).all(orgId, CAP) as any[];
    for (const r of taskRows) {
      let classification: RecordClassification; let reason: string;
      if (!r.bid) { classification = "unlinked_migratable"; reason = "tarefa sem espelho canônico (candidata a backfill)"; }
      else if (!r.canon_id) { classification = "broken_link"; reason = "bridged_task_id aponta pra tarefa canônica inexistente"; }
      else {
        const siloDone = Number(r.completed) === 1;
        const canonDone = String(r.canon_status) === "feito";
        if (siloDone !== canonDone) { classification = "linked_state_divergent"; reason = `conclusão diverge (silo ${siloDone ? "feita" : "aberta"} × canônico ${canonDone ? "feito" : String(r.canon_status)})`; }
        else { classification = "linked_ok"; reason = "vínculo válido e coerente"; }
      }
      all.push({ recordType: "task", id: r.id, title: r.title || "", bridged: !!r.bid, bridgedId: r.bid || null, canonicalExists: !!r.canon_id, classification, reason });
    }

    // ── EVENTS: contact-gated. Sem espelho = lembrete pessoal por design (o silo ──
    // não guarda contato pra afirmar migrabilidade). Só drift importa.
    const eventRows = db.prepare(
      `SELECT f.id, f.title, f.event_date, f.event_time, f.bridged_appointment_id AS bid,
              a.id AS canon_id
         FROM falatu_events f
         LEFT JOIN appointments a ON a.id = f.bridged_appointment_id AND a.organization_id = f.organization_id
        WHERE f.organization_id = ? ORDER BY f.created_at ASC LIMIT ?`,
    ).all(orgId, CAP) as any[];
    for (const r of eventRows) {
      let classification: RecordClassification; let reason: string;
      if (!r.bid) { classification = "personal_only"; reason = "evento sem espelho: lembrete pessoal por design (contact-gated)"; }
      else if (!r.canon_id) { classification = "broken_link"; reason = "bridged_appointment_id aponta pra agendamento inexistente"; }
      else { classification = "linked_ok"; reason = "vínculo válido e coerente"; }
      all.push({ recordType: "event", id: r.id, title: r.title || "", bridged: !!r.bid, bridgedId: r.bid || null, canonicalExists: !!r.canon_id, classification, reason });
    }

    // ── LISTS: só 'shopping' têm equivalente (requisição); demais são pessoais. ──
    const listRows = db.prepare(
      `SELECT f.id, f.title, f.list_type, f.bridged_requisition_id AS bid,
              r.id AS canon_id
         FROM falatu_lists f
         LEFT JOIN purchase_requisitions r ON r.id = f.bridged_requisition_id AND r.organization_id = f.organization_id
        WHERE f.organization_id = ? ORDER BY f.created_at ASC LIMIT ?`,
    ).all(orgId, CAP) as any[];
    for (const r of listRows) {
      let classification: RecordClassification; let reason: string;
      if (String(r.list_type) !== "shopping") { classification = "personal_only"; reason = `lista '${r.list_type}' não tem equivalente operacional (só shopping)`; }
      else if (!r.bid) { classification = "unlinked_migratable"; reason = "lista de compras sem requisição (backfill de listas é fatia futura)"; }
      else if (!r.canon_id) { classification = "broken_link"; reason = "bridged_requisition_id aponta pra requisição inexistente"; }
      else { classification = "linked_ok"; reason = "vínculo válido e coerente"; }
      all.push({ recordType: "list", id: r.id, title: r.title || "", bridged: !!r.bid, bridgedId: r.bid || null, canonicalExists: !!r.canon_id, classification, reason });
    }

    const counts: Record<RecordClassification, number> = {
      linked_ok: 0, linked_state_divergent: 0, broken_link: 0, unlinked_migratable: 0, personal_only: 0,
    };
    for (const rec of all) counts[rec.classification]++;

    const page = all.slice(offset, offset + limit);
    return {
      generatedAt: new Date().toISOString(),
      counts, total: all.length, returned: page.length, offset,
      truncated: all.length > offset + page.length,
      records: page,
    };
  }

  /**
   * BACKFILL de tarefas: liga as `falatu_tasks` históricas SEM espelho canônico
   * (capturadas antes da flag) via `TaskService.create` — MESMO mapeamento da porta
   * viva. Só roda com a flag LIGADA (não bridgeia o que o dono não optou por bridgear);
   * idempotente (só o que está sem `bridged_task_id`); atômico por item. RN-151: não
   * inventa — usa title/description/user_id do próprio silo.
   */
  static backfillTasks(orgId: string, opts: { limit?: number; dryRun?: boolean } = {}): { ok: boolean; reason?: string; dryRun: boolean; backfilled: number; wouldBackfill: number; remaining: number } {
    if (!this.flag(orgId, "falatu_bridge_tasks_enabled")) return { ok: false, reason: "bridge_disabled", dryRun: !!opts.dryRun, backfilled: 0, wouldBackfill: 0, remaining: 0 };
    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
    const rows = db.prepare(
      `SELECT id, user_id, title, description FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL ORDER BY created_at ASC LIMIT ?`
    ).all(orgId, limit) as any[];

    // DRY-RUN (§15.1/RF-09 "modo de simulação"): NÃO cria canônico, NÃO carimba,
    // NÃO grava checkpoint — só relata o que FARIA. Zero efeito externo.
    if (opts.dryRun) {
      const remaining = this.n(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL`, orgId);
      return { ok: true, dryRun: true, backfilled: 0, wouldBackfill: rows.length, remaining };
    }

    let backfilled = 0;
    for (const r of rows) {
      try {
        const canonical = TaskService.create(orgId, { title: r.title, description: r.description || undefined, source: "falatu" }, r.user_id);
        if (canonical?.id) { db.prepare(`UPDATE falatu_tasks SET bridged_task_id = ? WHERE id = ? AND organization_id = ?`).run(canonical.id, r.id, orgId); backfilled++; }
      } catch (e) { /* item ruim não derruba o lote; segue */ }
    }
    const remaining = this.n(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL`, orgId);
    this.recordRun(orgId, "tasks", backfilled, remaining);
    return { ok: true, dryRun: false, backfilled, wouldBackfill: rows.length, remaining };
  }

  /**
   * BACKFILL de listas de COMPRAS históricas (RF-09 §15.2): liga `falatu_lists`
   * `shopping` SEM requisição via o MESMO caminho da porta viva (F7) —
   * `matchItemsToProducts` + `addManualItems` (draft; humano aprova). Só itens
   * que CASAM com o catálogo viram linhas (RN-151, nunca inventa produto); uma
   * lista sem match não vira requisição e NÃO é carimbada (fica candidata).
   * Idempotente (só `bridged_requisition_id IS NULL`); dry-run sem efeitos.
   */
  static backfillLists(orgId: string, opts: { limit?: number; dryRun?: boolean } = {}): { ok: boolean; reason?: string; dryRun: boolean; backfilled: number; wouldBackfill: number; remaining: number } {
    if (!this.flag(orgId, "falatu_bridge_lists_enabled")) return { ok: false, reason: "bridge_disabled", dryRun: !!opts.dryRun, backfilled: 0, wouldBackfill: 0, remaining: 0 };
    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
    const rows = db.prepare(
      `SELECT id, user_id FROM falatu_lists WHERE organization_id = ? AND list_type = 'shopping' AND bridged_requisition_id IS NULL ORDER BY created_at ASC LIMIT ?`
    ).all(orgId, limit) as any[];
    const remainingNow = () => this.n(`SELECT COUNT(*) n FROM falatu_lists WHERE organization_id = ? AND list_type = 'shopping' AND bridged_requisition_id IS NULL`, orgId);

    if (opts.dryRun) return { ok: true, dryRun: true, backfilled: 0, wouldBackfill: rows.length, remaining: remainingNow() };

    let backfilled = 0;
    for (const r of rows) {
      try {
        const items = db.prepare(`SELECT name FROM falatu_list_items WHERE organization_id = ? AND list_id = ?`).all(orgId, r.id) as any[];
        if (!items.length) continue; // lista vazia → não vira requisição
        const { matched } = PurchaseRequisitionService.matchItemsToProducts(orgId, items.map((it) => ({ name: String(it.name).trim() })));
        if (!matched.length) continue; // nenhum item casa o catálogo → fica candidata (RN-151)
        const req = PurchaseRequisitionService.addManualItems(orgId, matched.map((m: any) => ({ productServiceId: m.productServiceId, quantity: m.quantity })), r.user_id);
        if (req?.id) { db.prepare(`UPDATE falatu_lists SET bridged_requisition_id = ? WHERE id = ? AND organization_id = ?`).run(req.id, r.id, orgId); backfilled++; }
      } catch (e) { /* item ruim não derruba o lote; segue */ }
    }
    const remaining = remainingNow();
    this.recordRun(orgId, "lists", backfilled, remaining);
    return { ok: true, dryRun: false, backfilled, wouldBackfill: rows.length, remaining };
  }

  /**
   * Eventos NÃO são backfilláveis: o espelho canônico (appointment) exige contato
   * real + data + hora, e o silo NÃO guarda contato — fabricar seria inventar
   * (RN-151). Eventos sem espelho são lembretes pessoais por design (§15.1).
   * Honesto: no-op explícito.
   */
  static backfillEvents(_orgId: string): { ok: boolean; reason: string; dryRun: boolean; backfilled: number; wouldBackfill: number; remaining: number } {
    return { ok: false, reason: "not_applicable_contact_gated", dryRun: false, backfilled: 0, wouldBackfill: 0, remaining: 0 };
  }

  /** Contabilidade/checkpoint por (org, tipo). Só execuções REAIS gravam. */
  private static recordRun(orgId: string, kind: "tasks" | "lists", migrated: number, remaining: number): void {
    try {
      db.prepare(
        `INSERT INTO falatu_bridge_backfill_state (organization_id, kind, migrated_total, runs, last_run_migrated, last_run_remaining, last_run_at)
         VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(organization_id, kind) DO UPDATE SET
           migrated_total = migrated_total + excluded.migrated_total,
           runs = runs + 1,
           last_run_migrated = excluded.last_run_migrated,
           last_run_remaining = excluded.last_run_remaining,
           last_run_at = CURRENT_TIMESTAMP`,
      ).run(orgId, kind, migrated, migrated, remaining);
    } catch (e) { console.error("[FalaTuBridgeRecon] recordRun falhou (best-effort)", e); }
  }

  /** Estado do backfill (checkpoint/contagens) por tipo. Read-only. */
  static backfillState(orgId: string): { tasks: any | null; lists: any | null } {
    const get = (kind: string) => db.prepare(`SELECT kind, migrated_total, runs, last_run_migrated, last_run_remaining, last_run_at FROM falatu_bridge_backfill_state WHERE organization_id = ? AND kind = ?`).get(orgId, kind) || null;
    return { tasks: get("tasks"), lists: get("lists") };
  }
}

export default FalaTuBridgeReconService;
