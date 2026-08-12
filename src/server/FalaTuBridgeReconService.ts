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
   * BACKFILL de tarefas: liga as `falatu_tasks` históricas SEM espelho canônico
   * (capturadas antes da flag) via `TaskService.create` — MESMO mapeamento da porta
   * viva. Só roda com a flag LIGADA (não bridgeia o que o dono não optou por bridgear);
   * idempotente (só o que está sem `bridged_task_id`); atômico por item. RN-151: não
   * inventa — usa title/description/user_id do próprio silo.
   */
  static backfillTasks(orgId: string, opts: { limit?: number } = {}): { ok: boolean; reason?: string; backfilled: number; remaining: number } {
    if (!this.flag(orgId, "falatu_bridge_tasks_enabled")) return { ok: false, reason: "bridge_disabled", backfilled: 0, remaining: 0 };
    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
    const rows = db.prepare(
      `SELECT id, user_id, title, description FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL ORDER BY created_at ASC LIMIT ?`
    ).all(orgId, limit) as any[];
    let backfilled = 0;
    for (const r of rows) {
      try {
        const canonical = TaskService.create(orgId, { title: r.title, description: r.description || undefined, source: "falatu" }, r.user_id);
        if (canonical?.id) { db.prepare(`UPDATE falatu_tasks SET bridged_task_id = ? WHERE id = ? AND organization_id = ?`).run(canonical.id, r.id, orgId); backfilled++; }
      } catch (e) { /* item ruim não derruba o lote; segue */ }
    }
    const remaining = this.n(`SELECT COUNT(*) n FROM falatu_tasks WHERE organization_id = ? AND bridged_task_id IS NULL`, orgId);
    return { ok: true, backfilled, remaining };
  }
}

export default FalaTuBridgeReconService;
