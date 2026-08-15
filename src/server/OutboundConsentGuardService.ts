/**
 * OutboundConsentGuardService (ADR-169 F5-transversal-A / BEAUTY-011a) —
 * gate transversal de consent LGPD antes de disparar comunicação outbound.
 *
 * ONDE ENTRA: `MessageProviderService.sendMessage` — o SINK canônico por
 * onde passam TODAS as mensagens outbound do ZapFlow (WhatsApp Cloud,
 * Evolution, Instagram), invocado por ~30 services (Cadence, Playbooks,
 * Reminder, Follow-Up, Radar, Coordenador, etc.). Um único ponto de guarda
 * cobre TODAS as verticais (RN-BS-04 mas beneficia clínica/retail/escola/
 * comércio/comigo/prospect/reputação/social/growth — aditivo).
 *
 * POSTURA: OPT-IN + 0-REGRESSÃO. Sem `outbound_consent_required=1` (default 0)
 * o guard SEMPRE PERMITE — nenhuma org existente muda de comportamento sem
 * o dono ligar a chave. Habilitada, o guard consulta `contact_consents`
 * (LgpdService.hasConsent scope='comunicacoes') do contato-destino. Sem
 * consent → BLOQUEIA com razão tipada (`consent_missing`).
 *
 * LOOKUP DO CONTATO: por `identifier` (=telefone/handle). É a chave real
 * usada pelos providers pra endereçar a mensagem. Se o `recipientIdentifier`
 * não bater com nenhum `contacts.identifier` da org do canal → tratamos
 * como MENSAGEM DE SISTEMA (broadcast, teste, admin) e PERMITIMOS: o guard
 * protege comunicação com CONTATOS conhecidos, não bloqueia caminhos
 * operacionais internos.
 *
 * GUARDRAILS RN-BS:
 *  - RN-BS-04 (consent tipado): consent é buscado pelo scope EXATO
 *    'comunicacoes' — nunca infere de outros escopos (`hair_simulation`,
 *    `dados_sensiveis` etc. NÃO valem).
 *  - RN-BS-07 (cross-tenant): consent lido da MESMA org do canal (via
 *    channel.organization_id), nunca cruza.
 *  - RN-BS-11 (nunca infere): sem prova de consent → recusa. Nunca
 *    "presume que o cliente concordou".
 *
 * SIDE-EFFECT ZERO ALÉM DA DECISÃO: guard NÃO escreve consent, NÃO cria
 * signal, NÃO loga (deixamos o audit pro caller — o service que chamou
 * sendMessage sabe o contexto). Retorna decisão pura.
 *
 * O PORQUÊ DESTA FATIA (RECOMENDADA antes de F11+): a partir da F11 o
 * Beauty Autopilot passa a PROPOR follow-ups (sim abandonada, aniversário,
 * manutenção). Sem o gate, um follow-up automático poderia atropelar
 * "não quero mais receber mensagens desta empresa" da cliente — violação
 * de LGPD Art.14. O gate garante que a autopilot só cutuque contatos que
 * autorizaram, transversal a TODAS as verticais.
 */
import db from "./db.js";
import { LgpdService } from "./LgpdService.js";

// Escopo canônico de consent pra outbound. NUNCA aceitar outro no gate
// (RN-BS-04 escopos separados). O tipo aparece em `LgpdService.categories`
// (default `['marketing','dados_pessoais','perfilamento','comunicacoes']`).
export const OUTBOUND_CONSENT_SCOPE = "comunicacoes" as const;

export type OutboundGuardDecision =
  | { allow: true; reason: "flag_off" | "unknown_contact" | "consent_active" }
  | { allow: false; reason: "consent_missing"; contactId: string; contactName: string | null };

export class OutboundConsentGuardService {
  /**
   * Decide se um sendMessage pode prosseguir. Chamado pelo sink canônico
   * (`MessageProviderService.sendMessage`) DEPOIS do lookup do canal e
   * ANTES do fetch pro provedor. Determinístico, síncrono, sem side-effect.
   *
   * @param orgId       id do tenant dono do canal (channel.organization_id)
   * @param identifier  recipientIdentifier (telefone E.164, handle Instagram, etc.)
   */
  static evaluate(orgId: string, identifier: string): OutboundGuardDecision {
    // Flag off (default) → nunca bloqueia. 0-regressão dura pras 30+
    // callers existentes.
    if (!this.isEnabled(orgId)) {
      return { allow: true, reason: "flag_off" };
    }

    const contact = this.findContactByIdentifier(orgId, identifier);
    if (!contact) {
      // Mensagem pra identifier sem contato cadastrado NA ORG.
      // Interpretamos como comunicação de sistema (broadcast/teste/admin);
      // consent LGPD não se aplica. Alternativa restritiva (bloquear tudo
      // que não bate) quebraria fluxos operacionais existentes — se o
      // operador quer disciplina total, cadastra o contato antes.
      return { allow: true, reason: "unknown_contact" };
    }

    const has = LgpdService.hasConsent(orgId, contact.id, OUTBOUND_CONSENT_SCOPE);
    if (!has) {
      return {
        allow: false,
        reason: "consent_missing",
        contactId: contact.id,
        contactName: contact.name || null,
      };
    }
    return { allow: true, reason: "consent_active" };
  }

  /**
   * Rápido: a flag `outbound_consent_required` está ligada nesta org?
   * Best-effort — coluna aditiva; se ainda não existe (migração antiga),
   * retorna false (0-regressão).
   */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(
          `SELECT outbound_consent_required FROM organization_settings WHERE organization_id = ?`,
        )
        .get(orgId) as { outbound_consent_required?: number } | undefined;
      return Number(r?.outbound_consent_required || 0) === 1;
    } catch {
      return false;
    }
  }

  /**
   * Liga/desliga a flag. Só o dono (rota admin) deveria chamar; o service
   * expõe a operação primitiva. Idempotente.
   */
  static setEnabled(orgId: string, enabled: boolean): void {
    db.prepare(
      `UPDATE organization_settings SET outbound_consent_required = ? WHERE organization_id = ?`,
    ).run(enabled ? 1 : 0, orgId);
  }

  /**
   * Lookup contato por identifier. Retorna só o primeiro match — se um
   * identifier bate em 2 contatos da mesma org (raro; dado sujo), o guard
   * usa o primeiro por rowid e SEMPRE APLICA a regra pra ele. É defensivo:
   * bloquear pelo primeiro é o comportamento seguro (a cliente que reclamou
   * está listada em algum lugar).
   */
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
}

/**
 * Erro específico lançado pelo `MessageProviderService.sendMessage` quando
 * o guard bloqueia. Nome fixo pra callers upstream detectarem (`err?.code`)
 * e degradarem gracefully (ex.: marcar delivery como `blocked_consent` em
 * vez de `failed`).
 */
export class OutboundBlockedError extends Error {
  code: string;
  contactId?: string;
  contactName?: string | null;
  constructor(reason: string, opts: { contactId?: string; contactName?: string | null } = {}) {
    super(
      `Envio bloqueado por gate LGPD (reason=${reason}): sem consent 'comunicacoes' do contato.`,
    );
    this.name = "OutboundBlockedError";
    this.code = `outbound_blocked:${reason}`;
    this.contactId = opts.contactId;
    this.contactName = opts.contactName || null;
  }
}

export default OutboundConsentGuardService;
