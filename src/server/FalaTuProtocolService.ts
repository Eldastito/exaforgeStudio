import { randomUUID, randomInt, createHash, timingSafeEqual } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ADR-154 F8.7 — PROTOCOLOS: tarefas pré-configuradas ativáveis por voz.
 *
 * Caso-bandeira: o "protocolo de segurança" (chamada de resgate). O usuário
 * pré-configura na Config uma tarefa nomeada com ação PRÉ-AUTORIZADA
 * (`call_me`: o telefone DELE toca em N minutos); dizer o nome do protocolo
 * em qualquer canal de captura (webapp, WhatsApp, Atalho Siri) dispara a
 * ação. Isto NÃO fura a RN-151 ("IA nunca materializa sozinha"): a
 * autorização foi dada pelo humano NA CONFIGURAÇÃO, e o reconhecimento da
 * ativação é REGRA DE CÓDIGO — nenhum palpite de IA no caminho.
 *
 * GUARDRAILS (duros, testados):
 * - A IA NUNCA cria/edita/apaga protocolo — CRUD é humano, nas rotas de
 *   sessão. O caminho de captura só LÊ (match) + ativa/cancela.
 * - Reconhecimento determinístico: match de `name_norm` exato/por prefixo
 *   na transcrição (mesma régua de normalização da desambiguação F5).
 *   Ambíguo (2+) pergunta; 0 match → captura segue o fluxo normal.
 * - Ligação SÓ pro número do PRÓPRIO usuário, verificado por código falado
 *   em ligação (mesmo transporte da ação — verificar prova que o resgate
 *   alcança o aparelho). `phone_e164` sem `phone_verified_at` NÃO ativa.
 *   NÃO existe campo de destino em rota nenhuma — o vetor "usar o FalaTu
 *   pra ligar pra terceiros" é impossível por construção.
 * - Código de verificação: sha256 + timingSafeEqual + 5 tentativas + TTL
 *   10min (molde do PIN da Fase 28). Trocar o telefone RESETA a verificação.
 * - Toda ativação vira linha em `falatu_protocol_activations` + audit.
 *   Cancelamento/falha é UPDATE de status — nunca DELETE (convenção nº 9).
 * - Falha do provider nunca derruba nada (convenção nº 7): marca
 *   status='failed' + sinal `falatu_protocol_failed` no business_signals
 *   (convenção nº 12 — nada de tabela própria de alerta).
 * - Custo de telefonia NÃO toca o saldo de IA (ai_usage_ledger) — fica
 *   rastreado na activation (provider_call_id).
 * - Feature flag `falatu_protocols_enabled` opt-in por org (convenção nº 10).
 *
 * PONTUALIDADE: ativar agenda `scheduled_for = now + delay` e arma um
 * setTimeout local (unref — não segura o processo) pro disparo no minuto
 * certo; o passe rápido do Scheduler (5min) é a REDE DE SEGURANÇA que cobre
 * restart do processo. O disparo é idempotente por claim atômico (UPDATE ...
 * WHERE status='scheduled'): timer e passe podem correr — só um liga.
 */

export type VoiceCall = (toE164: string, message: string) => Promise<{ callId: string | null }>;

const MAX_ACTIVE_PROTOCOLS = 5;
const VERIFY_TTL_MIN = 10;
const VERIFY_MAX_ATTEMPTS = 5;
const DELAY_MIN = 1;
const DELAY_MAX = 60;

// Mesma régua de normalização da memória F5 (lower + sem acento + alfanum).
const norm = (s: string) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Palavras de ativação que podem preceder o nome ("falatu protocolo de
// segurança", "ativa o protocolo x"). Removidas ANTES do match por prefixo.
const WAKE_RE = /^(fala\s*tu|ativa(r)?|aciona(r)?)\s+(o|a)?\s*/;
// Cancelamento dentro da janela — também regra de código, nunca IA.
const CANCEL_RE = /^cancela(r)?\s+(o|a)?\s*protocolo\b/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEq = (aHex: string, bHex: string) => {
  const a = Buffer.from(aHex, "hex"); const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
};

export type ProtocolCaptureOutcome =
  | { kind: "activated"; activationId: string; name: string; delayMinutes: number; scheduledFor: string }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "unverified"; name: string }
  | { kind: "cancelled"; count: number }
  | { kind: "nothing_to_cancel" };

