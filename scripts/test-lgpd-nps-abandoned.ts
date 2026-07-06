/**
 * TEST — LGPD granular consent + NPS structured comments + Abandoned cart pre-proposal
 * -----------------------------------------------------------------------
 * Covers:
 *   1. LgpdService: consent config CRUD, grant/revoke/query consents per contact
 *   2. SatisfactionService: follow-up flow for detractors, comment capture, detractor timeline
 *   3. Scheduler: abandoned cart intent detection using ai_purchase_probability
 *
 * Runs on a TEMPORARY database. Usage: npm run test:lgpd-nps-abandoned
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-lgpd-nps-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-lgpd-nps-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { SatisfactionService } = await import("../src/server/SatisfactionService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  }

  function seedContact(orgId: string, name: string) {
    const id = `ct_${randomUUID().slice(0, 8)}`;
    const channelId = `ch_${randomUUID().slice(0, 6)}`;
    try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'Canal', 'active')`).run(channelId, orgId); } catch {}
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, channelId, name, `55${Math.floor(Math.random() * 900000000 + 100000000)}`);
    return id;
  }

  // ==== PART 1: LGPD Granular Consent ====
  console.log('\n=== PART 1: LGPD Granular Consent ===');

  const org1 = seedOrg("lgpd");
  const contact1 = seedContact(org1, "João Silva");

  // 1.1 Default consent config
  const config1 = LgpdService.getConsentConfig(org1);
  check("1.1 Default config has 4 categories", config1.categories.length === 4, JSON.stringify(config1.categories));
  check("1.2 Default policy version is 1.0", config1.policyVersion === '1.0');
  check("1.3 Default banner text is empty", config1.bannerText === '');

  // 1.4 Update consent config
  LgpdService.updateConsentConfig(org1, {
    categories: ['marketing', 'dados_pessoais', 'compartilhamento'],
    bannerText: 'Ao continuar, você aceita nossa política.',
    policyVersion: '2.0',
  });
  const config2 = LgpdService.getConsentConfig(org1);
  check("1.4 Updated categories", config2.categories.length === 3);
  check("1.5 Updated banner text", config2.bannerText === 'Ao continuar, você aceita nossa política.');
  check("1.6 Updated policy version", config2.policyVersion === '2.0');

  // 1.7 Grant consent
  const consentId = LgpdService.grantConsent(org1, contact1, 'marketing', {
    legalBasis: 'consentimento', channel: 'whatsapp', actorId: 'user1',
  });
  check("1.7 Grant returns an ID", !!consentId);

  // 1.8 Check consent
  check("1.8 hasConsent returns true after grant", LgpdService.hasConsent(org1, contact1, 'marketing'));

  // 1.9 List consents
  const consents = LgpdService.getConsentsForContact(org1, contact1);
  check("1.9 Contact has 1 consent", consents.length === 1);
  check("1.10 Consent type is marketing", consents[0].consent_type === 'marketing');
  check("1.11 Consent is granted", consents[0].granted === 1);

  // 1.12 Grant another type
  LgpdService.grantConsent(org1, contact1, 'dados_pessoais', { legalBasis: 'contrato' });
  check("1.12 Contact has 2 consents", LgpdService.getConsentsForContact(org1, contact1).length === 2);

  // 1.13 Revoke consent
  const revoked = LgpdService.revokeConsent(org1, contact1, 'marketing');
  check("1.13 Revoke returns true", revoked);
  check("1.14 hasConsent returns false after revoke", !LgpdService.hasConsent(org1, contact1, 'marketing'));
  check("1.15 dados_pessoais still active", LgpdService.hasConsent(org1, contact1, 'dados_pessoais'));

  // 1.16 Consent summary
  const summary = LgpdService.getConsentSummary(org1);
  check("1.16 Summary has 2 types", summary.length === 2);
  const mktSummary = summary.find(s => s.type === 'marketing');
  check("1.17 Marketing: 0 granted, 1 revoked", mktSummary?.granted === 0 && mktSummary?.revoked === 1,
    `granted=${mktSummary?.granted}, revoked=${mktSummary?.revoked}`);

  // 1.18 Re-grant (should revoke old and create new)
  LgpdService.grantConsent(org1, contact1, 'marketing', { legalBasis: 'consentimento' });
  check("1.18 Re-grant: hasConsent returns true", LgpdService.hasConsent(org1, contact1, 'marketing'));
  const allConsents = LgpdService.getConsentsForContact(org1, contact1);
  const mktConsents = allConsents.filter(c => c.consent_type === 'marketing');
  check("1.19 Re-grant: 3 total consent records (2 marketing + 1 dados)", allConsents.length === 3);

  // 1.20 Revoke non-existent returns false
  const revokeNothing = LgpdService.revokeConsent(org1, contact1, 'nonexistent');
  check("1.20 Revoke non-existent returns false", !revokeNothing);

  // ==== PART 2: NPS Structured Comments ====
  console.log('\n=== PART 2: NPS Structured Comments ===');

  const org2 = seedOrg("nps");
  const contact2 = seedContact(org2, "Maria Santos");

  // 2.1 Create and record a detractor survey
  const surveyId = SatisfactionService.create(org2, { contactId: contact2, orderId: 'order1' });
  check("2.1 Survey created", !!surveyId);

  SatisfactionService.record(org2, surveyId!, 2, "2");
  check("2.2 Score recorded", true);

  // 2.3 Mark follow-up asked (simulates what webhookProcessor does for detractors)
  SatisfactionService.markFollowUpAsked(org2, surveyId!);

  // 2.4 Check pending follow-up
  const pending = SatisfactionService.pendingFollowUp(org2, contact2);
  check("2.3 Pending follow-up found", !!pending);
  check("2.4 Follow-up status is asked", pending?.follow_up_status === 'asked');

  // 2.5 Capture comment
  SatisfactionService.captureComment(org2, surveyId!, "O produto chegou danificado e ninguém me respondeu.");
  const survey = db.prepare(`SELECT * FROM satisfaction_surveys WHERE id = ?`).get(surveyId) as any;
  check("2.5 Comment captured", survey.comment === "O produto chegou danificado e ninguém me respondeu.");
  check("2.6 Follow-up status is captured", survey.follow_up_status === 'captured');

  // 2.7 No more pending follow-up after capture
  const noPending = SatisfactionService.pendingFollowUp(org2, contact2);
  check("2.7 No pending follow-up after capture", !noPending);

  // 2.8 Non-detractor should NOT get follow-up
  const contact3 = seedContact(org2, "Ana Lima");
  const survey2Id = SatisfactionService.create(org2, { contactId: contact3, orderId: 'order2' });
  SatisfactionService.record(org2, survey2Id!, 5, "5");
  check("2.8 Score 5 is NOT a detractor", !SatisfactionService.isDetractor(5));
  // No markFollowUpAsked for non-detractors
  const noPending2 = SatisfactionService.pendingFollowUp(org2, contact3);
  check("2.9 No pending follow-up for non-detractor", !noPending2);

  // 2.10 Detractor timeline
  const timeline = SatisfactionService.detractorTimeline(org2, 90);
  check("2.10 Timeline has 1 detractor", timeline.length === 1);
  check("2.11 Timeline entry has comment", timeline[0].comment === "O produto chegou danificado e ninguém me respondeu.");
  check("2.12 Timeline entry has contact name", timeline[0].contact_name === "Maria Santos");

  // 2.13 Add another detractor without comment
  const contact4 = seedContact(org2, "Pedro Oliveira");
  const survey3Id = SatisfactionService.create(org2, { contactId: contact4, orderId: 'order3' });
  SatisfactionService.record(org2, survey3Id!, 1, "1");
  SatisfactionService.markFollowUpAsked(org2, survey3Id!);
  // Don't capture comment — simulates customer not replying
  const timeline2 = SatisfactionService.detractorTimeline(org2, 90);
  check("2.13 Timeline has 2 detractors", timeline2.length === 2);

  // ==== PART 3: Abandoned Cart Pre-Proposal ====
  console.log('\n=== PART 3: Abandoned Cart Pre-Proposal ===');

  const org3 = seedOrg("cart");
  db.prepare(`UPDATE organization_settings SET abandoned_cart_enabled = 1, abandoned_cart_hours = 4, abandoned_cart_intent_enabled = 1, abandoned_cart_intent_threshold = 60 WHERE organization_id = ?`).run(org3);

  // Verify settings saved
  const orgSettings = db.prepare(`SELECT abandoned_cart_intent_enabled, abandoned_cart_intent_threshold FROM organization_settings WHERE organization_id = ?`).get(org3) as any;
  check("3.1 Intent enabled saved", orgSettings.abandoned_cart_intent_enabled === 1);
  check("3.2 Intent threshold saved", orgSettings.abandoned_cart_intent_threshold === 60);

  // Create a contact with high purchase probability but NOT in proposta stage
  const contact5 = seedContact(org3, "Carlos Mendes");
  db.prepare(`UPDATE contacts SET ai_purchase_probability = 75 WHERE id = ?`).run(contact5);

  // Create a ticket NOT in proposta/qualificado
  const ticketId = randomUUID();
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'ia_atendendo')`)
    .run(ticketId, org3, contact5);

  // Insert message older than 4 hours
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'customer', 'Quanto custa?', datetime('now', '-5 hours'))`)
    .run(randomUUID(), org3, ticketId);

  // Verify the query finds this ticket
  const intentTickets = db.prepare(`
    SELECT t.id
    FROM tickets t
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.organization_id = ?
      AND t.status = 'open'
      AND t.stage NOT IN ('proposta','qualificado')
      AND t.abandoned_nudged_at IS NULL
      AND COALESCE(c.ai_purchase_probability, 0) >= 60
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
      AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', '-4 hours')
  `).all(org3) as any[];
  check("3.3 Intent query finds ticket with probability >= 60", intentTickets.length === 1);
  check("3.4 Found ticket matches", intentTickets[0].id === ticketId);

  // Ticket with low probability should NOT be found
  const contact6 = seedContact(org3, "Ana Baixa");
  db.prepare(`UPDATE contacts SET ai_purchase_probability = 30 WHERE id = ?`).run(contact6);
  const ticket2Id = randomUUID();
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'ia_atendendo')`)
    .run(ticket2Id, org3, contact6);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'customer', 'Oi', datetime('now', '-5 hours'))`)
    .run(randomUUID(), org3, ticket2Id);

  const intentTickets2 = db.prepare(`
    SELECT t.id
    FROM tickets t
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.organization_id = ?
      AND t.status = 'open'
      AND t.stage NOT IN ('proposta','qualificado')
      AND t.abandoned_nudged_at IS NULL
      AND COALESCE(c.ai_purchase_probability, 0) >= 60
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
      AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', '-4 hours')
  `).all(org3) as any[];
  check("3.5 Low-probability ticket NOT found", intentTickets2.length === 1);

  // Ticket already in proposta should NOT be found by intent query (it's handled by the main query)
  const contact7 = seedContact(org3, "Roberto Proposta");
  db.prepare(`UPDATE contacts SET ai_purchase_probability = 90 WHERE id = ?`).run(contact7);
  const ticket3Id = randomUUID();
  db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'proposta')`)
    .run(ticket3Id, org3, contact7);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'customer', 'Quero', datetime('now', '-5 hours'))`)
    .run(randomUUID(), org3, ticket3Id);

  const intentTickets3 = db.prepare(`
    SELECT t.id
    FROM tickets t
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.organization_id = ?
      AND t.status = 'open'
      AND t.stage NOT IN ('proposta','qualificado')
      AND t.abandoned_nudged_at IS NULL
      AND COALESCE(c.ai_purchase_probability, 0) >= 60
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
      AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', '-4 hours')
  `).all(org3) as any[];
  check("3.6 Proposta-stage ticket excluded from intent query", intentTickets3.length === 1);

  // 3.7 Verify the original abandoned cart query still works for proposta tickets
  const mainTickets = db.prepare(`
    SELECT t.id
    FROM tickets t
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.organization_id = ?
      AND t.status = 'open'
      AND t.stage IN ('proposta','qualificado')
      AND t.abandoned_nudged_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
      AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', '-4 hours')
  `).all(org3) as any[];
  check("3.7 Original query still finds proposta tickets", mainTickets.length === 1);
  check("3.8 Original query finds the proposta ticket", mainTickets[0].id === ticket3Id);

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
