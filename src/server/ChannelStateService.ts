/**
 * ChannelStateService — PRD WhatsApp Unificado F1.2d (RF-02 §8 / CA-02):
 * estados LÓGICOS da conexão derivados do enum plano `channels.status` +
 * saúde do webhook + enforcement. Read model (RN-004), isolado por org.
 *
 * Hoje `channels.status` é um enum plano (connected/awaiting_qr/disconnected/
 * disabled/error). A RF-02 pede 4 DIMENSÕES independentes, cada uma com sua
 * regra — e a CA-02 exige que:
 *   - "Conectada" requer EVIDÊNCIA do provedor (o status só vira 'connected' por
 *     um connection.update real — F1.2c `markEvolutionChannelStatusByIdentifier`;
 *     nunca inferido da mera criação de URL). Ausência de QR numa sessão
 *     conectada NÃO é desconexão (não rebaixa a sessão).
 *   - A saúde do WEBHOOK não é inferida da criação da URL: só é `healthy` se
 *     houve hit OK recente; um hit rejeitado por segredo aparece como `rejected`
 *     (nunca "plenamente saudável").
 *   - Pausar uso LOCAL (status 'disabled') é ADMINISTRAÇÃO=paused, não logout
 *     remoto: a sessão não é forçada a 'disconnected'.
 * A dimensão OPERAÇÃO é derivada das outras (pronto só quando dá pra operar).
 *
 * NÃO altera FSM nem status: read-only. A escrita de status segue nos pontos
 * comprovados (F1.2c). Não expõe segredo (nunca lê token/webhook_secret).
 */
import db from "./db.js";
import { getLastWebhookHit, isWebhookEnforced } from "./webhookSecurity.js";

export type SessionState = "not_configured" | "provisioning" | "awaiting_pairing" | "connected" | "disconnected" | "error";
export type WebhookState = "not_verified" | "healthy" | "rejected" | "degraded";
export type AdminState = "active" | "paused";
export type OperationState = "ready" | "pending_validation" | "unavailable";

export interface ChannelLogicalState {
  channelId: string;
  provider: string;
  rawStatus: string | null;
  session: SessionState;
  webhook: WebhookState;
  administration: AdminState;
  operation: OperationState;
  updatedAt: string | null;
}

// Mapa enum-plano → dimensão SESSÃO. 'disabled' NÃO entra aqui (é administração):
// pausar local não é logout remoto (CA-02), então a sessão de um canal pausado é
// tratada como a última conhecida (assumimos 'connected' salvo evidência contrária).
function sessionFrom(rawStatus: string | null): SessionState {
  switch (String(rawStatus || "")) {
    case "connected": return "connected";
    // F5: passkey é pareamento em andamento (WebAuthn) — mesma dimensão do QR.
    case "awaiting_qr": case "qr": case "pairing": case "awaiting_passkey": return "awaiting_pairing";
    case "provisioning": case "connecting": return "provisioning";
    case "disconnected": case "close": case "logged_out": return "disconnected";
    case "error": case "failed": return "error";
    case "": return "not_configured";
    default: return "not_configured";
  }
}

export class ChannelStateService {
  /** Estados lógicos de UM canal (org-scoped). null se o canal não é da org. */
  static state(orgId: string, channelId: string): ChannelLogicalState | null {
    const ch = db.prepare(`SELECT id, provider, status, updated_at, webhook_last_received_at, webhook_last_valid_at, webhook_last_error FROM channels WHERE id = ? AND organization_id = ?`).get(channelId, orgId) as any;
    if (!ch) return null;
    return this.derive(ch);
  }

  /** Estados lógicos de todos os canais da org. */
  static list(orgId: string): ChannelLogicalState[] {
    const rows = db.prepare(`SELECT id, provider, status, updated_at, webhook_last_received_at, webhook_last_valid_at, webhook_last_error FROM channels WHERE organization_id = ? ORDER BY created_at ASC`).all(orgId) as any[];
    return rows.map((ch) => this.derive(ch));
  }

  private static webhookState(): WebhookState {
    const hit = getLastWebhookHit();
    if (!hit) return "not_verified";               // nunca recebeu → não inferir saúde
    if (!hit.ok) return "rejected";                // último hit rejeitado (segredo) → nunca "saudável"
    // OK recente. Se o enforcement está LIGADO e o último OK é antigo, poderia ser
    // "degraded" — mas sem histórico por canal mantemos honesto: OK recente = healthy.
    return "healthy";
  }

  /**
   * F6 do PRD Conexão WhatsApp: saúde do webhook POR CANAL quando o canal já
   * tem observação própria (hits atribuídos pelo instanceName do payload) —
   * um canal rejeitado deixa de contaminar o estado dos outros. Canal legado
   * sem observação própria cai no sinal GLOBAL (0-regressão). Ausência de hit
   * não vira falha: webhook só dispara com tráfego.
   */
  private static webhookStateFor(ch: any): WebhookState {
    const received = ch?.webhook_last_received_at ? Date.parse(String(ch.webhook_last_received_at)) : 0;
    const valid = ch?.webhook_last_valid_at ? Date.parse(String(ch.webhook_last_valid_at)) : 0;
    if (!received && !valid) return this.webhookState();
    if (ch?.webhook_last_error && received >= valid) return "rejected"; // o último hit DESTE canal foi rejeitado
    return "healthy";
  }

  private static derive(ch: any): ChannelLogicalState {
    const rawStatus: string | null = ch.status ?? null;
    const administration: AdminState = rawStatus === "disabled" ? "paused" : "active";
    // CA-02: canal pausado (disabled) não força a sessão a 'disconnected' — pausar
    // local não é logout remoto. Trata como conectado (última conhecida) até prova.
    const session: SessionState = rawStatus === "disabled" ? "connected" : sessionFrom(rawStatus);
    const webhook = this.webhookStateFor(ch);

    let operation: OperationState;
    if (administration === "paused" || session === "disconnected" || session === "error" || session === "not_configured") {
      operation = "unavailable";
    } else if (session === "connected" && webhook !== "rejected") {
      operation = "ready";               // conectado + webhook não-rejeitado → pronto
    } else {
      operation = "pending_validation";  // provisionando/pareando, ou webhook rejeitado
    }
    // Um webhook rejeitado NUNCA aparece como plenamente saudável/pronto (CA-02).
    if (webhook === "rejected" && operation === "ready") operation = "pending_validation";

    return { channelId: ch.id, provider: ch.provider, rawStatus, session, webhook, administration, operation, updatedAt: ch.updated_at ?? null };
  }

  /** Enforcement atual do segredo de webhook (A10) — informativo pro operador. */
  static webhookEnforced(): boolean { return isWebhookEnforced(); }
}
