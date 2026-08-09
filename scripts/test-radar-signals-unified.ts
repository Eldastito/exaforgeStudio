/**
 * TEST — Espinha Única F2 (ADR-158 D4): detectores projetam em
 * `business_signals` (opt-in), + contrato subject_type/expires_at.
 *
 * Prova, determinístico e sem IA:
 *   - flag OFF (default): oportunidade NÃO vira sinal (comportamento pré-F2);
 *   - flag ON: cada oportunidade vira 1 business_signal domain='opportunity'
 *     com subject_type/dedupe corretos, DERIVADO da mesma computação;
 *   - dedupe estável: re-scan atualiza (não duplica) o sinal, correlation fixo;
 *   - `disguised_opportunities` intacta nos dois modos (sem regressão);
 *   - subject_type + expires_at gravam no contrato de sinal;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:radar-signals-unified
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radar-unified-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-radar-unified-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OpportunityRadarService: R } = await import("../src/server/OpportunityRadarService.js");
  const { RecoveryRadarService: RR } = await import("../src/server/RecoveryRadarService.js");
  const { ManipulationRadarService: MR } = await import("../src/server/ManipulationRadarService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = (unified: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, radar_signals_unified_enabled) VALUES (?, ?, 'X', 'active', ?)`)
      .run(randomUUID(), id, unified ? 1 : 0);
    return id;
  };
  const oppSignals = (orgId: string) =>
    db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'opportunity'").all(orgId) as any[];
  const mkOpp = (title = "Reposição frequente: Camisa M") => ({
    category: "stock_out" as const, title,
    description: "Gira mais do que o estoque acompanha.", suggestedAction: "Aumente o estoque mínimo.",
    evidenceCount: 3, sampleEvidences: [{ productName: "Camisa M", reposições: 3 }],
  });

  // ===== 1. Flag OFF: oportunidade NÃO vira sinal =====
  const offOrg = mkOrg(false);
  const offId = R.upsert(offOrg, mkOpp());
  check("flag OFF: oportunidade criada em disguised_opportunities", !!offId && R.list(offOrg, { status: "all" }).length === 1);
  check("flag OFF: nenhum business_signal publicado", oppSignals(offOrg).length === 0);

  // ===== 2. Flag ON: oportunidade projeta 1 sinal com campos corretos =====
  const onOrg = mkOrg(true);
  const onId = R.upsert(onOrg, mkOpp());
  const sigs = oppSignals(onOrg);
  check("flag ON: 1 business_signal domain='opportunity'", sigs.length === 1);
  const sig = sigs[0] || {};
  check("sinal: signal_type = categoria (stock_out)", sig.signal_type === "stock_out");
  check("sinal: subject_type = 'opportunity'", sig.subject_type === "opportunity");
  check("sinal: source_entity_id = id da oportunidade", sig.source_entity_id === onId);
  check("sinal: dedupe_key = opportunity:<id>", sig.dedupe_key === `opportunity:${onId}`);
  check("sinal: basis='estimate' (heurística), severity='attention'", sig.basis === "estimate" && sig.severity === "attention");
  check("sinal: correlation_id enraizado (= id do sinal)", sig.correlation_id === sig.id);
  check("flag ON: disguised_opportunities também escrita (projeção, não substituição)", R.list(onOrg, { status: "all" }).length === 1);

  // ===== 3. Dedupe: re-scan atualiza, não duplica =====
  const onId2 = R.upsert(onOrg, { ...mkOpp(), evidenceCount: 7 });
  check("re-upsert mesmo (category,title): mesma oportunidade", onId2 === onId);
  const sigs2 = oppSignals(onOrg);
  check("dedupe: segue com 1 sinal (atualizado, não duplicado)", sigs2.length === 1);
  check("dedupe: correlation_id estável", sigs2[0].correlation_id === sig.correlation_id);

  // ===== 4. Nova oportunidade (título diferente) → novo sinal =====
  const onId3 = R.upsert(onOrg, mkOpp("2 clientes pediram item ausente"));
  check("oportunidade nova → 2º sinal", onId3 !== onId && oppSignals(onOrg).length === 2);

  // ===== 5. Contrato: subject_type + expires_at gravam =====
  const exp = "2030-01-01T00:00:00.000Z";
  const r = S.publish(onOrg, {
    domain: "inventory", signalType: "shortage", severity: "risk", basis: "estimate", confidence: 0.8,
    sourceService: "TestService", subjectType: "sku", expiresAt: exp,
    evidence: { sku: "ABC" }, dedupeKey: "shortage:ABC",
  });
  const row = db.prepare("SELECT subject_type, expires_at FROM business_signals WHERE id = ?").get(r.id) as any;
  check("contrato: subject_type gravado", row.subject_type === "sku");
  check("contrato: expires_at gravado", String(row.expires_at).startsWith("2030-01-01"));

  // ===== 6. RecoveryRadar → business_signals (F2.2) =====
  const recSignals = (orgId: string) =>
    db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'recovery'").all(orgId) as any[];
  // flag OFF: não projeta
  RR.detect({ organizationId: offOrg, contactId: "c-off", triggerType: "order_cancelled", context: { note: "x" } });
  check("recovery flag OFF: nenhum sinal", recSignals(offOrg).length === 0);
  // flag ON: projeta 1 sinal factual
  const ev = RR.detect({ organizationId: onOrg, contactId: "c-1", triggerType: "order_cancelled", context: { note: "cancelou" } });
  const recs = recSignals(onOrg);
  check("recovery flag ON: 1 sinal domain='recovery'", recs.length === 1);
  check("recovery: signal_type = trigger (order_cancelled)", recs[0]?.signal_type === "order_cancelled");
  check("recovery: subject_type='contact', basis='fact', severity='risk'", recs[0]?.subject_type === "contact" && recs[0]?.basis === "fact" && recs[0]?.severity === "risk");
  check("recovery: dedupe_key = recovery:<eventId>", recs[0]?.dedupe_key === `recovery:${ev?.id}`);
  // dedupe: mesmo contato+trigger na janela → mesmo evento, ainda 1 sinal
  RR.detect({ organizationId: onOrg, contactId: "c-1", triggerType: "order_cancelled", context: { note: "de novo" } });
  check("recovery dedupe: segue com 1 sinal", recSignals(onOrg).length === 1);
  // trigger heurístico → basis='estimate'
  RR.detect({ organizationId: onOrg, contactId: "c-2", triggerType: "complaint_detected", context: { snippet: "produto ruim" } });
  const complaintSig = recSignals(onOrg).find((r) => r.signal_type === "complaint_detected");
  check("recovery heurístico (complaint) → basis='estimate'", complaintSig?.basis === "estimate");

  // ===== 7. ManipulationRadar → business_signals (F2.3) =====
  const repSignals = (orgId: string) =>
    db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'reputation'").all(orgId) as any[];
  // texto minúsculo de propósito: a dedupe do ManipulationRadar compara
  // lower() do SQLite (ASCII-only) — maiúscula acentuada não casaria (bug
  // pré-existente, fora do escopo desta fatia). discount+urgency+pressure → high.
  const highManip = "só hoje 50% de desconto! você precisa aproveitar, não perca!";
  // flag OFF: não projeta
  MR.scan({ organizationId: offOrg, text: highManip, source: "campaign_copy", ref: "c-off" });
  check("manipulation flag OFF: nenhum sinal", repSignals(offOrg).length === 0);
  // flag ON: projeta 1 sinal (severidade high → risk)
  const al = MR.scan({ organizationId: onOrg, text: highManip, source: "campaign_copy", ref: "camp-1" });
  const reps = repSignals(onOrg);
  check("manipulation flag ON: 1 sinal domain='reputation'", reps.length === 1);
  check("manipulation: signal_type='manipulative_copy', subject_type='message'", reps[0]?.signal_type === "manipulative_copy" && reps[0]?.subject_type === "message");
  check("manipulation: basis='estimate' (léxico), severity high→risk", reps[0]?.basis === "estimate" && reps[0]?.severity === "risk");
  check("manipulation: dedupe_key = manipulation:<id>", reps[0]?.dedupe_key === `manipulation:${al?.id}`);
  // dedupe: mesmo texto+source na janela → mesmo alerta, ainda 1 sinal
  MR.scan({ organizationId: onOrg, text: highManip, source: "campaign_copy", ref: "camp-1" });
  check("manipulation dedupe: segue com 1 sinal", repSignals(onOrg).length === 1);
  // severidade low → info
  MR.scan({ organizationId: onOrg, text: "Frete grátis para sua região.", source: "other" });
  const lowSig = repSignals(onOrg).find((r) => r.severity === "info");
  check("manipulation low → severity='info'", !!lowSig);

  // ===== 8. Isolamento multi-tenant =====
  const other = mkOrg(true);
  check("isolamento: org B não vê sinais de oportunidade de A", oppSignals(other).length === 0);
  check("isolamento: org B não vê sinais de recovery de A", recSignals(other).length === 0);
  check("isolamento: org B não vê sinais de reputation de A", repSignals(other).length === 0);

  console.log("\n=== TEST: Espinha Única F2 — detectores → business_signals (opportunity+recovery) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Radar Signals Unified (F2.1+F2.2+F2.3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