export class FalaTuProtocolService {
  /** Timers locais por activation (pontualidade). O claim atômico no disparo
   *  é quem garante exatamente-uma-ligação; o Map é só otimização/cancel. */
  private static timers = new Map<string, NodeJS.Timeout>();

  // ── Feature flag por org (convenção nº 10) ──

  static orgEnabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT falatu_protocols_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return !!Number(r?.falatu_protocols_enabled);
    } catch { return false; }
  }

  static setOrgEnabled(orgId: string, userId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET falatu_protocols_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    logAuthEvent(orgId, userId, null, enabled ? "FALATU_PROTOCOLS_ORG_ENABLE" : "FALATU_PROTOCOLS_ORG_DISABLE", {});
    return { enabled };
  }

  // ── CRUD (humano, na Config — a IA nunca chega aqui) ──

  static create(orgId: string, userId: string, input: { name?: unknown; phoneE164?: unknown; delayMinutes?: unknown }): any {
    if (!this.orgEnabled(orgId)) throw new Error("Protocolos não estão habilitados para esta organização.");
    const name = String(input.name || "").trim();
    if (name.length < 2 || name.length > 60) throw new Error("Dê um nome ao protocolo (2 a 60 caracteres).");
    const nameNorm = norm(name);
    if (!nameNorm) throw new Error("Nome do protocolo precisa ter letras ou números.");
    const phone = String(input.phoneE164 || "").trim();
    if (!/^\+[1-9]\d{9,14}$/.test(phone)) throw new Error("Telefone em formato internacional, ex.: +5511999998888.");
    const delay = Number(input.delayMinutes ?? 5);
    if (!Number.isInteger(delay) || delay < DELAY_MIN || delay > DELAY_MAX) throw new Error(`Minutos até a ligação: inteiro entre ${DELAY_MIN} e ${DELAY_MAX}.`);
    const dup = db.prepare(`SELECT 1 FROM falatu_protocols WHERE organization_id = ? AND user_id = ? AND name_norm = ? AND deleted_at IS NULL`).get(orgId, userId, nameNorm);
    if (dup) throw new Error("Você já tem um protocolo com esse nome.");
    const count = db.prepare(`SELECT COUNT(*) c FROM falatu_protocols WHERE organization_id = ? AND user_id = ? AND deleted_at IS NULL`).get(orgId, userId) as any;
    if (Number(count?.c || 0) >= MAX_ACTIVE_PROTOCOLS) throw new Error(`Limite de ${MAX_ACTIVE_PROTOCOLS} protocolos atingido. Remova um antes de criar outro.`);
    const id = randomUUID();
    db.prepare(`INSERT INTO falatu_protocols (id, organization_id, user_id, name, name_norm, delay_minutes, phone_e164) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, userId, name, nameNorm, delay, phone);
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_CREATE", { protocolId: id, name });
    return this.get(orgId, userId, id);
  }

  static list(orgId: string, userId: string): any[] {
    return db.prepare(
      `SELECT id, name, action_kind, delay_minutes, phone_e164, phone_verified_at, enabled, created_at
       FROM falatu_protocols WHERE organization_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`
    ).all(orgId, userId);
  }

  private static get(orgId: string, userId: string, id: string): any {
    const p = db.prepare(`SELECT id, name, action_kind, delay_minutes, phone_e164, phone_verified_at, enabled, created_at FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, orgId, userId) as any;
    if (!p) throw new Error("Protocolo não encontrado.");
    return p;
  }

  static update(orgId: string, userId: string, id: string, input: { name?: unknown; phoneE164?: unknown; delayMinutes?: unknown; enabled?: unknown }): any {
    const p = db.prepare(`SELECT * FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, orgId, userId) as any;
    if (!p) throw new Error("Protocolo não encontrado.");
    let name = p.name, nameNorm = p.name_norm;
    if (input.name !== undefined) {
      name = String(input.name || "").trim();
      if (name.length < 2 || name.length > 60) throw new Error("Nome: 2 a 60 caracteres.");
      nameNorm = norm(name);
      const dup = db.prepare(`SELECT 1 FROM falatu_protocols WHERE organization_id = ? AND user_id = ? AND name_norm = ? AND deleted_at IS NULL AND id != ?`).get(orgId, userId, nameNorm, id);
      if (dup) throw new Error("Você já tem um protocolo com esse nome.");
    }
    let delay = p.delay_minutes;
    if (input.delayMinutes !== undefined) {
      delay = Number(input.delayMinutes);
      if (!Number.isInteger(delay) || delay < DELAY_MIN || delay > DELAY_MAX) throw new Error(`Minutos: inteiro entre ${DELAY_MIN} e ${DELAY_MAX}.`);
    }
    let phone = p.phone_e164; let resetVerify = false;
    if (input.phoneE164 !== undefined) {
      phone = String(input.phoneE164 || "").trim();
      if (!/^\+[1-9]\d{9,14}$/.test(phone)) throw new Error("Telefone em formato internacional, ex.: +5511999998888.");
      // Número novo = verificação nova (guardrail: só liga pra número PROVADO).
      resetVerify = phone !== p.phone_e164;
    }
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : p.enabled;
    db.prepare(
      `UPDATE falatu_protocols SET name = ?, name_norm = ?, delay_minutes = ?, phone_e164 = ?, enabled = ?,
        phone_verified_at = ${resetVerify ? "NULL" : "phone_verified_at"},
        verify_code_hash = ${resetVerify ? "NULL" : "verify_code_hash"},
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(name, nameNorm, delay, phone, enabled, id);
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_UPDATE", { protocolId: id, resetVerify });
    return this.get(orgId, userId, id);
  }

  /** Remoção lógica (deleted_at) — a linha fica como trilha (convenção nº 9). */
  static remove(orgId: string, userId: string, id: string): { ok: true } {
    const r = db.prepare(`UPDATE falatu_protocols SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL`).run(id, orgId, userId);
    if (r.changes === 0) throw new Error("Protocolo não encontrado.");
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_REMOVE", { protocolId: id });
    return { ok: true };
  }

  // ── Verificação do número (código FALADO em ligação — molde PIN Fase 28) ──

  static async requestPhoneVerification(orgId: string, userId: string, id: string, opts?: { call?: VoiceCall }): Promise<{ requested: true }> {
    const p = db.prepare(`SELECT * FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, orgId, userId) as any;
    if (!p) throw new Error("Protocolo não encontrado.");
    const call = opts?.call || (await this.defaultCall());
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = new Date(Date.now() + VERIFY_TTL_MIN * 60_000).toISOString();
    db.prepare(`UPDATE falatu_protocols SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(sha256(code), expires, id);
    // A ligação de verificação usa o MESMO transporte do resgate — verificar
    // prova que a chamada de verdade alcança este aparelho.
    const spoken = code.split("").join(", ");
    await call(p.phone_e164, `Olá! Aqui é o Fala Tu. Seu código de verificação é: ${spoken}. Repetindo: ${spoken}.`);
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_VERIFY_REQUEST", { protocolId: id });
    return { requested: true };
  }

  static confirmPhoneVerification(orgId: string, userId: string, id: string, codeInput: unknown): { verified: true } {
    const p = db.prepare(`SELECT * FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, orgId, userId) as any;
    if (!p) throw new Error("Protocolo não encontrado.");
    const code = String(codeInput || "").replace(/\D/g, "");
    if (!p.verify_code_hash || !p.verify_expires_at) throw new Error("Peça a ligação de verificação primeiro.");
    if (new Date(p.verify_expires_at).getTime() < Date.now()) throw new Error("Código expirado — peça uma nova ligação.");
    if (Number(p.verify_attempts) >= VERIFY_MAX_ATTEMPTS) throw new Error("Muitas tentativas — peça uma nova ligação.");
    if (code.length !== 6 || !safeEq(sha256(code), p.verify_code_hash)) {
      db.prepare(`UPDATE falatu_protocols SET verify_attempts = verify_attempts + 1 WHERE id = ?`).run(id);
      throw new Error("Código incorreto.");
    }
    db.prepare(`UPDATE falatu_protocols SET phone_verified_at = CURRENT_TIMESTAMP, verify_code_hash = NULL, verify_expires_at = NULL, verify_attempts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_VERIFIED", { protocolId: id });
    return { verified: true };
  }

  // ── Reconhecimento por voz (REGRA DE CÓDIGO — nunca IA) ──

  /**
   * Gancho único do capture() (webapp, WhatsApp, token Siri): decide por
   * regra determinística se o texto/transcrição é ativação ou cancelamento.
   * Devolve null quando não é assunto de protocolo → captura segue normal.
   */
  static handleCaptureText(orgId: string, userId: string, text: string | null | undefined, source?: string): ProtocolCaptureOutcome | null {
    if (!this.orgEnabled(orgId)) return null;
    const t = norm(String(text || ""));
    if (!t) return null;

    if (CANCEL_RE.test(t)) {
      const count = this.cancelScheduled(orgId, userId, "voice");
      return count > 0 ? { kind: "cancelled", count } : { kind: "nothing_to_cancel" };
    }

    const stripped = t.replace(WAKE_RE, "");
    const candidates = db.prepare(
      `SELECT * FROM falatu_protocols WHERE organization_id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL`
    ).all(orgId, userId) as any[];
    const matched = candidates.filter((p) => stripped === p.name_norm || stripped.startsWith(p.name_norm + " "));
    if (matched.length === 0) return null;
    if (matched.length > 1) return { kind: "ambiguous", names: matched.map((p) => p.name) };
    const p = matched[0];
    if (!p.phone_verified_at) return { kind: "unverified", name: p.name };
    const act = this.activate(orgId, userId, p.id, source || "webapp");
    return { kind: "activated", activationId: act.id, name: p.name, delayMinutes: p.delay_minutes, scheduledFor: act.scheduled_for };
  }

  // ── Ativação / cancelamento / disparo ──

  /** Agenda a ligação (linha em activations + timer local). Guardrails na
   *  própria query: protocolo do usuário, habilitado, VERIFICADO, vivo. */
  static activate(orgId: string, userId: string, protocolId: string, source: string, opts?: { now?: Date; armTimer?: boolean }): any {
    if (!this.orgEnabled(orgId)) throw new Error("Protocolos não estão habilitados para esta organização.");
    const p = db.prepare(
      `SELECT * FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL AND phone_verified_at IS NOT NULL`
    ).get(protocolId, orgId, userId) as any;
    if (!p) throw new Error("Protocolo indisponível (inexistente, desligado ou número não verificado).");
    const now = opts?.now || new Date();
    const scheduledFor = new Date(now.getTime() + Number(p.delay_minutes) * 60_000).toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO falatu_protocol_activations (id, organization_id, user_id, protocol_id, source, requested_at, scheduled_for, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`
    ).run(id, orgId, userId, protocolId, String(source || "webapp").slice(0, 20), now.toISOString(), scheduledFor);
    logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_ACTIVATE", { protocolId, activationId: id, source, scheduledFor });
    if (opts?.armTimer !== false) this.armTimer(id, new Date(scheduledFor).getTime() - now.getTime());
    return db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(id);
  }

  /** Timer local pro minuto certo. unref(): nunca segura o processo vivo; o
   *  passe do Scheduler cobre restart. Disparo re-verifica status (claim). */
  private static armTimer(activationId: string, delayMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(activationId);
      this.fireActivation(activationId).catch((e) => console.error("[FalaTuProtocol] disparo por timer falhou", activationId, e));
    }, Math.max(0, delayMs));
    t.unref?.();
    this.timers.set(activationId, t);
  }

  /** Cancela TODAS as ativações agendadas do usuário (a frase de voz não
   *  distingue — dentro da janela, cancelar tudo é o comportamento seguro). */
  static cancelScheduled(orgId: string, userId: string, via: string): number {
    const rows = db.prepare(`SELECT id FROM falatu_protocol_activations WHERE organization_id = ? AND user_id = ? AND status = 'scheduled'`).all(orgId, userId) as any[];
    let n = 0;
    for (const r of rows) {
      const u = db.prepare(`UPDATE falatu_protocol_activations SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'`).run(r.id);
      if (u.changes > 0) {
        n++;
        const t = this.timers.get(r.id); if (t) { clearTimeout(t); this.timers.delete(r.id); }
        logAuthEvent(orgId, userId, null, "FALATU_PROTOCOL_CANCEL", { activationId: r.id, via });
      }
    }
    return n;
  }

  static listActivations(orgId: string, userId: string, limit = 20): any[] {
    return db.prepare(
      `SELECT a.id, a.protocol_id, a.source, a.requested_at, a.scheduled_for, a.status, a.provider_call_id, a.fired_at, a.fail_reason, p.name AS protocol_name
       FROM falatu_protocol_activations a JOIN falatu_protocols p ON p.id = a.protocol_id
       WHERE a.organization_id = ? AND a.user_id = ? ORDER BY a.requested_at DESC LIMIT ?`
    ).all(orgId, userId, Math.min(Math.max(1, limit), 100));
  }

  private static async defaultCall(): Promise<VoiceCall> {
    const { TelephonyService } = await import("./TelephonyService.js");
    if (!TelephonyService.configured()) throw new Error("Telefonia não configurada no servidor — peça ao suporte pra habilitar as ligações.");
    return (to, msg) => TelephonyService.call(to, msg);
  }

  /**
   * Dispara UMA ativação: claim atômico (só um vencedor entre timer e passe
   * do Scheduler), re-checa o protocolo NA HORA (pode ter sido desligado ou
   * trocado de número na janela) e liga pro número verificado do dono.
   * Nunca lança: falha marca 'failed' + sinal no ledger (convenções 7/12).
   */
  static async fireActivation(activationId: string, opts?: { call?: VoiceCall }): Promise<{ fired: boolean; reason?: string }> {
    const claim = db.prepare(`UPDATE falatu_protocol_activations SET status = 'firing' WHERE id = ? AND status = 'scheduled'`).run(activationId);
    if (claim.changes === 0) return { fired: false, reason: "not_scheduled" };
    const a = db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(activationId) as any;
    const fail = (reason: string) => {
      db.prepare(`UPDATE falatu_protocol_activations SET status = 'failed', fail_reason = ? WHERE id = ?`).run(reason, activationId);
      try {
        BusinessSignalService.publish(a.organization_id, {
          domain: "falatu", signalType: "falatu_protocol_failed", severity: "attention", basis: "fact", confidence: 1,
          sourceService: "FalaTuProtocolService", sourceEntityType: "falatu_protocol_activation", sourceEntityId: activationId,
          dedupeKey: `falatu_protocol_failed:${activationId}`,
          evidence: { activationId, protocolId: a.protocol_id, userId: a.user_id, reason },
        });
      } catch (e) { console.error("[FalaTuProtocol] sinal de falha não publicado (best-effort)", e); }
      return { fired: false, reason };
    };
    try {
      // Re-check dos guardrails NO DISPARO — a fonte é o protocolo de agora,
      // não o snapshot da ativação (número trocado sem verificar não recebe).
      const p = db.prepare(
        `SELECT * FROM falatu_protocols WHERE id = ? AND organization_id = ? AND user_id = ? AND enabled = 1 AND deleted_at IS NULL AND phone_verified_at IS NOT NULL`
      ).get(a.protocol_id, a.organization_id, a.user_id) as any;
      if (!p) {
        db.prepare(`UPDATE falatu_protocol_activations SET status = 'cancelled', fail_reason = 'protocol_unavailable_at_fire' WHERE id = ?`).run(activationId);
        return { fired: false, reason: "protocol_unavailable_at_fire" };
      }
      const call = opts?.call || (await this.defaultCall());
      const r = await call(p.phone_e164, "Olá! Esta é a sua chamada solicitada pelo Fala Tu. Estou na linha, como combinado. Até já.");
      db.prepare(`UPDATE falatu_protocol_activations SET status = 'fired', provider_call_id = ?, fired_at = CURRENT_TIMESTAMP WHERE id = ?`).run(r?.callId || null, activationId);
      logAuthEvent(a.organization_id, a.user_id, null, "FALATU_PROTOCOL_FIRED", { activationId, protocolId: a.protocol_id });
      return { fired: true };
    } catch (e: any) {
      console.error("[FalaTuProtocol] ligação falhou (best-effort):", e?.message || e);
      return fail(String(e?.message || "call_failed").slice(0, 200));
    }
  }

  /** Rede de segurança do Scheduler (passe de 5min): dispara o que venceu.
   *  Cobre restart do processo (timers locais morrem; as linhas não). */
  static async fireDue(opts?: { now?: Date; call?: VoiceCall }): Promise<{ fired: number; failed: number }> {
    const now = (opts?.now || new Date()).toISOString();
    const due = db.prepare(`SELECT id FROM falatu_protocol_activations WHERE status = 'scheduled' AND scheduled_for <= ?`).all(now) as any[];
    const out = { fired: 0, failed: 0 };
    for (const d of due) {
      const r = await this.fireActivation(d.id, { call: opts?.call });
      if (r.fired) out.fired++; else if (r.reason !== "not_scheduled") out.failed++;
    }
    return out;
  }
}

export default FalaTuProtocolService;
