/**
 * whatsappJid — classificação/validação de JID de WhatsApp (F1.2b, achado X3).
 *
 * O inbound do Evolution derivava o remetente com um `split('@')[0].split(':')[0]`
 * CEGO: qualquer JID virava "telefone". Um JID de GRUPO (`...@g.us`), STATUS
 * (`status@broadcast`), NEWSLETTER (`...@newsletter`) ou LID (`...@lid`) virava um
 * "remetente" falso → criava contato/ticket de atendimento espúrio (RF-04/INV-01:
 * "não tratar qualquer JID como telefone removendo sufixos sem validação").
 *
 * Este módulo é PURO (sem db/rede) para ser testável fora do server.ts (que é
 * self-boot e não monta em unit test). Classifica o JID e só devolve `senderId`
 * quando é um contato INDIVIDUAL com telefone plausível.
 */

export type WhatsappJidKind = "individual" | "group" | "broadcast" | "newsletter" | "lid" | "invalid";

export interface WhatsappJidClass {
  kind: WhatsappJidKind;
  /** Telefone normalizado (só dígitos) quando kind='individual'; senão "". */
  senderId: string;
  /** Domínio do JID (parte após @), minúsculo; "" quando não havia @. */
  domain: string;
}

// E.164: máximo 15 dígitos. Mínimo conservador de 8 para não rejeitar números
// curtos legítimos de alguns países. Fora disso, não é telefone confiável.
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;

/** Só dígitos. */
function digitsOnly(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

/**
 * Classifica um JID de WhatsApp. Aceita tanto o JID completo
 * (`5521999@s.whatsapp.net`, `120xxx@g.us`) quanto um número/id cru.
 */
export function classifyWhatsappJid(rawJid: string | null | undefined): WhatsappJidClass {
  const raw = String(rawJid || "").trim();
  if (!raw) return { kind: "invalid", senderId: "", domain: "" };

  const atIdx = raw.indexOf("@");
  const local = atIdx >= 0 ? raw.slice(0, atIdx) : raw;
  const domain = atIdx >= 0 ? raw.slice(atIdx + 1).toLowerCase() : "";

  // Domínios não-individuais: nunca viram atendimento por telefone.
  if (domain === "g.us") return { kind: "group", senderId: "", domain };
  if (domain === "broadcast" || local.toLowerCase() === "status") return { kind: "broadcast", senderId: "", domain };
  if (domain === "newsletter") return { kind: "newsletter", senderId: "", domain };
  if (domain === "lid") return { kind: "lid", senderId: "", domain };

  // Individual: `s.whatsapp.net`, `c.us`, ou sem domínio (número cru). Remove o
  // sufixo de device (`:NN`) e valida como telefone plausível.
  const localNoDevice = local.split(":")[0];
  const phone = digitsOnly(localNoDevice);
  if (phone.length < MIN_PHONE_DIGITS || phone.length > MAX_PHONE_DIGITS) {
    return { kind: "invalid", senderId: "", domain };
  }
  // Domínio individual conhecido, ou ausência de domínio (número cru). Um domínio
  // DESCONHECIDO com número plausível ainda é tratado como inválido (não confia).
  if (domain === "" || domain === "s.whatsapp.net" || domain === "c.us") {
    return { kind: "individual", senderId: phone, domain };
  }
  return { kind: "invalid", senderId: "", domain };
}

/** Atalho: true só quando o JID é um contato individual com telefone plausível. */
export function isIndividualWhatsappJid(rawJid: string | null | undefined): boolean {
  return classifyWhatsappJid(rawJid).kind === "individual";
}
