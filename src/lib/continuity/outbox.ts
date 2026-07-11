/**
 * ZappFlow Continuity Layer — Outbox do navegador (ADR-082, Fase 1b).
 *
 * Fila DURÁVEL de comandos do usuário. Toda ação crítica feita offline vira um
 * comando persistido; quando a conexão volta, o outbox reenvia. Cada comando
 * carrega um `commandId` estável → o servidor deduplica (idempotência da
 * Fase 1), então reenvio NUNCA duplica.
 *
 * O armazenamento é PLUGÁVEL (`OutboxStore`): no browser usa IndexedDB
 * (`IdbOutboxStore`), nos testes usa memória (`MemoryOutboxStore`) — assim a
 * lógica de fila/retry/estado é testável em Node sem IndexedDB.
 *
 * Estados (ADR-082 D9): pending → syncing → sent | failed.
 */
export type OutboxStatus = "pending" | "syncing" | "sent" | "failed";

export interface OutboxCommand {
  commandId: string;
  type: string;               // ex.: 'SEND_MESSAGE'
  payload: any;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface OutboxStore {
  put(cmd: OutboxCommand): Promise<void>;
  get(commandId: string): Promise<OutboxCommand | undefined>;
  list(): Promise<OutboxCommand[]>;
  delete(commandId: string): Promise<void>;
}

/** Store em memória (testes). */
export class MemoryOutboxStore implements OutboxStore {
  private m = new Map<string, OutboxCommand>();
  async put(cmd: OutboxCommand) { this.m.set(cmd.commandId, { ...cmd }); }
  async get(id: string) { const c = this.m.get(id); return c ? { ...c } : undefined; }
  async list() { return [...this.m.values()].map(c => ({ ...c })); }
  async delete(id: string) { this.m.delete(id); }
}

/** Store IndexedDB (browser). Uma object store 'commands' com keyPath commandId. */
export class IdbOutboxStore implements OutboxStore {
  private dbName = "zappflow_continuity";
  private storeName = "outbox";
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        if (!dbi.objectStoreNames.contains(this.storeName)) dbi.createObjectStore(this.storeName, { keyPath: "commandId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const dbi = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = dbi.transaction(this.storeName, mode);
      const req = fn(t.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }
  async put(cmd: OutboxCommand) { await this.tx("readwrite", s => s.put(cmd)); }
  async get(id: string) { return (await this.tx<OutboxCommand>("readonly", s => s.get(id))) || undefined; }
  async list() { return (await this.tx<OutboxCommand[]>("readonly", s => s.getAll())) || []; }
  async delete(id: string) { await this.tx("readwrite", s => s.delete(id)); }
}

/** Resultado de uma tentativa de envio de um comando. */
export type SendResult = "sent" | "retry" | "failed";
export type CommandSender = (cmd: OutboxCommand) => Promise<SendResult>;

const MAX_ATTEMPTS = 8;

export class Outbox {
  constructor(private store: OutboxStore, private now: () => string = () => new Date().toISOString()) {}

  /** Enfileira um comando (idempotente por commandId — reenfileirar não duplica). */
  async enqueue(input: { commandId: string; type: string; payload: any }): Promise<OutboxCommand> {
    const existing = await this.store.get(input.commandId);
    if (existing) return existing;
    const cmd: OutboxCommand = {
      commandId: input.commandId, type: input.type, payload: input.payload,
      status: "pending", attempts: 0, createdAt: this.now(), updatedAt: this.now(),
    };
    await this.store.put(cmd);
    return cmd;
  }

  async pending(): Promise<OutboxCommand[]> {
    return (await this.store.list())
      .filter(c => c.status === "pending" || c.status === "syncing")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async all(): Promise<OutboxCommand[]> { return this.store.list(); }

  /**
   * Tenta enviar todos os comandos pendentes. `sender` faz o POST (com o
   * commandId, para o servidor deduplicar). Retorna um resumo. Reentrância
   * protegida: só um flush por vez.
   */
  private flushing = false;
  async flush(sender: CommandSender): Promise<{ sent: number; retry: number; failed: number }> {
    if (this.flushing) return { sent: 0, retry: 0, failed: 0 };
    this.flushing = true;
    const summary = { sent: 0, retry: 0, failed: 0 };
    try {
      for (const cmd of await this.pending()) {
        cmd.status = "syncing"; cmd.attempts += 1; cmd.updatedAt = this.now();
        await this.store.put(cmd);
        let result: SendResult;
        try { result = await sender(cmd); } catch { result = "retry"; }
        if (result === "sent") {
          cmd.status = "sent"; cmd.updatedAt = this.now(); await this.store.put(cmd);
          await this.store.delete(cmd.commandId); // entregue → sai da fila
          summary.sent++;
        } else if (result === "failed" || cmd.attempts >= MAX_ATTEMPTS) {
          cmd.status = "failed"; cmd.updatedAt = this.now(); await this.store.put(cmd);
          summary.failed++;
        } else {
          cmd.status = "pending"; cmd.updatedAt = this.now(); await this.store.put(cmd); // volta à fila p/ próxima rodada
          summary.retry++;
        }
      }
    } finally { this.flushing = false; }
    return summary;
  }
}
