// ZappFlow Edge — Cliente de sync (ADR-082, Fase 4b).
//
// Orquestra UM ciclo de sincronização do nó contra o protocolo Cloud da Fase 4a:
//   1) heartbeat  — presença + versão do agente; devolve o cursor do servidor.
//   2) push       — drena o outbox local (comandos feitos offline) para a nuvem.
//   3) pull        — puxa o delta de domain_events após o cursor do nó e guarda
//                    no edge_inbox (aplicar por agregado é a Fase 4c).
//
// O transporte é PLUGÁVEL: em produção `HttpEdgeTransport` fala HTTP com a
// nuvem (headers X-Edge-Device/X-Edge-Key); nos testes injeta-se um transporte
// in-process que chama o EdgeSyncService real — assim o ciclo é testável offline.
import db from "./db.js";
import { EdgeOutbox, type EdgeCommand } from "./EdgeOutbox.js";
import { EdgeInboxApplicator } from "./EdgeInboxApplicator.js";

export type PullResponse = { events: any[]; cursor: number; hasMore: boolean };
export type PushResponse = { results: { commandId: string; status: "accepted" | "deduped" | "rejected" }[]; accepted?: number; deduped?: number; rejected?: number };
export type HeartbeatResponse = { ok: boolean; serverCursor: number };

export interface EdgeTransport {
  pull(after: number, limit: number): Promise<PullResponse>;
  push(commands: EdgeCommand[]): Promise<PushResponse>;
  heartbeat(agentVersion?: string): Promise<HeartbeatResponse>;
}

// ── Estado local do nó (key/value em edge_state) ────────────────────────────
export function getCursor(): number {
  const row = db.prepare(`SELECT value FROM edge_state WHERE key = 'cursor'`).get() as any;
  return Number(row?.value || 0);
}
function setState(key: string, value: string): void {
  db.prepare(`INSERT INTO edge_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// ── Transporte HTTP real (produção) ─────────────────────────────────────────
export class HttpEdgeTransport implements EdgeTransport {
  constructor(private cfg: { cloudUrl: string; deviceId: string; key: string; timeoutMs?: number }) {}
  private headers() {
    return { "Content-Type": "application/json", "X-Edge-Device": this.cfg.deviceId, "X-Edge-Key": this.cfg.key };
  }
  private async post(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.cfg.cloudUrl.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs || 15_000),
    });
    if (!res.ok) throw new Error(`edge sync ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  pull(after: number, limit: number) { return this.post("/api/edge/pull", { after, limit }) as Promise<PullResponse>; }
  push(commands: EdgeCommand[]) { return this.post("/api/edge/push", { commands }) as Promise<PushResponse>; }
  heartbeat(agentVersion?: string) { return this.post("/api/edge/heartbeat", { agentVersion }) as Promise<HeartbeatResponse>; }
}

// ── Ciclo de sync ───────────────────────────────────────────────────────────
export class EdgeSyncClient {
  /**
   * Executa um ciclo completo. Best-effort e à prova de falha: cada etapa é
   * isolada; a queda de uma não impede as outras nem derruba o loop.
   */
  static async syncOnce(transport: EdgeTransport, opts: { agentVersion?: string; pullLimit?: number; maxPullPages?: number } = {}): Promise<{
    heartbeat: boolean; pushed: { sent: number; failed: number; retried: number }; pulled: number; applied: number; cursor: number;
  }> {
    const pullLimit = opts.pullLimit || 200;
    const maxPullPages = opts.maxPullPages || 20;
    let heartbeat = false;
    let pulled = 0;

    // 1) Heartbeat (não crítico).
    try { const hb = await transport.heartbeat(opts.agentVersion); heartbeat = !!hb?.ok; setState("last_heartbeat_at", String(Date.now())); } catch { /* offline */ }

    // 2) Push do outbox.
    let pushed = { sent: 0, failed: 0, retried: 0 };
    try { pushed = await EdgeOutbox.drain((commands) => transport.push(commands)); setState("last_push_at", String(Date.now())); } catch { /* offline */ }

    // 3) Pull do delta (paginado, com teto de páginas por ciclo).
    try {
      let after = getCursor();
      for (let page = 0; page < maxPullPages; page++) {
        const res = await transport.pull(after, pullLimit);
        for (const e of res.events || []) {
          db.prepare(
            `INSERT OR IGNORE INTO edge_inbox (seq, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES (?, ?, ?, ?, ?)`
          ).run(e.seq, e.aggregateType ?? null, e.aggregateId ?? null, e.eventType, JSON.stringify(e.payload ?? null));
          pulled++;
        }
        after = res.cursor ?? after;
        setState("cursor", String(after));
        if (!res.hasMore) break;
      }
      setState("last_pull_at", String(Date.now()));
    } catch { /* offline — tenta no próximo ciclo */ }

    // 4) Reconciliação local (Fase 4c): aplica o inbox na projeção dos agregados.
    let applied = 0;
    try { applied = EdgeInboxApplicator.applyPending().projected; } catch { /* não derruba o loop */ }

    return { heartbeat, pushed, pulled, applied, cursor: getCursor() };
  }
}
