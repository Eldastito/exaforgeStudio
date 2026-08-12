/**
 * TEST — Resolvers dos golden loops Comercial/Reputação/Varejo (PRD 8 / ADR-165 F4).
 * DB-backed, det. Prova (§13, D3, RN-OA-2/6): cada domínio pergunta ao SEU system-of-record.
 *   - Comercial: sales_recovery_attributions (action_id) → confirmed; sem atribuição → not_confirmed;
 *   - Reputação: business_signals.status='resolved' → confirmed; open/dismissed → not_confirmed;
 *   - Varejo: retail_daily_closings.status reconciled/approved → confirmed; divergent → not_confirmed;
 *   - sem vínculo → unknown (não inventa);
 *   - registry roteia por appliesTo; isolamento multi-tenant.
 *
 * Uso: npm run test:outcome-resolvers-golden
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-golden-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-golden-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessOutcomeResolverRegistry: REG } = await import("../src/server/BusinessOutcomeResolver.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkAction = (id: string, domain: string, cmd: string, payload: any, org = ORG, signalId: string | null = null, cid: string | null = null) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, command_type, command_payload_json, signal_id, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, org, domain, "act", "T", "done", cmd, payload != null ? JSON.stringify(payload) : null, signalId, cid);
  const row = (id: string) => db.prepare("SELECT * FROM decision_actions WHERE id=?").get(id);

  // ═══════════════ 0. registry conhece os 4 domínios ═══════════════
  check("0.1 registry tem os 4 golden loops", ["collection", "sales_recovery", "reputation", "retail"].every((d) => REG.domains().includes(d)));

  // ═══════════════ 1. COMERCIAL — sales_recovery_attributions ═══════════════
  mkAction("s-won", "sales", "sales_recovery_send", {});
  db.prepare("INSERT INTO sales_recovery_attributions (id, organization_id, ticket_id, action_id, stage_change_at, ticket_value, revenue_recovered, source, basis) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("attr-1", ORG, "tk-1", "s-won", "2026-08-10", 500, 500, "orders", "fact");
  const rWon = REG.resolve(ORG, row("s-won"));
  check("1.1 ticket ganho+atribuído → confirmed (fact)", rWon.resolved === "confirmed" && rWon.evidence.revenueRecovered === 500 && rWon.evidence.measurementBasis === "fact");
  mkAction("s-open", "sales", "sales_recovery_send", {});
  check("1.2 touch sem atribuição → not_confirmed (enviado ≠ ganho)", REG.resolve(ORG, row("s-open")).resolved === "not_confirmed");

  // ═══════════════ 2. REPUTAÇÃO — business_signals.status ═══════════════
  const mkSignal = (id: string, status: string, org = ORG, cid: string | null = null) =>
    db.prepare("INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, evidence_json, dedupe_key, status, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, org, "reputation", "public_complaint", "risk", "fact", 0.9, "test", "{}", `dk-${id}`, status, cid);
  mkSignal("sig-res", "resolved"); mkAction("r-res", "reputation", "reputation_publish_reply", {}, ORG, "sig-res");
  check("2.1 caso resolved → confirmed", REG.resolve(ORG, row("r-res")).resolved === "confirmed");
  mkSignal("sig-open", "open"); mkAction("r-open", "reputation", "reputation_publish_reply", {}, ORG, "sig-open");
  check("2.2 caso open (respondeu, não resolveu) → not_confirmed", REG.resolve(ORG, row("r-open")).resolved === "not_confirmed");
  // via correlation_id (sem signal_id direto)
  mkSignal("sig-cid", "resolved", ORG, "cid-9"); mkAction("r-cid", "reputation", "reputation_publish_reply", {}, ORG, null, "cid-9");
  check("2.3 resolve via correlation_id quando não há signal_id", REG.resolve(ORG, row("r-cid")).resolved === "confirmed");
  mkAction("r-ghost", "reputation", "reputation_publish_reply", {}, ORG, "nope");
  check("2.4 caso inexistente → unknown/case_not_found", REG.resolve(ORG, row("r-ghost")).reason === "case_not_found");

  // ═══════════════ 3. VAREJO — retail_daily_closings.status ═══════════════
  const mkClosing = (id: string, status: string, div: string, date: string, org = ORG) =>
    db.prepare("INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, divergence_status) VALUES (?,?,?,?,?,?)")
      .run(id, org, "st-1", date, status, div);
  mkClosing("cl-ok", "reconciled", "ok", "2026-08-10"); mkAction("t-ok", "retail", "retail_reconcile_day", { closingId: "cl-ok" });
  check("3.1 fechamento reconciled → confirmed", REG.resolve(ORG, row("t-ok")).resolved === "confirmed");
  mkClosing("cl-div", "divergent", "divergent", "2026-08-11"); mkAction("t-div", "retail", "retail_reconcile_day", { closingId: "cl-div" });
  check("3.2 fechamento divergent (falta caixa) → not_confirmed", REG.resolve(ORG, row("t-div")).resolved === "not_confirmed" && REG.resolve(ORG, row("t-div")).reason === "closing_divergent");
  mkClosing("cl-pend", "pending", "not_checked", "2026-08-12"); mkAction("t-pend", "retail", "retail_reconcile_day", { closingId: "cl-pend" });
  check("3.3 fechamento pending → not_confirmed", REG.resolve(ORG, row("t-pend")).resolved === "not_confirmed");
  // resolve por (storeId, date) quando não há closingId
  mkAction("t-bydate", "retail", "retail_reconcile_day", { storeId: "st-1", closingDate: "2026-08-10" });
  check("3.4 resolve por (storeId,date) → confirmed (acha cl-ok)", REG.resolve(ORG, row("t-bydate")).resolved === "confirmed");
  mkAction("t-nolink", "retail", "retail_reconcile_day", {});
  check("3.5 sem vínculo com fechamento → unknown", REG.resolve(ORG, row("t-nolink")).resolved === "unknown");

  // ═══════════════ 4. isolamento multi-tenant ═══════════════
  mkClosing("cl-x", "reconciled", "ok", "2026-08-10", OTHER); mkAction("t-x", "retail", "retail_reconcile_day", { closingId: "cl-x" }, OTHER);
  check("4.1 org-1 não vê fechamento da outra org → unknown", REG.resolve(ORG, row("t-x")).resolved === "unknown");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-resolvers-golden: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
