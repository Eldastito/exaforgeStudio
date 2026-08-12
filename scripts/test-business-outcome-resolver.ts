/**
 * TEST — BusinessOutcomeResolver: outcome de negócio via system-of-record (PRD 8 / ADR-165 F3).
 * DB-backed, det. Prova (§13, D3, RN-OA-2/6/8):
 *   - resolver de cobrança pergunta ao receivables (system-of-record), não à IA;
 *   - recebível 'received' → confirmed (fact); 'open' → not_confirmed; 'canceled' → not_confirmed;
 *   - sem vínculo/recebível → unknown (não inventa);
 *   - registry sem resolver aplicável → resolver_pending (honesto);
 *   - integração: OutcomeAssuranceService.assessAction usa o resolver;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:business-outcome-resolver
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bor-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-bor-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessOutcomeResolverRegistry: REG } = await import("../src/server/BusinessOutcomeResolver.js");
  const { OutcomeAssuranceService: OA } = await import("../src/server/OutcomeAssuranceService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkRec = (id: string, status: string, org = ORG) =>
    db.prepare("INSERT INTO receivables (id, organization_id, description, amount, due_date, status, received_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, org, "Fatura", 200, "2026-08-01", status, status === "received" ? "2026-08-05" : null);
  const mkAction = (id: string, cmd: string | null, payload: any, org = ORG, status = "done") =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, command_type, command_payload_json) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "Cobrar", status, cmd, payload != null ? JSON.stringify(payload) : null);
  const actionRow = (id: string) => db.prepare("SELECT * FROM decision_actions WHERE id=?").get(id);

  // ═══════════════ 1. registry conhece o domínio de cobrança ═══════════════
  check("1.1 registry tem resolver 'collection'", REG.domains().includes("collection"));

  // ═══════════════ 2. recebível pago → confirmed (fact, system-of-record) ═══════════════
  mkRec("r-paid", "received"); mkAction("a-paid", "collection_send_reminder", { receivableId: "r-paid" });
  const rPaid = REG.resolve(ORG, actionRow("a-paid"));
  check("2.1 recebível received → confirmed + basis system_of_record", rPaid.resolved === "confirmed" && rPaid.basis === "system_of_record");
  check("2.2 evidência traz o recebível", rPaid.evidence && rPaid.evidence.receivableId === "r-paid");

  // ═══════════════ 3. recebível em aberto → not_confirmed ═══════════════
  mkRec("r-open", "open"); mkAction("a-open", "asaas_pix_charge", { receivableId: "r-open" });
  check("3.1 recebível open → not_confirmed (enviado ≠ pago)", REG.resolve(ORG, actionRow("a-open")).resolved === "not_confirmed");

  // ═══════════════ 4. recebível cancelado → not_confirmed ═══════════════
  mkRec("r-can", "canceled"); mkAction("a-can", "collection_send_reminder", { receivableId: "r-can" });
  check("4.1 recebível canceled → not_confirmed", REG.resolve(ORG, actionRow("a-can")).resolved === "not_confirmed");

  // ═══════════════ 5. sem vínculo/recebível → unknown (não inventa, RN-OA-2) ═══════════════
  mkAction("a-nolink", "collection_send_reminder", {});
  check("5.1 sem receivableId → unknown/no_receivable_link", (() => { const r = REG.resolve(ORG, actionRow("a-nolink")); return r.resolved === "unknown" && r.reason === "no_receivable_link"; })());
  mkAction("a-ghost", "collection_send_reminder", { receivableId: "r-ghost" });
  check("5.2 recebível inexistente → unknown/receivable_not_found", REG.resolve(ORG, actionRow("a-ghost")).reason === "receivable_not_found");

  // ═══════════════ 6. domínio sem resolver → resolver_pending (honesto) ═══════════════
  mkAction("a-other", null, null); // command_type null → nenhum resolver aplica
  const rNone = REG.resolve(ORG, actionRow("a-other"));
  check("6.1 sem resolver aplicável → unknown/resolver_pending", rNone.resolved === "unknown" && rNone.reason === "resolver_pending");

  // ═══════════════ 7. integração com OutcomeAssuranceService.assessAction ═══════════════
  const boc = OA.assessAction(ORG, "a-paid").stages.businessOutcomeConfirmed;
  check("7.1 assessAction expõe outcome de negócio confirmado via resolver", boc.reached === "confirmed" && boc.basis === "system_of_record");
  const bocOpen = OA.assessAction(ORG, "a-open").stages.businessOutcomeConfirmed;
  check("7.2 assessAction: recebível aberto → not_confirmed", bocOpen.reached === "not_confirmed");

  // ═══════════════ 8. isolamento multi-tenant ═══════════════
  mkRec("r-x", "received", OTHER); mkAction("a-x", "collection_send_reminder", { receivableId: "r-x" }, OTHER);
  check("8.1 org-1 não enxerga recebível da outra org → unknown", REG.resolve(ORG, actionRow("a-x")).resolved === "unknown");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} business-outcome-resolver: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
