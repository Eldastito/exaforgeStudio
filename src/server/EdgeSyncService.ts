/**
 * ZappFlow Continuity Layer — Protocolo de sync Edge↔Cloud (ADR-082, Fase 4a).
 *
 * Um "ZappFlow Edge" é uma instalação local do cliente (processo separado, na
 * Fase 4b) que continua operando quando a internet até a nuvem cai. Esta é a
 * FATIA CLOUD do sync — o que qualquer nó Edge conversa com o servidor:
 *
 *   • Autenticação de MÁQUINA (não JWT de usuário): cada nó tem uma API key
 *     própria (id `edg_<hex>` + segredo), com apenas o hash bcrypt guardado —
 *     generalizando o padrão do gateway do Vision (vgw_*, X-Gateway-Key).
 *   • PULL (delta): o nó pede os `domain_events` após o seu último `seq` e
 *     reconcilia — reusa `ContinuityService.since()` (nada de arquitetura nova).
 *   • PUSH (inbox idempotente): o nó envia os comandos do seu outbox; o Cloud
 *     os grava em `client_commands` deduplicando por `command_id` — o mesmo
 *     `idempotency_key` que o ADR-007 pedia, agora concretizado. NESTA fase o
 *     push é transporte durável (persiste + deduplica); a EXECUÇÃO de cada tipo
 *     de comando é a Fase 4c.
 *
 * Tudo atrás da flag `CONTINUITY_EDGE_SYNC_ENABLED` (default OFF): desligada, os
 * endpoints respondem 503 e nada muda no resto do sistema.
 *
 * O sync é PULL-driven pelo nó Edge — não há timer/processo em background aqui
 * (o Cloud só responde). O runtime do Edge que dirige o sync é a Fase 4b.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import db from "./db.js";
import { ContinuityService } from "./ContinuityService.js";

const KEY_PREFIX = "edg_";
// Rondas do bcrypt. Configurável só para os testes não gastarem ~80ms/dispositivo.
const BCRYPT_ROUNDS = Math.max(4, Number(process.env.EDGE_BCRYPT_ROUNDS || 10));

export type EdgeDevice = {
  id: string;
  organization_id: string;
  status: string;
  cursor: number;
};

export type EdgePushCommand = { commandId: string; operationType?: string; payload?: any };
export type EdgePushResult = { commandId: string; status: "accepted" | "deduped" | "rejected"; reason?: string };

export class EdgeSyncService {
  /** Flag global: desligada, o protocolo de sync não responde (503). */
  static enabled(): boolean {
    const v = String(process.env.CONTINUITY_EDGE_SYNC_ENABLED || "").toLowerCase();
    return v === "1" || v === "true" || v === "on";
  }

  /**
   * Provisiona um nó Edge para a organização. Um humano (owner/admin) chama isto.
   * Devolve o segredo em TEXTO PURO uma única vez — só o hash é persistido.
   */
  static async register(orgId: string, name?: string | null): Promise<{ id: string; key: string; name: string | null }> {
    const id = KEY_PREFIX + randomBytes(9).toString("hex"); // id público curto (vai no header)
    const secret = randomBytes(24).toString("hex");          // o segredo (48 hex)
    const hash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
    db.prepare(`INSERT INTO edge_devices (id, organization_id, name, api_key_hash) VALUES (?, ?, ?, ?)`)
      .run(id, orgId, name || null, hash);
    return { id, key: secret, name: name || null };
  }

  /** Lista os nós de uma org (sem expor o hash). */
  static list(orgId: string): any[] {
    return db.prepare(
      `SELECT id, name, status, cursor, agent_version, last_seen_at, created_at
         FROM edge_devices WHERE organization_id = ? ORDER BY created_at DESC`
    ).all(orgId) as any[];
  }

  /** Revoga um nó (deixa de autenticar). Escopo por organização (isolamento). */
  static revoke(orgId: string, deviceId: string): boolean {
    const r = db.prepare(
      `UPDATE edge_devices SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`
    ).run(deviceId, orgId);
    return r.changes > 0;
  }

  /**
   * Autentica um nó pelo par (id, segredo). Retorna o dispositivo ou null.
   * bcrypt.compare — mesma disciplina do gateway do Vision. Atualiza last_seen_at.
   */
  static async authenticate(deviceId: string, key: string): Promise<EdgeDevice | null> {
    if (!deviceId || !key) return null;
    const d = db.prepare(
      `SELECT id, organization_id, status, cursor, api_key_hash FROM edge_devices WHERE id = ?`
    ).get(deviceId) as any;
    if (!d || d.status !== "active" || !d.api_key_hash) return null;
    let ok = false;
    try { ok = await bcrypt.compare(key, d.api_key_hash); } catch { ok = false; }
    if (!ok) return null;
    db.prepare(`UPDATE edge_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`).run(deviceId);
    return { id: d.id, organization_id: d.organization_id, status: d.status, cursor: Number(d.cursor || 0) };
  }

  /**
   * PULL: entrega o delta de `domain_events` após `after` (o último seq que o nó
   * consumiu). Persiste o progresso em `edge_devices.cursor`. Isolado por org.
   */
  static pull(device: EdgeDevice, after: number, limit = 200): { events: any[]; cursor: number; hasMore: boolean } {
    const res = ContinuityService.since(device.organization_id, after, limit);
    // O cursor do nó nunca retrocede (o `after` que ele confirma vira o progresso).
    const progressed = Math.max(after, device.cursor || 0);
    db.prepare(`UPDATE edge_devices SET cursor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(progressed, device.id);
    return res;
  }

  /**
   * PUSH: recebe um lote de comandos do outbox do nó e os grava em
   * `client_commands` deduplicando por `command_id` (idempotência). Transporte
   * durável — a execução por tipo de operação é a Fase 4c.
   */
  static push(device: EdgeDevice, commands: EdgePushCommand[]): { results: EdgePushResult[]; accepted: number; deduped: number; rejected: number } {
    const orgId = device.organization_id;
    const results: EdgePushResult[] = [];
    let accepted = 0, deduped = 0, rejected = 0;
    for (const c of Array.isArray(commands) ? commands : []) {
      const cid = String(c?.commandId || "").trim();
      if (!cid) { results.push({ commandId: String(c?.commandId ?? ""), status: "rejected", reason: "missing_command_id" }); rejected++; continue; }
      if (ContinuityService.lookupCommand(orgId, cid)) { results.push({ commandId: cid, status: "deduped" }); deduped++; continue; }
      ContinuityService.recordCommand(orgId, cid, {
        deviceId: device.id,
        operationType: c.operationType || "edge_command",
        status: "received", // recebido e durável; ainda não executado (Fase 4c)
        result: c.payload ?? null,
      });
      results.push({ commandId: cid, status: "accepted" });
      accepted++;
    }
    return { results, accepted, deduped, rejected };
  }

  /** Heartbeat: atualiza versão do agente e last_seen_at; devolve o cursor do servidor. */
  static heartbeat(device: EdgeDevice, agentVersion?: string): { ok: true; serverCursor: number } {
    db.prepare(
      `UPDATE edge_devices SET agent_version = COALESCE(?, agent_version), last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(agentVersion || null, device.id);
    return { ok: true, serverCursor: ContinuityService.cursor(device.organization_id) };
  }
}
