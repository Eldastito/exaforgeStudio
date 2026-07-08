/**
 * TEST — LgpdService (ADR-056).
 *
 * LGPD (Lei 13.709) obriga: consentimento granular, portabilidade e direito
 * ao esquecimento com prazo legal. Um bug em qualquer um desses fluxos
 * expõe a empresa a autuação da ANPD e à ação civil pública.
 *
 * Cobertura:
 *  - Consentimento: grant/revoke/summary com isolamento por org e contato.
 *  - Exportação (portabilidade): dados vêm completos, isolados por org.
 *  - Direito ao esquecimento: contato anonimizado, mensagens purgadas,
 *    pedidos preservados (histórico financeiro sem PII).
 *  - Retenção: purga apenas mensagens de tickets encerrados, respeita janela.
 *  - Isolamento entre orgs: contato de A não afeta B em nenhum fluxo.
 *
 * Uso: npm run test:lgpd-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lgpd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-lgpd-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  // ==== Setup ====
  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgA, "Loja A");
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgB, "Loja B");

  const chA = randomUUID(), chB = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal A', 'active')`).run(chA, orgA);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal B', 'active')`).run(chB, orgB);

  const contactA = randomUUID();
  const contactB = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(contactA, orgA, chA, "Alice PII", "5511911110000", "alice@example.com");
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(contactB, orgB, chB, "Bruno PII", "5511922220000", "bruno@example.com");

  const ticketOldClosed = randomUUID(); // Ticket antigo fechado — mensagens devem ser purgadas em retentionPass.
  const ticketRecentClosed = randomUUID(); // Ticket recente fechado — não deve ser purgado.
  const ticketOpen = randomUUID(); // Ticket aberto — nunca purgado.
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, closed_at) VALUES (?, ?, ?, 'closed', datetime('now', '-500 days'))`).run(ticketOldClosed, orgA, contactA);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, closed_at) VALUES (?, ?, ?, 'closed', datetime('now', '-10 days'))`).run(ticketRecentClosed, orgA, contactA);
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status) VALUES (?, ?, ?, 'open')`).run(ticketOpen, orgA, contactA);

  const msgOld = randomUUID(), msgRecent = randomUUID(), msgOpen = randomUUID(), msgOrgB = randomUUID();
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'contact', 'Segredo antigo — precisa ser purgado')`).run(msgOld, orgA, ticketOldClosed);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'contact', 'Mensagem recente ainda em janela')`).run(msgRecent, orgA, ticketRecentClosed);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'contact', 'Ticket aberto — nunca purgar')`).run(msgOpen, orgA, ticketOpen);

  // Pedidos (não devem sumir no forget)
  db.prepare(`INSERT INTO orders (id, organization_id, contact_id, status, total_amount) VALUES (?, ?, ?, 'completed', 250.00)`).run(randomUUID(), orgA, contactA);

  // ==== 1. Consentimento — grant + hasConsent ====
  console.log("\n=== 1. Consentimento — grant/hasConsent ===");
  const cid = LgpdService.grantConsent(orgA, contactA, "marketing", { legalBasis: "consentimento", policyVersion: "1.0", channel: "whatsapp", actorId: "user_x" });
  check("1.1 grantConsent retorna id (uuid)", typeof cid === "string" && cid.length >= 32);
  check("1.2 hasConsent devolve true após grant", LgpdService.hasConsent(orgA, contactA, "marketing") === true);
  check("1.3 hasConsent para categoria diferente é false", LgpdService.hasConsent(orgA, contactA, "perfilamento") === false);

  // Isolamento por org — mesmo contactId em outra org NÃO tem consentimento
  check("1.4 isolamento por org — hasConsent em orgB é false", LgpdService.hasConsent(orgB, contactA, "marketing") === false);

  // Grant novamente MESMA categoria: revoga o anterior + cria novo
  const cid2 = LgpdService.grantConsent(orgA, contactA, "marketing", { policyVersion: "2.0" });
  check("1.5 novo grant retorna novo id (não repetido)", cid2 !== cid);
  const consents = LgpdService.getConsentsForContact(orgA, contactA);
  const marketingConsents = consents.filter((c: any) => c.consent_type === "marketing");
  check("1.6 histórico contém 2 registros de marketing (revogado + ativo)", marketingConsents.length === 2);
  check("1.7 apenas um está com granted=1 (o novo)", marketingConsents.filter((c: any) => c.granted === 1).length === 1);

  // ==== 2. Revoke ====
  console.log("\n=== 2. Revoke ===");
  check("2.1 revoke retorna true na primeira chamada", LgpdService.revokeConsent(orgA, contactA, "marketing") === true);
  check("2.2 hasConsent volta a false", LgpdService.hasConsent(orgA, contactA, "marketing") === false);
  check("2.3 segundo revoke é idempotente (retorna false, não crasha)", LgpdService.revokeConsent(orgA, contactA, "marketing") === false);

  // ==== 3. Summary ====
  console.log("\n=== 3. Summary de consentimentos ===");
  LgpdService.grantConsent(orgA, contactA, "perfilamento");
  const summary = LgpdService.getConsentSummary(orgA);
  const marketingSummary = summary.find((s: any) => s.type === "marketing");
  const perfSummary = summary.find((s: any) => s.type === "perfilamento");
  check("3.1 summary tem marketing", !!marketingSummary && Number(marketingSummary.revoked) >= 2);
  check("3.2 summary tem perfilamento", !!perfSummary && Number(perfSummary.granted) === 1);

  // ==== 4. Config de consentimento ====
  console.log("\n=== 4. Config de consentimento ===");
  const cfg0 = LgpdService.getConsentConfig(orgA);
  check("4.1 categorias default sensatas", cfg0.categories.includes("marketing") && cfg0.categories.includes("dados_pessoais"));
  LgpdService.updateConsentConfig(orgA, { categories: ["marketing", "cookies"], bannerText: "Coleto seus dados...", policyVersion: "3.0" });
  const cfg1 = LgpdService.getConsentConfig(orgA);
  check("4.2 categorias customizadas persistem", cfg1.categories.join(",") === "marketing,cookies");
  check("4.3 bannerText persiste", cfg1.bannerText.includes("Coleto"));
  check("4.4 policyVersion persiste", cfg1.policyVersion === "3.0");

  // ==== 5. Exportação (portabilidade) ====
  console.log("\n=== 5. Exportação (portabilidade) ===");
  const exp = LgpdService.exportContact(orgA, contactA);
  check("5.1 contato exportado tem PII", exp.contact.name === "Alice PII" && exp.contact.email === "alice@example.com");
  check("5.2 exporta tickets", Array.isArray(exp.tickets) && exp.tickets.length === 3);
  check("5.3 exporta mensagens", Array.isArray(exp.messages) && exp.messages.length === 3);
  check("5.4 exporta pedidos", Array.isArray(exp.orders) && exp.orders.length === 1);
  check("5.5 exporta com timestamp", typeof exp.exportedAt === "string" && exp.exportedAt.length > 10);

  // Contato inexistente
  check("5.6 contato inexistente retorna null", LgpdService.exportContact(orgA, "nope") === null);

  // Isolamento: contato de A na orgB é null
  check("5.7 contato de A na orgB é null (isolamento)", LgpdService.exportContact(orgB, contactA) === null);

  // ==== 6. Retenção (retentionPass) ====
  console.log("\n=== 6. Retenção — purga mensagens antigas de tickets fechados ===");
  db.prepare(`UPDATE organization_settings SET retention_enabled = 1, retention_days = 90 WHERE organization_id = ?`).run(orgA);
  const passRes = LgpdService.retentionPass();
  check("6.1 pass processa pelo menos a orgA", passRes.orgs >= 1);
  check("6.2 pass purgou pelo menos a mensagem antiga", passRes.messages >= 1);

  const purgedMsg = db.prepare(`SELECT content, media_url FROM messages WHERE id = ?`).get(msgOld) as any;
  check("6.3 mensagem de ticket antigo fechado foi purgada", purgedMsg.content === "[removido por política de retenção]");
  check("6.4 media_url zerado", purgedMsg.media_url === null);

  const untouchedRecent = db.prepare(`SELECT content FROM messages WHERE id = ?`).get(msgRecent) as any;
  check("6.5 mensagem recente NÃO foi purgada (dentro da janela)", untouchedRecent.content.includes("recente"));

  const untouchedOpen = db.prepare(`SELECT content FROM messages WHERE id = ?`).get(msgOpen) as any;
  check("6.6 mensagem de ticket ABERTO nunca é purgada", untouchedOpen.content.includes("Ticket aberto"));

  // Segunda passada: idempotente (nada muda)
  const passRes2 = LgpdService.retentionPass();
  check("6.7 segundo pass não purga a mesma mensagem 2x", passRes2.messages === 0);

  // ==== 7. Direito ao esquecimento (forgetContact) ====
  console.log("\n=== 7. Direito ao esquecimento ===");
  const beforeForget = db.prepare(`SELECT COUNT(*) c FROM orders WHERE organization_id = ? AND contact_id = ?`).get(orgA, contactA) as any;

  const ok = LgpdService.forgetContact(orgA, contactA);
  check("7.1 forget retorna true para contato válido", ok === true);

  const forgotten = db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactA) as any;
  check("7.2 name é anonimizado", forgotten.name === "Contato removido");
  check("7.3 email zerado", forgotten.email === null);
  check("7.4 profile_pic_url zerado", forgotten.profile_pic_url === null);
  check("7.5 marketing_opt_out = 1", forgotten.marketing_opt_out === 1);
  check("7.6 anonymized_at preenchido", !!forgotten.anonymized_at);
  check("7.7 identifier é substituído por marcador anon_", forgotten.identifier.startsWith("anon_"));

  const msgs = db.prepare(`SELECT content FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE contact_id = ?)`).all(contactA) as any[];
  check("7.8 todas as mensagens do contato foram purgadas", msgs.every((m: any) => m.content === "[removido a pedido do titular]"));

  const afterForget = db.prepare(`SELECT COUNT(*) c FROM orders WHERE organization_id = ? AND contact_id = ?`).get(orgA, contactA) as any;
  check("7.9 pedidos PRESERVADOS (histórico financeiro sem PII)", afterForget.c === beforeForget.c);

  check("7.10 forget de contato inexistente retorna false", LgpdService.forgetContact(orgA, "nope") === false);
  check("7.11 forget de contato da OUTRA org retorna false (isolamento)", LgpdService.forgetContact(orgB, contactA) === false);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — LgpdService (ADR-056)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
