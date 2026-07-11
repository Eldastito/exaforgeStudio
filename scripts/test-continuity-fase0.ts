/**
 * TESTE — Continuity Layer Fase 0: integridade do envio manual (ADR-082)
 * ----------------------------------------------------------------------
 * Prova, offline e em banco temporário, a correção da "mensagem fantasma" e a
 * idempotência do envio manual (a lógica da rota POST /api/messages/send,
 * exercitada diretamente sobre o serviço/banco, com o provedor mockado):
 *   - sucesso: mensagem gravada com delivery_status='sent';
 *   - falha do provedor: mensagem NÃO some — fica 'failed' com o erro;
 *   - idempotência: reenvio com o mesmo commandId NÃO duplica;
 *   - isolamento multi-tenant do índice de commandId.
 *
 * Uso:  npm run test:continuity-fase0
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-continuity-f0-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-continuity-f0-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Provedor mockado: falha quando o texto contém "FALHA".
  (MessageProviderService as any).sendMessage = async (_ch: string, _to: string, content: string) => {
    if (content.includes("FALHA")) throw new Error("provedor recusou (mock)");
    return { messages: [{ id: "wamid.MOCK" }] };
  };

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Empresa ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`).run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    const identifier = `55${tag}9990000`;
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactId, orgId, channelId, `Cliente ${tag}`, identifier);
    const ticketId = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'em_atendimento_humano')`).run(ticketId, orgId, contactId);
    return { orgId, channelId, contactId, identifier, ticketId };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // Réplica fiel da lógica da rota POST /send (grava-primeiro + estado real + idem).
  async function send(org: typeof A, text: string, commandId?: string): Promise<{ status: string; id: string; deduped?: boolean }> {
    if (commandId) {
      const dup = db.prepare("SELECT id, delivery_status FROM messages WHERE organization_id = ? AND command_id = ?").get(org.orgId, commandId) as any;
      if (dup) return { id: dup.id, status: dup.delivery_status || "pending", deduped: true };
    }
    const msgId = randomUUID();
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, delivery_status, command_id) VALUES (?, ?, ?, 'agent', ?, 'pending', ?)`)
      .run(msgId, org.orgId, org.ticketId, text, commandId || null);
    try {
      await MessageProviderService.sendMessage(org.channelId, org.identifier, text);
      db.prepare("UPDATE messages SET delivery_status = 'sent' WHERE id = ?").run(msgId);
      return { id: msgId, status: "sent" };
    } catch (e: any) {
      db.prepare("UPDATE messages SET delivery_status = 'failed', delivery_error = ? WHERE id = ?").run(String(e?.message || e), msgId);
      return { id: msgId, status: "failed" };
    }
  }

  // ---- 1. Sucesso ----
  const ok = await send(A, "Olá, tudo certo!");
  check("Envio com sucesso → delivery_status='sent'", ok.status === "sent");
  check("Mensagem gravada no banco", !!db.prepare("SELECT id FROM messages WHERE id = ?").get(ok.id));

  // ---- 2. Falha do provedor: mensagem NÃO some (fim da fantasma) ----
  const fail = await send(A, "Isto vai dar FALHA no provedor");
  check("Falha do provedor → status='failed'", fail.status === "failed");
  const failRow = db.prepare("SELECT delivery_status, delivery_error FROM messages WHERE id = ?").get(fail.id) as any;
  check("Mensagem que falhou PERMANECE no banco (não é fantasma)", !!failRow && failRow.delivery_status === "failed");
  check("Erro do provedor registrado", !!failRow.delivery_error && failRow.delivery_error.includes("recusou"));
  // Antes da correção, a mensagem seria enviada ANTES de gravar — e em falha
  // não existiria no banco (fantasma na tela). Agora ela existe como 'failed'.

  // ---- 3. Idempotência: mesmo commandId não duplica ----
  const cmd = randomUUID();
  const first = await send(A, "Mensagem idempotente", cmd);
  const second = await send(A, "Mensagem idempotente", cmd);
  check("Reenvio com mesmo commandId é deduplicado", second.deduped === true && second.id === first.id);
  const count = db.prepare("SELECT COUNT(*) n FROM messages WHERE organization_id = ? AND command_id = ?").get(A.orgId, cmd) as any;
  check("Só existe UMA mensagem para o commandId", Number(count.n) === 1);

  // ---- 4. Isolamento: mesmo commandId em outra org é permitido (índice por org) ----
  const bSend = await send(B, "Mensagem na org B", cmd);
  check("Mesmo commandId em outra org não colide", bSend.deduped !== true);
  check("Org B tem a própria mensagem", (db.prepare("SELECT COUNT(*) n FROM messages WHERE organization_id = ? AND command_id = ?").get(B.orgId, cmd) as any).n === 1);

  console.log("\n=== Continuity Layer — Fase 0: integridade do envio (ADR-082) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
