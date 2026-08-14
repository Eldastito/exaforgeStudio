/**
 * TEST — URL assinada da midia de conversa (SEC-F21 / achado A8). Deterministico, sem DB.
 *
 * A midia recebida do cliente (/media/private/...) e sensivel e passa a exigir assinatura
 * (HMAC+TTL). Produto/estudio (/media/...) seguem publicos. Prova:
 *   - assina so /media/private/ (outras URLs intactas: no-op seguro em qualquer emissao);
 *   - a URL assinada verifica OK; adulterada/expirada/ausente falha;
 *   - o gate so exige com MEDIA_PRIVATE_CHAT ligado.
 *
 * Uso: npm run test:security-media-signing
 */
import { signChatMediaUrl, verifyChatMediaRequest, isChatMediaUrl, chatMediaEnforced } from "../src/server/mediaSigning.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const now = 1_000_000_000_000;
function parseQuery(url: string): any {
  const q = url.split("?")[1] || "";
  const out: any = {};
  for (const pair of q.split("&")) { const [k, v] = pair.split("="); if (k) out[k] = decodeURIComponent(v || ""); }
  return out;
}

// 1. Assina so /media/private/ (no-op no resto).
// `priv` anotado como string (nao literal): senao o TS estreita `signed !== priv` para `never`.
const priv: string = "/media/private/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg";
const signed: string = signChatMediaUrl(priv, now);
check("1.1 URL de conversa ganhou assinatura", signed !== priv && signed.includes("sig=") && signed.includes("exp="));
check("1.2 imagem de produto NAO e tocada", signChatMediaUrl("/media/produto.jpg", now) === "/media/produto.jpg");
check("1.3 URL externa NAO e tocada", signChatMediaUrl("https://cdn.x/img.jpg", now) === "https://cdn.x/img.jpg");
check("1.4 null passa como null", signChatMediaUrl(null, now) === null);
check("1.5 isChatMediaUrl reconhece /media/private/", isChatMediaUrl(priv) === true && isChatMediaUrl("/media/x.jpg") === false);

// 2. A assinatura verifica; adulteracao/expiracao/ausencia falham.
const name = "/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg"; // caminho depois do mount /media/private
const q = parseQuery(signed);
check("2.1 assinatura valida -> verifica OK", verifyChatMediaRequest(name, q, now + 1000) === true);
check("2.2 sig adulterado -> falha", verifyChatMediaRequest(name, { exp: q.exp, sig: "deadbeef" }, now + 1000) === false);
check("2.3 sem assinatura -> falha", verifyChatMediaRequest(name, {}, now + 1000) === false);
check("2.4 expirado -> falha", verifyChatMediaRequest(name, q, now + 8 * 24 * 60 * 60 * 1000) === false);
check("2.5 arquivo diferente com a mesma assinatura -> falha", verifyChatMediaRequest("/outro.jpg", q, now + 1000) === false);
check("2.6 path traversal recusado", verifyChatMediaRequest("/../secret.jpg", q, now + 1000) === false);

// 3. Gate opt-in.
check("3.1 sem MEDIA_PRIVATE_CHAT -> nao exige", chatMediaEnforced({}) === false);
check("3.2 MEDIA_PRIVATE_CHAT=1 -> exige", chatMediaEnforced({ MEDIA_PRIVATE_CHAT: "1" }) === true);
check("3.3 MEDIA_PRIVATE_CHAT=true -> exige", chatMediaEnforced({ MEDIA_PRIVATE_CHAT: "true" }) === true);

const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log("  x " + r.name);
console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-media-signing: " + passed + "/" + results.length + " checks");
process.exit(failures === 0 ? 0 : 1);
