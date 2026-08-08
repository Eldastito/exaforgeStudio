/**
 * TEST — Decision Intelligence DI-4.5 (ADR-156): lembrete SEMANAL de atualização
 * das pesquisas de nicho. Coerente com o provider manual: NÃO roda pesquisa,
 * só avisa o admin (business_signals) quando um nicho COM consumidores está
 * vencendo/vencido. Auto-resolve quando re-colado. Determinístico, offline.
 *
 * Uso: npm run test:decision-intelligence-di4-reminder
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di4r-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di4r-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@test.local";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { VerticalIntelligenceReminderService: Rem } = await import("../src/server/VerticalIntelligenceReminderService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = (vertical?: string, consume?: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, external_intelligence_enabled) VALUES (?, ?, 'X', 'active', ?, ?)`).run(randomUUID(), id, vertical || null, consume ? 1 : 0);
    return id;
  };

  // Org do admin master (onde o lembrete é publicado).
  const masterOrg = mkOrg();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Master', ?, 'owner')`).run(randomUUID(), masterOrg, "master@test.local");
  check("resolve a org do admin master", Rem.masterOrgId() === masterOrg);
  check("lembrete vem ligado por padrão", Rem.isEnabled() === true);

  // Consumidor do nicho 'moda'.
  const orgA = mkOrg("moda", true);

  // Pesquisa de 'moda' vencendo dentro da carência (ttl 1 dia ≤ 3 de graça).
  VIS.runManual(null, { vertical: "moda", topic: "inverno", summary: "panorama de inverno", ttlDays: 1 });
  // Pesquisa fresca (ttl 30 dias) — NÃO deve entrar como devida.
  VIS.runManual(null, { vertical: "moda", topic: "verao", summary: "panorama de verão", ttlDays: 30 });
  // Nicho sem consumidor (food) vencendo — NÃO deve entrar.
  VIS.runManual(null, { vertical: "food", topic: "delivery", summary: "panorama delivery", ttlDays: 1 });

  const due = Rem.dueNiches();
  check("devidos: só o nicho vencendo COM consumidor (moda/inverno)", due.length === 1 && due[0].vertical === "moda" && due[0].topic === "inverno");
  check("fresca não entra; nicho sem consumidor não entra", !due.some((d: any) => d.topic === "verao" || d.vertical === "food"));

  // Sweep publica o lembrete na org do admin master.
  const r1 = Rem.sweep();
  check("sweep publica 1 lembrete na org do master", r1.due === 1 && r1.published === 1 && r1.org === masterOrg);
  const sigs = S.list(masterOrg, { domain: "platform", status: "open" }).filter((s: any) => s.signal_type === "vertical_intelligence_stale");
  check("lembrete vira business_signal (domain 'platform')", sigs.length === 1 && sigs[0].evidence?.topic === "inverno");

  // Re-colar (fresca) → próximo sweep auto-resolve o lembrete.
  VIS.runManual(null, { vertical: "moda", topic: "inverno", summary: "panorama de inverno atualizado", ttlDays: 30 });
  const r2 = Rem.sweep();
  check("após re-colar, nada mais devido", r2.due === 0);
  check("sweep auto-resolve o lembrete antigo", r2.resolved === 1);
  check("ledger: lembrete resolvido (nenhum aberto)", S.list(masterOrg, { domain: "platform", status: "open" }).filter((s: any) => s.signal_type === "vertical_intelligence_stale").length === 0);

  // Expirada de verdade → severidade risk.
  db.prepare("UPDATE vertical_intelligence SET valid_until = datetime('now','-1 day') WHERE vertical='moda' AND topic='inverno'").run();
  Rem.sweep();
  const openAfter = S.list(masterOrg, { domain: "platform", status: "open" }).filter((s: any) => s.signal_type === "vertical_intelligence_stale");
  check("nicho expirado volta a avisar com severidade 'risk'", openAfter.length === 1 && openAfter[0].severity === "risk");

  // Gating semanal: 1ª roda; 2ª (dentro de 7 dias) é pulada.
  const orgFresh = `di4rw_${randomUUID().slice(0, 6)}`;
  db.prepare("DELETE FROM platform_settings WHERE key IN ('vertical_intel_reminder_last_run')").run();
  const w1 = Rem.maybeWeeklySweep();
  check("maybeWeeklySweep roda quando nunca rodou", !!w1.result && !w1.skipped);
  const w2 = Rem.maybeWeeklySweep();
  check("maybeWeeklySweep pula dentro de 7 dias (dedupe)", w2.skipped === "not_due");

  // Toggle desliga.
  Rem.setEnabled(false);
  check("desligar o toggle pula o sweep", Rem.maybeWeeklySweep().skipped === "disabled" && Rem.isEnabled() === false);

  console.log("\n=== TEST: Decision Intelligence DI-4.5 (lembrete semanal de nicho) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-4.5 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
