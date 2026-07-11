// ZappFlow Edge — Aplicador do inbox (ADR-082, Fase 4c / Cloud→Edge).
//
// A Fase 4b guarda o delta puxado da nuvem em `edge_inbox` (applied=0). Aqui a
// reconciliação ACONTECE: cada evento é aplicado, em ordem de seq, na PROJEÇÃO
// local (`edge_aggregates`) — assim o nó tem o estado atual dos agregados
// (tickets, mensagens, pedidos…) consultável mesmo com a internet caída.
//
// Correção (ADR-007 D3, versionamento otimista): a projeção é last-write-wins
// pelo `seq` MONOTÔNICO por organização. Reaplicar um evento cujo seq <= o já
// projetado é no-op — então reentrega/reprocessamento nunca corrompe o estado.
//
// Materializar cada tipo em tabela DEDICADA (ex.: edge_messages com o conteúdo
// completo) exige eventos "gordos" (hoje os domain_events carregam referências,
// não o estado inteiro) e fica para quando os agregados emitirem payload cheio;
// a projeção genérica abaixo já reconcilia qualquer agregado sem depender disso.
import db from "./db.js";

/** Handler específico por agregado (registry). Recebe o estado atual e o evento. */
export type AggregateApplier = (state: any, event: InboxEvent) => any;
export type InboxEvent = { seq: number; aggregateType: string; aggregateId: string; eventType: string; payload: any };

const appliers = new Map<string, AggregateApplier>();

export class EdgeInboxApplicator {
  /** Registra um materializador para um aggregate_type (senão usa a projeção genérica). */
  static registerApplier(aggregateType: string, fn: AggregateApplier): void {
    appliers.set(aggregateType, fn);
  }

  /**
   * Aplica os eventos pendentes (applied=0) em ordem de seq. Idempotente:
   * `edge_inbox.applied` evita reprocessar, e a checagem de seq na projeção
   * evita regressão. Retorna o resumo.
   */
  static applyPending(limit = 1000): { applied: number; projected: number; skipped: number } {
    const summary = { applied: 0, projected: 0, skipped: 0 };
    const rows = db.prepare(
      `SELECT seq, aggregate_type, aggregate_id, event_type, payload_json
         FROM edge_inbox WHERE applied = 0 ORDER BY seq ASC LIMIT ?`
    ).all(limit) as any[];

    for (const r of rows) {
      const e: InboxEvent = {
        seq: Number(r.seq), aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
        eventType: r.event_type, payload: safeParse(r.payload_json),
      };
      try {
        if (e.aggregateId) {
          const done = this.project(e);
          if (done) summary.projected++; else summary.skipped++;
        }
        db.prepare(`UPDATE edge_inbox SET applied = 1 WHERE seq = ?`).run(e.seq);
        summary.applied++;
      } catch (err) {
        // Não marca applied → tenta de novo no próximo ciclo. Não derruba o loop.
        console.error("[edge] falha ao aplicar evento", e.seq, err);
      }
    }
    return summary;
  }

  /** Dobra um evento na projeção do agregado. Retorna false se for out-of-order (ignorado). */
  private static project(e: InboxEvent): boolean {
    const cur = db.prepare(
      `SELECT last_seq, state_json FROM edge_aggregates WHERE aggregate_type = ? AND aggregate_id = ?`
    ).get(e.aggregateType, e.aggregateId) as any;

    // Já projetamos um estado igual ou mais novo → não regride (idempotência/ordem).
    if (cur && Number(cur.last_seq) >= e.seq) return false;

    const prevState = cur ? safeParse(cur.state_json) || {} : {};
    const applier = appliers.get(e.aggregateType);
    const nextState = applier
      ? applier(prevState, e)                                   // materializador específico
      : { ...prevState, ...(e.payload || {}), lastEventType: e.eventType }; // projeção genérica (merge LWW)

    db.prepare(
      `INSERT INTO edge_aggregates (aggregate_type, aggregate_id, last_seq, last_event_type, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(aggregate_type, aggregate_id) DO UPDATE SET
         last_seq = excluded.last_seq, last_event_type = excluded.last_event_type,
         state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP`
    ).run(e.aggregateType, e.aggregateId, e.seq, e.eventType, JSON.stringify(nextState));
    return true;
  }

  /** Lê a projeção de um agregado (estado atual local). */
  static get(aggregateType: string, aggregateId: string): any | null {
    const row = db.prepare(
      `SELECT aggregate_type, aggregate_id, last_seq, last_event_type, state_json, updated_at
         FROM edge_aggregates WHERE aggregate_type = ? AND aggregate_id = ?`
    ).get(aggregateType, aggregateId) as any;
    if (!row) return null;
    return { ...row, state: safeParse(row.state_json) };
  }
}

function safeParse(s: any): any { try { return JSON.parse(s ?? "null"); } catch { return null; } }
