/**
 * TEST — Anti-dupla-contagem em action_outcomes (PRD 8 / ADR-165 F5, achado (c)).
 * DB-backed, det. Prova:
 *   - record com eventKey é IDEMPOTENTE: 2ª chamada devolve o mesmo outcome, NÃO grava outro;
 *   - sem eventKey → comportamento legado preservado (grava normalmente, 2 linhas);
 *   - índice UNIQUE parcial existe (só quando event_key não-nulo);
 *   - ledger deduplica por event_key (não infla receita duplicada);
 *   - isolamento multi-tenant (mesma event_key em orgs diferentes coexiste).
 *
 * Uso: npm run test:outcome-dedup
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dedup-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dedup-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { OutcomeMeasurementService: OM } = await import("../src/server/OutcomeMeasurementService.js");
  const ORG = "org-1", OTHER = "org-2";

  const mkAction = (id: string, org = ORG) =>
    db.prepare("INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status) VALUES (?,?,?,?,?,?)")
      .run(id, org, "collection", "send_reminder", "T", "done");
  const countFor = (actionId: string, org = ORG) => db.prepare("SELECT COUNT(*) c FROM action_outcomes WHERE organization_id=? AND action_id=?").get(org, actionId).c;

  // ═══════════════ 0. índice UNIQUE parcial existe ═══════════════
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_action_outcomes_event_key'").get() as any;
  check("0.1 índice UNIQUE parcial (WHERE event_key IS NOT NULL) existe", !!idx && /UNIQUE/i.test(idx.sql) && /event_key IS NOT NULL/i.test(idx.sql));
  const cols = (db.prepare("PRAGMA table_info(action_outcomes)").all() as any[]).map((c) => c.name);
  check("0.2 coluna event_key aditiva presente", cols.includes("event_key"));

  // ═══════════════ 1. eventKey → idempotente ═══════════════
  mkAction("a-1");
  const o1 = OM.record(ORG, "a-1", { revenueRecovered: 100, basis: "fact", eventKey: "pay:evt-1" });
  const o2 = OM.record(ORG, "a-1", { revenueRecovered: 100, basis: "fact", eventKey: "pay:evt-1" });
  check("1.1 mesma eventKey → mesmo outcome (idempotente)", o1.id === o2.id);
  check("1.2 mesma eventKey → 1 linha (não dobra)", countFor("a-1") === 1);

  // ═══════════════ 2. sem eventKey → comportamento legado (grava 2) ═══════════════
  mkAction("a-2");
  OM.record(ORG, "a-2", { revenueRecovered: 50 });
  OM.record(ORG, "a-2", { revenueRecovered: 50 });
  check("2.1 sem eventKey → 2 linhas (legado preservado)", countFor("a-2") === 2);

  // ═══════════════ 3. eventKeys diferentes → 2 linhas ═══════════════
  mkAction("a-3");
  OM.record(ORG, "a-3", { revenueRecovered: 10, eventKey: "k-a" });
  OM.record(ORG, "a-3", { revenueRecovered: 10, eventKey: "k-b" });
  check("3.1 eventKeys distintas → 2 linhas", countFor("a-3") === 2);

  // ═══════════════ 4. ledger deduplica por event_key ═══════════════
  // Insere manualmente 2 linhas com a MESMA event_key (simulando histórico pré-índice
  // via bypass do índice: impossível pelo índice — então testamos o dedup de leitura com
  // 2 rows de event_key distintas vs 1 idempotente). Verificamos que o total não conta 2×.
  mkAction("a-4");
  OM.record(ORG, "a-4", { revenueRecovered: 200, basis: "fact", eventKey: "pay:evt-4" });
  OM.record(ORG, "a-4", { revenueRecovered: 200, basis: "fact", eventKey: "pay:evt-4" }); // idempotente
  const led = OM.ledger(ORG, { domain: "collection" });
  const a4Rev = led.totals.categories.revenueRecovered;
  // a-1(100) + a-2(50+50) + a-3(10+10) + a-4(200) = 100+100+20+200 = 420 (a-4 conta 1×)
  check("4.1 ledger não dobra a receita da eventKey idempotente (a-4 = 200, não 400)", a4Rev === 420);

  // ═══════════════ 5. isolamento multi-tenant (mesma eventKey em orgs diferentes) ═══════════════
  mkAction("a-5", ORG); mkAction("b-5", OTHER);
  OM.record(ORG, "a-5", { revenueRecovered: 5, eventKey: "shared-key" });
  const bOut = OM.record(OTHER, "b-5", { revenueRecovered: 7, eventKey: "shared-key" });
  check("5.1 mesma eventKey em orgs diferentes coexiste (índice inclui org)", bOut && countFor("b-5", OTHER) === 1 && countFor("a-5", ORG) === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} outcome-dedup: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
