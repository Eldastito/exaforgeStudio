/**
 * mediaSigning — URL assinada para a MÍDIA DE CONVERSA (foto que o cliente manda) — SEC-F21.
 *
 * `/media` é servido público e mistura conteúdo PÚBLICO POR DESIGN (imagem de produto na
 * vitrine, criação do Estúdio que o Instagram/Facebook BUSCAM pra publicar) com conteúdo
 * SENSÍVEL (mídia recebida do cliente no WhatsApp). Privatizar tudo quebraria vitrine +
 * publicação social. Solução: SÓ a mídia de conversa (salva por `saveMediaBase64`) vai para
 * `/media/private/` e é entregue por URL ASSINADA (HMAC + TTL, reusa `fileSigning`); produto/
 * estúdio seguem públicos.
 *
 * Fail-closed OPT-IN: o `/media/private/` só EXIGE assinatura quando `MEDIA_PRIVATE_CHAT=1`.
 * Nasce desligado → 0-regressão (o arquivo é servido como hoje) até o operador validar que as
 * imagens do chat ainda aparecem e então LIGAR a exigência. `signChatMediaUrl` é NO-OP para
 * qualquer URL fora de `/media/private/`, então aplicá-lo em qualquer emissão é seguro.
 */
import { signKey, verifyKey } from "./fileSigning.js";

const SCOPE = "chat_media";
const PREFIX = "/media/private/";
// TTL generoso: a URL é RE-ASSINADA a cada leitura da API (histórico/emit), então não precisa
// ser curta pra manter a proteção; longa evita a imagem "sumir" durante o uso normal.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `true` quando o operador ligou a exigência de assinatura no `/media/private/`. */
export function chatMediaEnforced(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.MEDIA_PRIVATE_CHAT || ""));
}

/** É uma URL de mídia de conversa (privada)? */
export function isChatMediaUrl(url: unknown): boolean {
  return typeof url === "string" && url.startsWith(PREFIX);
}

/**
 * Assina uma URL de mídia de CONVERSA (`/media/private/...`) anexando `?exp&sig`. Qualquer
 * outra URL (produto/estúdio/externa/null) volta INTACTA — seguro aplicar em qualquer emissão.
 */
export function signChatMediaUrl<T extends string | null | undefined>(url: T, now = Date.now()): T {
  if (!isChatMediaUrl(url)) return url;
  const key = (url as string).slice("/media/".length); // "private/<name>"
  try {
    const { exp, sig } = signKey(SCOPE, key, TTL_MS, now);
    const sep = (url as string).includes("?") ? "&" : "?";
    return `${url}${sep}exp=${exp}&sig=${sig}` as T;
  } catch {
    return url; // key inválida (nome estranho) → não quebra a emissão
  }
}

/**
 * Verifica uma requisição a `/media/private/<name>`. `pathAfterMount` é o que sobra depois do
 * mount `/media/private` (ex.: `/<name>`). `false` se assinatura ausente/inválida/expirada.
 */
export function verifyChatMediaRequest(pathAfterMount: string, query: any, now = Date.now()): boolean {
  const name = String(pathAfterMount || "").replace(/^\/+/, "");
  return verifyKey(SCOPE, "private/" + name, query?.exp, query?.sig, now);
}
