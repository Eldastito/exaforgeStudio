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

/** Se true, o webhook EXIGE o segredo. Com a env definida, sempre exige. */
export function isWebhookEnforced(): boolean {
  if (process.env.WEBHOOK_SECRET) return true;
  return getConfig("webhook_enforce") === "1";
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
