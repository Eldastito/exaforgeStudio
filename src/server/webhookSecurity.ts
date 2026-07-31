import crypto from "crypto";
import db from "./db.js";

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
export function getLastWebhookHit(): { at: number; ok: boolean; reason: string } | null {
  try { const v = getConfig("webhook_last"); return v ? JSON.parse(v) : null; } catch { return null; }
}
