/**
 * TEST — Regressão do envio de mensagem pelo Instagram Direct (ADR-098).
 *
 * O bug histórico: `MessageProviderService.sendMessage` enviava a resposta ao
 * Direct via `graph.facebook.com`, host que rejeita 100% dos envios do produto
 * "Instagram com Instagram Login" em silêncio — o cliente nunca recebe a
 * resposta da IA. O host correto é `graph.instagram.com`.
 *
 * Este teste TRAVA o caminho: mocka o fetch global e verifica host + body do
 * envio Instagram. Se alguém trocar o host de volta, o CI quebra.
 *
 * Uso: npm run test:instagram-send
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-igsend-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-igsend-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Cria um canal Instagram com token.
  const orgId = randomUUID();
  const channelId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'Loja IG', 'active')`).run(orgId);
  db.prepare(
    `INSERT INTO channels (id, organization_id, name, provider, identifier, token_encrypted, status)
     VALUES (?, ?, 'Instagram TOULON', 'instagram', 'me', ?, 'active')`
  ).run(channelId, orgId, "IG_USER_TOKEN_123");

  // Mocka o fetch global para capturar a chamada sem bater na Meta.
  let capturedUrl = "";
  let capturedBody: any = null;
  let capturedAuth = "";
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedAuth = init?.headers?.Authorization || init?.headers?.authorization || "";
    try { capturedBody = JSON.parse(init?.body || "{}"); } catch { capturedBody = null; }
    return {
      ok: true,
      status: 200,
      json: async () => ({ message_id: "mid.IG_TEST_123" }),
      text: async () => "",
    } as any;
  };

  let returnedId: string | undefined;
  try {
    returnedId = await MessageProviderService.sendMessage(channelId, "5511999998888", "Olá pelo Direct!");
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  // 1. Host CORRETO — graph.instagram.com (não graph.facebook.com).
  check("1.1 usa host graph.instagram.com", capturedUrl.startsWith("https://graph.instagram.com/"));
  check("1.2 NÃO usa graph.facebook.com (bug histórico)", !capturedUrl.includes("graph.facebook.com"));
  check("1.3 endpoint /me/messages", capturedUrl.includes("/me/messages"));

  // 2. Body no formato do Instagram Messaging.
  check("2.1 body.recipient.id = destinatário", capturedBody?.recipient?.id === "5511999998888");
  check("2.2 body.message.text = conteúdo", capturedBody?.message?.text === "Olá pelo Direct!");
  check("2.3 sem messaging_product (isso é WhatsApp Cloud)", capturedBody?.messaging_product === undefined);

  // 3. Autenticação Bearer com o token do canal.
  check("3.1 Authorization Bearer com token do canal", capturedAuth === "Bearer IG_USER_TOKEN_123");

  // 4. Retorna o message_id do provedor (para correlacionar recibos).
  check("4.1 devolve message_id do Instagram", returnedId === "mid.IG_TEST_123");

  console.log("\n=== test:instagram-send ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Envio Instagram travado no host/body corretos.");
}

main().catch((e) => { console.error(e); process.exit(1); });
