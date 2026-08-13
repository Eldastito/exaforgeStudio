/**
 * TEST — Opportunity Matching (PRD 10 / ADR-167 F7). DB-backed, determinístico.
 * Prova (D6/§42, RN-SI-02/03): percepção → AÇÃO na espinha canônica.
 *   - casa inteligência do nicho FRESCA (F6) com o momento da org e publica em
 *     `business_signals` (NUNCA tabela paralela); idempotente por dedupe_key;
 *   - oportunidade é HIPÓTESE (basis) e NÃO inventa dinheiro (impact null);
 *   - GROUNDING: sem inteligência fresca → nada publicado (não inventa);
 *   - sem vertical / broker off → motivo honesto, 0 publicado;
 *   - publish=false é read-only; entra em attention(); isolamento multi-tenant.
 *
 * Uso: npm run test:opportunity-matching
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oppo-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oppo-12345";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { OpportunityMatchingService: OM } = await import("../src/server/OpportunityMatchingService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { SocialAnalyticsService: AN } = await import("../src/server/SocialAnalyticsService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const master = { userId: "master-1", organizationId: null };
  const setupOrg = (org: string, vertical: string | null, ext: number) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET vertical = ?, external_intelligence_enabled = ? WHERE organization_id = ?`).run(vertical, ext, org);
  };
  const A = "org_oppo_A", B = "org_oppo_B", C = "org_oppo_C", D = "org_oppo_D", E = "org_oppo_E";
  setupOrg(A, "moda", 1);
  setupOrg(B, "moda", 1);
  setupOrg(C, "clinica", 1);   // vertical sem inteligência fresca
  setupOrg(D, null, 1);        // sem vertical
  setupOrg(E, "moda", 0);      // broker desligado

  // Semeia o COMPARTILHADO fresco pra 'moda' (2 tópicos default); 'clinica' fica vazio.
  await VI.runResearch(master, { vertical: "moda", topic: "concorrência", ttlDays: 7 }, { providerName: "stub" });
  await VI.runResearch(master, { vertical: "moda", topic: "tendências", ttlDays: 7 }, { providerName: "stub" });
  await AN.sync(A, "stub");

  // ═══════════════ 1. casa e publica na espinha ═══════════════
  const m = OM.match(A, { channel: "stub", publish: true });
  check("1.1 matched=2 (concorrência+tendências frescas)", m.matched === 2 && m.opportunities.length === 2);
  const sigs = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'social' AND signal_type = 'content_opportunity'`).all(A) as any[];
  check("1.2 publicou 2 sinais em business_signals (não tabela paralela)", sigs.length === 2);
  check("1.3 basis=hypothesis (PUBLISHED ≠ RESULTADO)", sigs.every((s) => s.basis === "hypothesis"));
  check("1.4 NÃO inventa dinheiro (impact null)", sigs.every((s) => s.impact_amount === null));
  check("1.5 dedupe_key estável por (vertical,topic,channel)", sigs.some((s) => s.dedupe_key === "social_opportunity:moda:concorrência:stub"));
  check("1.6 subject opportunity + expires no validUntil", sigs.every((s) => s.subject_type === "opportunity" && !!s.expires_at));
  check("1.7 correlation_id enraizado", m.opportunities.every((o) => !!o.correlationId));

  // ═══════════════ 2. idempotência (dedupe, não duplica) ═══════════════
  const m2 = OM.match(A, { channel: "stub", publish: true });
  const sigs2 = db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain='social' AND signal_type='content_opportunity'`).get(A) as any;
  check("2.1 re-match não duplica (ainda 2)", sigs2.n === 2 && m2.matched === 2);

  // ═══════════════ 3. entra em attention() (fluxo canônico) ═══════════════
  const att = BS.attention(A, {});
  check("3.1 oportunidade aparece na atenção", att.items.some((i: any) => i.domain === "social" && i.type === "content_opportunity"));

  // ═══════════════ 4. GROUNDING: sem inteligência fresca → nada (não inventa) ═══════════════
  const mC = OM.match(C, { channel: "stub", publish: true });
  check("4.1 vertical sem inteligência fresca → matched 0", mC.matched === 0 && mC.reason === "no_fresh_intelligence");
  check("4.2 nada publicado pra C", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ?`).get(C) as any).n === 0);

  // ═══════════════ 5. motivos honestos ═══════════════
  check("5.1 sem vertical → no_vertical", OM.match(D, { publish: true }).reason === "no_vertical");
  check("5.2 broker off → external_intelligence_off", OM.match(E, { publish: true }).reason === "external_intelligence_off");

  // ═══════════════ 6. publish=false é read-only ═══════════════
  const mB = OM.match(B, { channel: "stub", publish: false });
  check("6.1 read-only casa mas não publica", mB.matched === 2 && (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ?`).get(B) as any).n === 0);

  // ═══════════════ 7. isolamento multi-tenant ═══════════════
  check("7.1 sinais de A não vazam pra B", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ?`).get(B) as any).n === 0);

  // ═══════════════ 8. pass() best-effort ═══════════════
  OM.pass();  // publica pras orgs elegíveis (A já tem; B agora publica; C/D/E não)
  check("8.1 pass() publica pra B (elegível)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain='social'`).get(B) as any).n === 2);
  check("8.2 pass() não publica pra C/E", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id IN (?,?)`).get(C, E) as any).n === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} opportunity-matching: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
