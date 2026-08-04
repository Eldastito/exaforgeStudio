/**
 * TEST — ADR-152 Fatia 4c.5: dashboard endpoints do SalesRecoveryPanel.
 *
 * Cobre os 3 novos service methods usados pelas rotas HTTP GET:
 *   - `SalesRecoveryPlaybookService.metrics(orgId)`
 *   - `SalesRecoveryPlaybookService.listTouches(orgId, {limit})`
 *   - `SalesRecoveryPlaybookService.listAttributions(orgId, {limit, windowDays})`
 *
 * Além disso valida a rota HTTP-level (`/sales-recovery/metrics` etc.)
 * via chamada de service — nossa suíte de tests não sobe Express (padrão
 * do repo), então validamos a lógica de negócio dos endpoints. Os
 * handlers do runtime.ts são thin wrappers que delegam ao service.
 *
 * Uso: npm run test:sales-recovery-dashboard
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-dash-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-dash-1234567890";
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SalesRecoveryPlaybookService } = await import("../src/server/SalesRecoveryPlaybook.js");

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = (opts: { mvpOn?: boolean; followupOn?: boolean; attributionOn?: boolean } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, sales_recovery_enabled, sales_recovery_followup_enabled, sales_recovery_attribution_enabled) VALUES (?, ?, 'X', 'active', 1, ?, ?, ?)`)
      .run(randomUUID(), id, opts.mvpOn ? 1 : 0, opts.followupOn ? 1 : 0, opts.attributionOn ? 1 : 0);
    return id;
  };
  const mkChannel = (orgId: string) => {
    const id = `ch-${orgId}-${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId);
    return id;
  };
  const mkContact = (orgId: string, channelId: string, name: string, phone: string, optOut = false) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, marketing_opt_out) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, channelId, name, phone, optOut ? 1 : 0);
    return id;
  };
  const mkTicket = (orgId: string, contactId: string, stage = "proposta") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, updated_at) VALUES (?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)`)
      .run(id, orgId, contactId, stage);
    return id;
  };
  const mkProposedSignal = (orgId: string, ticketId: string, opts: { status?: string; detectedDaysAgo?: number } = {}) => {
    const id = randomUUID();
    const iso = new Date(Date.now() - (opts.detectedDaysAgo ?? 0) * 86400_000).toISOString();
    db.prepare(`INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, source_entity_type, source_entity_id, evidence_json, dedupe_key, status, detected_at) VALUES (?, ?, 'sales', 'sales_recovery_proposed', 'attention', 'estimate', 0.8, 'SalesRecoveryPlaybook', 'ticket', ?, '{}', ?, ?, ?)`)
      .run(id, orgId, ticketId, `sales_recovery:proposed:${ticketId}:${randomUUID().slice(0, 6)}`, opts.status || "open", iso);
    return id;
  };
  const mkTouch = (orgId: string, ticketId: string, contactId: string, phone: string, channelId: string, opts: { sentDaysAgo?: number; replyIntent?: string | null } = {}) => {
    const id = randomUUID();
    const iso = new Date(Date.now() - (opts.sentDaysAgo ?? 0) * 86400_000).toISOString();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, sent_at, reply_intent, approved_by, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'u-owner', 'msg-xyz')`)
      .run(id, orgId, ticketId, contactId, phone, channelId, iso, opts.replyIntent || null);
    return id;
  };
  const mkAttribution = (orgId: string, ticketId: string, opts: { revenue?: number; attributedDaysAgo?: number; source?: string } = {}) => {
    const id = randomUUID();
    const iso = new Date(Date.now() - (opts.attributedDaysAgo ?? 0) * 86400_000).toISOString();
    const rev = opts.revenue ?? 500;
    db.prepare(`INSERT INTO sales_recovery_attributions (id, organization_id, ticket_id, touch_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis, attributed_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, ticketId, iso, rev, rev, opts.source || "orders", opts.source === "quotes" ? "estimate" : "fact", iso);
    return id;
  };

  // ============================================================
  // A) metrics()
  // ============================================================
  const orgA = mkOrg({ mvpOn: true, followupOn: true, attributionOn: true });
  const chA = mkChannel(orgA);
  const c1 = mkContact(orgA, chA, "Ana", "5511900001111");
  const c2 = mkContact(orgA, chA, "Bruno", "5511900002222");
  const c3 = mkContact(orgA, chA, "OptedOut", "5511900003333", true); // opt-out
  const t1 = mkTicket(orgA, c1);
  const t2 = mkTicket(orgA, c2);
  const t3 = mkTicket(orgA, c3);
  void t3;

  // 2 propostas abertas + 1 dispensada
  mkProposedSignal(orgA, t1, { status: "open" });
  mkProposedSignal(orgA, t2, { status: "open" });
  mkProposedSignal(orgA, t1, { status: "dismissed", detectedDaysAgo: 3 });

  // 3 touches (2 hoje, 1 há 10d + reply interested)
  mkTouch(orgA, t1, c1, "5511900001111", chA, { sentDaysAgo: 0 });
  mkTouch(orgA, t2, c2, "5511900002222", chA, { sentDaysAgo: 0 });
  mkTouch(orgA, t1, c1, "5511900001111", chA, { sentDaysAgo: 10, replyIntent: "interested" });

  // 2 attributions (últimos 30d)
  mkAttribution(orgA, t1, { revenue: 800, attributedDaysAgo: 5, source: "orders" });
  mkAttribution(orgA, t2, { revenue: 400, attributedDaysAgo: 20, source: "quotes" });

  const m = SalesRecoveryPlaybookService.metrics(orgA);

  check("metrics.proposals.open = 2", m.proposals.open === 2);
  check("metrics.proposals.today ≥ 2 (2 abertas hoje)", m.proposals.today >= 2);
  check("metrics.proposals.last7d ≥ 3 (open + dismissed)", m.proposals.last7d >= 3);
  check("metrics.touches.today = 2", m.touches.today === 2);
  check("metrics.touches.last7d = 2 (touch 10d fora)", m.touches.last7d === 2);
  check("metrics.touches.last30d = 3", m.touches.last30d === 3);
  check("metrics.touches.withReply7d = 0 (o reply veio no touch 10d atrás)", m.touches.withReply7d === 0);
  check("metrics.replyBreakdown7d vazio (reply é fora dos 7d)", Object.keys(m.replyBreakdown7d).length === 0);
  check("metrics.revenue.total = 1200 (800+400)", m.revenue.total === 1200);
  check("metrics.revenue.last30d = 1200", m.revenue.last30d === 1200);
  check("metrics.revenue.attributions30d = 2", m.revenue.attributions30d === 2);
  check("metrics.optOuts = 1 (c3)", m.optOuts === 1);
  check("metrics.config.salesRecoveryEnabled = true", m.config.salesRecoveryEnabled === true);
  check("metrics.config.followupEnabled = true", m.config.followupEnabled === true);
  check("metrics.config.attributionEnabled = true", m.config.attributionEnabled === true);

  // Reply intent recente pra breakdown ficar populado
  mkTouch(orgA, t1, c1, "5511900001111", chA, { sentDaysAgo: 2, replyIntent: "interested" });
  mkTouch(orgA, t2, c2, "5511900002222", chA, { sentDaysAgo: 3, replyIntent: "not_now" });
  const m2 = SalesRecoveryPlaybookService.metrics(orgA);
  check("metrics.replyBreakdown7d.interested = 1", m2.replyBreakdown7d?.interested === 1);
  check("metrics.replyBreakdown7d.not_now = 1", m2.replyBreakdown7d?.not_now === 1);
  check("metrics.touches.withReply7d = 2 (2 novos com reply)", m2.touches.withReply7d === 2);

  // ============================================================
  // B) listTouches()
  // ============================================================
  const touches = SalesRecoveryPlaybookService.listTouches(orgA, { limit: 20 });
  check("listTouches devolve todos os touches (5 total)", touches.length === 5);
  check("listTouches ordenado desc (mais recente primeiro)", touches[0].sentAt >= touches[touches.length - 1].sentAt);
  check("listTouches inclui contactName", touches.some((t: any) => t.contactName === "Ana"));
  check("listTouches inclui replyIntent quando presente", touches.some((t: any) => t.replyIntent === "interested"));
  check("listTouches respeitando limit=1", SalesRecoveryPlaybookService.listTouches(orgA, { limit: 1 }).length === 1);

  // ============================================================
  // C) listAttributions()
  // ============================================================
  const attrs = SalesRecoveryPlaybookService.listAttributions(orgA, { limit: 20 });
  check("listAttributions devolve todas na janela default 30d (2)", attrs.length === 2);
  check("listAttributions ordenado por attributedAt desc", attrs[0].attributedAt >= attrs[1].attributedAt);
  check("listAttributions traz ticketValue + basis correto", attrs.every((a: any) => a.ticketValue > 0 && (a.basis === "fact" || a.basis === "estimate")));
  check("listAttributions inclui source distinguindo orders/quotes", attrs.some((a: any) => a.source === "orders") && attrs.some((a: any) => a.source === "quotes"));

  // Attribution fora da janela
  mkAttribution(orgA, t1, { revenue: 1000, attributedDaysAgo: 60, source: "orders" });
  const attrsShort = SalesRecoveryPlaybookService.listAttributions(orgA, { windowDays: 30 });
  check("attribution 60d fora da janela 30d NÃO aparece", attrsShort.length === 2);
  const attrsWide = SalesRecoveryPlaybookService.listAttributions(orgA, { windowDays: 90 });
  check("attribution 60d dentro janela 90d aparece", attrsWide.length === 3);

  // ============================================================
  // D) Isolamento cross-tenant
  // ============================================================
  const orgB = mkOrg({ mvpOn: true });
  const mB = SalesRecoveryPlaybookService.metrics(orgB);
  check("orgB: proposals.open = 0 (isolamento)", mB.proposals.open === 0);
  check("orgB: revenue.total = 0 (isolamento)", mB.revenue.total === 0);
  check("orgB: touches.today = 0 (isolamento)", mB.touches.today === 0);
  const touchesB = SalesRecoveryPlaybookService.listTouches(orgB);
  check("orgB: listTouches vazio", touchesB.length === 0);
  const attrsB = SalesRecoveryPlaybookService.listAttributions(orgB);
  check("orgB: listAttributions vazio", attrsB.length === 0);

  // ============================================================
  // E) Config flags off
  // ============================================================
  const orgOff = mkOrg({ mvpOn: false, followupOn: false, attributionOn: false });
  const mOff = SalesRecoveryPlaybookService.metrics(orgOff);
  check("config.salesRecoveryEnabled = false", mOff.config.salesRecoveryEnabled === false);
  check("config.followupEnabled = false", mOff.config.followupEnabled === false);
  check("config.attributionEnabled = false", mOff.config.attributionEnabled === false);
  // Metrics ainda funciona (só devolve 0s) — UI decide o que mostrar.
  check("metrics em orgOff devolve estrutura completa (0s)", typeof mOff.proposals?.open === "number" && typeof mOff.revenue?.total === "number");

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4c.5 (Dashboard endpoints do SalesRecoveryPanel) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
