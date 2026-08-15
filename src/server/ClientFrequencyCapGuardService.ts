/**
 * ClientFrequencyCapGuardService (ADR-169 F5-transversal-C / BEAUTY-011c) —
 * gate transversal de CAP DE FREQUÊNCIA por contato antes de disparar
 * comunicação outbound.
 *
 * ONDE ENTRA: `MessageProviderService.sendMessage`, imediatamente depois dos
 * guards F5-A (consent) e F5-B (quiet-hours). Ordem no sink:
 *
 *   1. `OutboundConsentGuardService` (LGPD Art.14)
 *   2. `ClientQuietHoursGuardService` (respeito ao descanso)
 *   3. `ClientFrequencyCapGuardService` (não abusar da frequência)
 *   4. fetch pro provider
 *   5. `ClientFrequencyCapGuardService.record` (best-effort, best-position:
 *      após sucesso do provider — falha de rede NÃO conta pro cap)
 *
 * POR QUE UM CAP: pra que o Beauty Autopilot (F11+) e todo caller de
 * `sendMessage` (Cadence/Playbook/Reminder/Radar/...) NÃO acumule mensagens
 * pro mesmo contato num intervalo curto — o problema clássico do "spam
 * involuntário" quando várias regras disparam pra mesma pessoa. O cap é
 * transversal (uma vez configurado, protege TODOS os callers).
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Flag `client_frequency_cap_enforced` default 0.
 * Sem a flag, o guard SEMPRE PERMITE e NÃO REGISTRA (nem escreve no log).
 * Ativada, defaults: **3 mensagens / 24 horas** (razoável pra follow-up de salão).
 * Dono pode customizar `client_frequency_cap_max_per_window` (N ≥ 1) e
 * `client_frequency_cap_window_hours` (H ≥ 1).
 *
 * STORE ISOLADO (`outbound_send_log`): a guard NÃO conta em `messages` (que
 * depende do padrão de escrita dos callers). Usa tabela dedicada — a guard
 * escreve quando ALLOWS, e só ela lê. Isso garante que o cap tenha uma fonte
 * única e determinística, sem depender de "quem chama de fato persiste como
 * bot no messages".
 *
 * LOOKUP DO CONTATO: mesmo esquema de F5-A — por `identifier` na org do
 * canal. Se identifier sem contato cadastrado → PERMITE + NÃO REGISTRA
 * (comunicação de sistema/broadcast; cap não se aplica).
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-11 (nunca infere): sem custom, usa defaults explícitos (3, 24) —
 *    nunca "chuta" cap por vertical.
 *  - RN-BS-12 (autopilot conservador): freio anti-spam pros follow-ups
 *    da F11+.
 *  - RN-BS-07 (cross-tenant): flag + parâmetros + log lidos/gravados na
 *    MESMA org do canal.
 *
 * NÃO É RATE-LIMIT DE INFRA — é FREQUÊNCIA PERCEBIDA pela cliente
 * (mensagens que ELA recebeu do salão). Rate-limit de API (429) é outro
 * problema e não é gerenciado aqui.
 *
 * TESTABILIDADE: `evaluate(orgId, identifier, now?)` aceita `now` opcional
 * pra teste — permite simular janela com timestamps determinísticos sem
 * esperar 24h de verdade.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";

// Defaults do sistema: 3 mensagens por 24 horas. Cobre bem o "não abusar".
export const CLIENT_FREQ_DEFAULT_MAX = 3;
export const CLIENT_FREQ_DEFAULT_WINDOW_HOURS = 24;

export type FreqGuardDecision =
  | { allow: true; reason: "flag_off" | "unknown_contact" | "under_cap"; used: number; cap: number; windowHours: number }
  | { allow: false; reason: "cap_exceeded"; contactId: string; contactName: string | null; used: number; cap: number; windowHours: number };

export class ClientFrequencyCapGuardService {
  /**
   * Decide se pode enviar agora ao contato. Determinístico, síncrono, sem
   * side-effect (não escreve nada aqui — record() é chamado pós-fetch).
   */
  static evaluate(
    orgId: string,
    identifier: string,
    now: Date = new Date(),
  ): FreqGuardDecision {
    if (!this.isEnabled(orgId)) {
      return { allow: true, reason: "flag_off", used: 0, cap: 0, windowHours: 0 };
    }
    const contact = this.findContactByIdentifier(orgId, identifier);
    if (!contact) {
      // Sem contato → comunicação de sistema/broadcast, cap não se aplica.
      const { max, windowHours } = this.effectiveParams(orgId);
      return { allow: true, reason: "unknown_contact", used: 0, cap: max, windowHours };
    }
    const { max, windowHours } = this.effectiveParams(orgId);
    const windowStartMs = now.getTime() - windowHours * 3600 * 1000;
    const used = this.countInWindow(orgId, contact.id, windowStartMs);
    if (used >= max) {
      return {
        allow: false,
        reason: "cap_exceeded",
        contactId: contact.id,
        contactName: contact.name || null,
        used,
        cap: max,
        windowHours,
      };
    }
    return { allow: true, reason: "under_cap", used, cap: max, windowHours };
  }

  /**
   * Registra um envio bem-sucedido. Chamado pelo sink APÓS o fetch OK.
   * Best-effort — nunca lança pro sink (rede lenta > falso pico no cap).
   * Sem contato → não registra. Sem flag → não registra (evita "sujar" o
   * log quando o cap tá desligado).
   */
  static record(orgId: string, identifier: string, now: Date = new Date()): void {
    try {
      if (!this.isEnabled(orgId)) return;
      const contact = this.findContactByIdentifier(orgId, identifier);
      if (!contact) return;
      db.prepare(
        `INSERT INTO outbound_send_log (id, organization_id, contact_id, sent_at) VALUES (?, ?, ?, ?)`,
      ).run(randomUUID(), orgId, contact.id, now.toISOString());
    } catch {
      /* best-effort */
    }
  }

  /** Flag `client_frequency_cap_enforced` ligada? */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT client_frequency_cap_enforced FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { client_frequency_cap_enforced?: number } | undefined;
      return Number(r?.client_frequency_cap_enforced || 0) === 1;
    } catch {
      return false;
    }
  }

  /** Liga/desliga a flag. Idempotente. */
  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET client_frequency_cap_enforced = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }

  /** Parâmetros efetivos com fallback pros defaults do sistema. */
  static effectiveParams(orgId: string): { max: number; windowHours: number; source: "default" | "custom" } {
    try {
      const r = db
        .prepare(
          `SELECT client_frequency_cap_max_per_window m, client_frequency_cap_window_hours w
             FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { m?: number | null; w?: number | null } | undefined;
      const m = r?.m;
      const w = r?.w;
      const hasCustom = m != null || w != null;
      return {
        max: m != null ? Number(m) : CLIENT_FREQ_DEFAULT_MAX,
        windowHours: w != null ? Number(w) : CLIENT_FREQ_DEFAULT_WINDOW_HOURS,
        source: hasCustom ? "custom" : "default",
      };
    } catch {
      return {
        max: CLIENT_FREQ_DEFAULT_MAX,
        windowHours: CLIENT_FREQ_DEFAULT_WINDOW_HOURS,
        source: "default",
      };
    }
  }

  /**
   * Ajusta parâmetros. `null` explícito volta pro default. Valida
   * `max ≥ 1` e `windowHours ≥ 1`.
   */
  static setParams(
    orgId: string,
    input: { max?: number | null; windowHours?: number | null },
  ): void {
    const sets: string[] = [];
    const params: any[] = [];
    if ("max" in input) {
      const v = normalizePositive(input.max, "max");
      sets.push("client_frequency_cap_max_per_window = ?");
      params.push(v);
    }
    if ("windowHours" in input) {
      const v = normalizePositive(input.windowHours, "windowHours");
      sets.push("client_frequency_cap_window_hours = ?");
      params.push(v);
    }
    if (!sets.length) return;
    params.push(orgId);
    db.prepare(
      `UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`,
    ).run(...params);
  }

  // ---- Internos ----

  private static findContactByIdentifier(
    orgId: string,
    identifier: string,
  ): { id: string; name: string | null } | null {
    if (!identifier) return null;
    try {
      const r = db
        .prepare(
          `SELECT id, name FROM contacts WHERE organization_id = ? AND identifier = ? ORDER BY rowid ASC LIMIT 1`,
        )
        .get(orgId, identifier) as { id: string; name: string | null } | undefined;
      return r || null;
    } catch {
      return null;
    }
  }

  private static countInWindow(orgId: string, contactId: string, windowStartMs: number): number {
    try {
      const r = db
        .prepare(
          `SELECT COUNT(*) c FROM outbound_send_log
            WHERE organization_id = ? AND contact_id = ? AND sent_at >= ?`,
        )
        .get(orgId, contactId, new Date(windowStartMs).toISOString()) as { c: number } | undefined;
      return Number(r?.c || 0);
    } catch {
      return 0;
    }
  }
}

function normalizePositive(v: number | null | undefined, field: string): number | null {
  if (v == null || v === ("" as any)) return null;
  const n = Math.trunc(Number(v));
  if (!Number.isInteger(n) || n < 1) throw new Error(`${field} deve ser inteiro ≥ 1 ou null.`);
  return n;
}

/**
 * Erro pro sink. `code` tipada + `used`/`cap`/`windowHours` pra caller
 * marcar delivery como `blocked_frequency_cap` e (se quiser) reagendar
 * pra depois da janela.
 */
export class OutboundFrequencyCapError extends Error {
  code: string;
  contactId?: string;
  contactName?: string | null;
  used: number;
  cap: number;
  windowHours: number;
  constructor(
    used: number,
    cap: number,
    windowHours: number,
    opts: { contactId?: string; contactName?: string | null } = {},
  ) {
    super(
      `Envio bloqueado por cap de frequência (${used}/${cap} mensagens na última janela de ${windowHours}h). Aguarde a janela expirar.`,
    );
    this.name = "OutboundFrequencyCapError";
    this.code = "outbound_blocked:frequency_cap";
    this.contactId = opts.contactId;
    this.contactName = opts.contactName || null;
    this.used = used;
    this.cap = cap;
    this.windowHours = windowHours;
  }
}

export default ClientFrequencyCapGuardService;
