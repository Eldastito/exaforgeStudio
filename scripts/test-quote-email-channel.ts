/**
 * TEST — Cotação automática por e-mail (ADR-099, bloco #11, canal paralelo).
 *
 * Ao aprovar uma reposição, a cotação sai por WhatsApp aos fornecedores locais.
 * Agora, quando o fornecedor tem e-mail E a org conectou o Google, a cotação
 * também sai por e-mail (canal paralelo, não substituto). Um fornecedor que só
 * tem e-mail passa a ser alcançável. Sem Google conectado, degrada: e-mail é
 * ignorado, WhatsApp segue.
 *
 * Mocka MessageProviderService.sendMessage + GoogleOAuthService (status/gmailSend)
 * para não bater em nada externo.
 *
 * Uso: npm run test:quote-email-channel
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-quote-email-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-quote-email-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierQuoteService } = await import("../src/server/SupplierQuoteService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { GoogleOAuthService } = await import("../src/server/GoogleOAuthService.js");

  // --- Mocks ---
  let whatsSent: string[] = [];      // identifiers
  let emailsSent: string[] = [];     // to
  (MessageProviderService as any).sendMessage = async (_ch: string, to: string) => { whatsSent.push(to); return "mid_" + to; };
  let googleConnected = true;
  (GoogleOAuthService as any).status = () => ({ connected: googleConnected });
  (GoogleOAuthService as any).gmailSend = async (_org: string, to: string) => { emailsSent.push(to); return { id: "gmail_" + to }; };

  // --- Org + canal + produtos + fornecedores ---
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja Compradora', 'active')`).run(randomUUID(), orgId);
  const channelId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'Zap Loja', 'evolution', 'me', 'active')`).run(channelId, orgId);

  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, category) VALUES (?, ?, 'product', 'Camisa Polo', 'camisaria')`).run(prod, orgId);

  // 3 fornecedores: só WhatsApp / só e-mail / ambos.
  const supWhats = randomUUID(), supEmail = randomUUID(), supBoth = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email, is_supplier, supplier_categories) VALUES (?, ?, ?, 'Só Whats', '5521911110000', NULL, 1, 'camisaria')`).run(supWhats, orgId, channelId);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email, is_supplier, supplier_categories) VALUES (?, ?, ?, 'Só Email', '', 'soemail@forn.com', 1, 'camisaria')`).run(supEmail, orgId, channelId);
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email, is_supplier, supplier_categories) VALUES (?, ?, ?, 'Ambos', '5521922220000', 'ambos@forn.com', 1, 'camisaria')`).run(supBoth, orgId, channelId);

  // Requisição + item.
  const reqId = randomUUID();
  db.prepare(`INSERT INTO purchase_requisitions (id, organization_id, status, created_by) VALUES (?, ?, 'draft', 'ai')`).run(reqId, orgId);
  db.prepare(`INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 12)`).run(randomUUID(), reqId, orgId, prod);

  // ===== 1. Google conectado — WhatsApp + e-mail em paralelo =====
  const r1 = await SupplierQuoteService.sendQuotes(orgId, reqId);
  check("3 fornecedores alcançados (sent=3)", r1.sent === 3);
  check("2 e-mails enviados (só-email + ambos)", r1.emailed === 2);
  check("WhatsApp foi para os 2 com identifier", whatsSent.length === 2 && whatsSent.includes("5521911110000") && whatsSent.includes("5521922220000"));
  check("e-mail foi para só-email e ambos", emailsSent.length === 2 && emailsSent.includes("soemail@forn.com") && emailsSent.includes("ambos@forn.com"));
  check("fornecedor só-WhatsApp não recebeu e-mail", !emailsSent.includes(""));
  const quotes1 = db.prepare(`SELECT COUNT(*) c FROM purchase_quotes WHERE requisition_id = ?`).get(reqId) as any;
  check("3 cotações criadas", quotes1.c === 3);

  // ===== 2. Google NÃO conectado — e-mail degrada, WhatsApp segue =====
  whatsSent = []; emailsSent = [];
  googleConnected = false;
  const reqId2 = randomUUID();
  db.prepare(`INSERT INTO purchase_requisitions (id, organization_id, status, created_by) VALUES (?, ?, 'draft', 'ai')`).run(reqId2, orgId);
  db.prepare(`INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 5)`).run(randomUUID(), reqId2, orgId, prod);

  const r2 = await SupplierQuoteService.sendQuotes(orgId, reqId2);
  check("sem Google: nenhum e-mail (emailed=0)", r2.emailed === 0);
  check("sem Google: só os 2 com WhatsApp (sent=2)", r2.sent === 2);
  check("fornecedor só-email foi PULADO (sem canal)", whatsSent.length === 2 && emailsSent.length === 0);
  const q2 = db.prepare(`SELECT COUNT(*) c FROM purchase_quotes WHERE requisition_id = ?`).get(reqId2) as any;
  check("sem Google: 2 cotações (só-email não vira cotação órfã)", q2.c === 2);

  // --- Relatório ---
  console.log("\n=== TEST: Cotação por e-mail (ADR-099) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Canal de e-mail na cotação OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
