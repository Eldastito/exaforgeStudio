import crypto from "crypto";
import db from "./db.js";
import { ChannelWebhookCredentialService } from "./ChannelWebhookCredentialService.js";

// Segurança do webhook do WhatsApp (Evolution), self-service.
// O app gera e guarda um segredo automaticamente (persistido em app_config),
// para que o dono não precise mexer em variáveis de ambiente. A env
// WEBHOOK_SECRET, se definida, tem prioridade e força a exigência do segredo.

function getConfig(key: string): string | null {
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as any;
  return row?.value ?? null;
}
function setConfig(key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(key, value);
}

function genSecret(): string {
  return "whk_" + crypto.randomBytes(18).toString("hex");
}

/** Segredo guardado (gera e persiste na 1ª vez). */
export function getStoredWebhookSecret(): string {
  let s = getConfig("webhook_secret");
  if (!s) { s = genSecret(); setConfig("webhook_secret", s); }
  return s;
}

/** Segredo efetivo: a env tem prioridade; senão usa o guardado. */
export function effectiveWebhookSecret(): string {
  return process.env.WEBHOOK_SECRET || getStoredWebhookSecret();
}

/**
 * Se true, o webhook EXIGE o segredo. Com a env definida, sempre exige.
 * Fase 30: enforcement torna-se default-ON se QUALQUER organização tem
 * o módulo `clinica` habilitado. Racional: os fluxos SIM/NÃO/vaga do
 * módulo clínico transformam mensagem no webhook em ação clínica
 * (confirmar/cancelar consulta, aceitar vaga) — sem enforcement, atacante
 * que descobrir a URL do webhook forja resposta em nome de qualquer
 * paciente. Zero opt-in do admin: presença de dado clínico é o gatilho.
 */
export function isWebhookEnforced(): boolean {
  if (process.env.WEBHOOK_SECRET) return true;
  // SEC-F5 (SEC-05): switch opt-in pra EXIGIR verificação sem depender de org clínica.
  // O operador liga WEBHOOK_STRICT=1 depois de configurar o segredo nos dois lados.
  if (/^(1|true|yes|on)$/i.test(String(process.env.WEBHOOK_STRICT || ""))) return true;
  if (getConfig("webhook_enforce") === "1") return true;
  // Fase 30: presença de qualquer org com módulo clínica ativo
  try {
    const r = db.prepare(
      `SELECT 1 FROM organization_settings
        WHERE COALESCE(enabled_modules, '') LIKE '%clinica%' LIMIT 1`
    ).get() as any;
    if (r) return true;
  } catch { /* schema pré-clínica — noop */ }
  return false;
}

export function setWebhookEnforced(on: boolean) {
  setConfig("webhook_enforce", on ? "1" : "0");
}

/** Gera um novo segredo (só faz sentido quando não está usando a env). */
export function rotateStoredWebhookSecret(): string {
  const s = genSecret();
  setConfig("webhook_secret", s);
  return s;
}

export function usingEnvSecret(): boolean {
  return !!process.env.WEBHOOK_SECRET;
}

// Diagnóstico: registra/expõe a última chamada do webhook do WhatsApp para o
// dono ver na tela se as mensagens estão chegando e sendo aceitas ou rejeitadas.
export function recordWebhookHit(ok: boolean, reason: string) {
  try { setConfig("webhook_last", JSON.stringify({ at: Date.now(), ok, reason })); } catch (e) { /* noop */ }
}

// PRONTIDÃO PARA ENFORCEMENT (anti-lockout) — quando a última vez que o
// provedor mandou um segredo VÁLIDO. Fica EM MEMÓRIA de propósito: adicionar
// uma escrita no banco por webhook agravaria a instabilidade (writes síncronos
// travam o event-loop). Reset a cada restart é aceitável — basta uma mensagem
// de teste pra rearmar. Alimenta o guard que impede ligar o enforcement às
// cegas e derrubar o WhatsApp de entrada.
let lastValidSecretAt = 0;
export function noteValidSecretSeen(now: number = Date.now()): void { lastValidSecretAt = now; }
export function getLastValidSecretAt(): number | null { return lastValidSecretAt > 0 ? lastValidSecretAt : null; }

/** Só liga se ele é seguro. Idempotente quando já está enforçado. */
export function enforcementReadiness(windowMs = 30 * 60 * 1000, now: number = Date.now()): {
  enforced: boolean; usingEnv: boolean; validSecretSeenAt: number | null; recentValid: boolean; canEnable: boolean;
} {
  const enforced = isWebhookEnforced();
  const usingEnv = usingEnvSecret();
  const validSecretSeenAt = getLastValidSecretAt();
  const recentValid = validSecretSeenAt != null && (now - validSecretSeenAt) <= windowMs;
  // Pode ligar se já está enforçado (não muda nada) OU se viu segredo válido recente.
  const canEnable = enforced || recentValid;
  return { enforced, usingEnv, validSecretSeenAt, recentValid, canEnable };
}
export function getLastWebhookHit(): { at: number; ok: boolean; reason: string } | null {
  try { const v = getConfig("webhook_last"); return v ? JSON.parse(v) : null; } catch { return null; }
}

/**
 * SEC-F6 (SEC-05 / A7) — anti-replay para webhooks inbound. Registra `(provider, event_id)`;
 * retorna `true` na PRIMEIRA vez (processar) e `false` numa repetição (ignorar). Sem `event_id`
 * (payload não identificável) → `true` (não bloqueia a 1ª entrega; não há como deduplicar).
 * Best-effort: qualquer erro de storage devolve `true` (nunca DERRUBA a entrega legítima).
 */
/**
 * F6 do PRD Conexão WhatsApp — validação ÚNICA do segredo recebido no webhook:
 * aceita o segredo GLOBAL (canais legados registrados com a URL antiga) OU a
 * credencial POR CANAL (`whc_...`, com janela de rotação). Quando a credencial
 * do canal casa, devolve o identifier — o handler atribui a saúde ao canal
 * certo. Comparações em tempo constante nos dois caminhos.
 */
export function checkWebhookSecret(provided: string): { ok: boolean; channelIdentifier?: string } {
  const p = String(provided || "");
  const expected = effectiveWebhookSecret();
  const a = Buffer.from(p);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  try {
    const hit = ChannelWebhookCredentialService.verify(p);
    if (hit) return { ok: true, channelIdentifier: hit.identifier };
  } catch { /* best-effort — cai no rejeitado */ }
  return { ok: false };
}

export function claimWebhookEvent(provider: string, eventId: string | null | undefined): boolean {
  const id = String(eventId || "").trim();
  if (!id) return true; // sem identificador → não há como deduplicar; processa
  try {
    const info = db.prepare(
      "INSERT OR IGNORE INTO webhook_inbound_events (id, provider, event_id) VALUES (?, ?, ?)"
    ).run(`${provider}:${id}`, provider, id);
    return info.changes > 0; // 1ª vez → 1 mudança (novo); replay → 0 (já existia)
  } catch { return true; }
}
