/**
 * TEST — Decision Intelligence DI-1 (aditivo sobre ADR-135/136).
 *   (A) Classificação de impacto L0–L4 + perfil de análise (ImpactPrioritization).
 *   (B) Evidence Package v1: cache opt-in + freshness + confidence + sources.
 * Determinístico, sem chave de IA. Isolado por org.
 *
 * Uso: npm run test:decision-intelligence-di1
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di1-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService: P } = await import("../src/server/ImpactPrioritizationService.js");
  const { EvidencePackageService: EP } = await import("../src/server/EvidencePackageService.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const pub = (o: string, s: any) => S.publish(o, { sourceService: "test", evidence: { k: 1 }, ...s });

  // ===================== (A) Impact levels L0–L4 =====================

  // levelFor puro — determinístico e reproduzível.
  check("L0: info sem impacto BRL", P.levelFor({ severity: "info", impactUnit: "score" }).level === "L0");
  check("L0: aiDepth minimal + sem premortem", (() => { const a = P.levelFor({ severity: "info" }).analysis; return a.aiDepth === "minimal" && a.premortem === false && a.externalResearch === "no"; })());
  check("L1: attention com R$300", P.levelFor({ severity: "attention", impactAmount: 300, impactUnit: "BRL" }).level === "L1");
  check("L2: risk com R$8.000 → cache de pesquisa", (() => { const c = P.levelFor({ severity: "risk", impactAmount: 8000, impactUnit: "BRL" }); return c.level === "L2" && c.analysis.externalResearch === "cache" && c.analysis.premortemOptional === true; })());
  check("L3: compra de R$150k (severity risk) = alto impacto", (() => { const c = P.levelFor({ severity: "risk", impactAmount: 150000, impactUnit: "BRL" }); return c.level === "L3" && c.analysis.deepAnalysis === true && c.analysis.premortem === true && c.analysis.redTeam === true && c.analysis.externalResearch === "yes"; })());
  check("L4: override de segurança/compliance", (() => { const c = P.levelFor({ severity: "critical", override: true }); return c.level === "L4" && c.analysis.humanApprovalRequired === true; })());
  check("L4: crítico financeiro (severity critical + alto valor)", P.levelFor({ severity: "critical", impactAmount: 60000, impactUnit: "BRL" }).level === "L4");
  check("dinheiro sozinho não passa de L3 (sem severidade crítica)", P.levelFor({ severity: "attention", impactAmount: 500000, impactUnit: "BRL" }).n === 3);
  const lv1 = P.levelFor({ severity: "risk", impactAmount: 150000, impactUnit: "BRL" }).level;
  const lv2 = P.levelFor({ severity: "risk", impactAmount: 150000, impactUnit: "BRL" }).level;
  check("levelFor é reproduzível (sem LLM)", lv1 === lv2);

  // prioritize() carrega os campos aditivos SEM quebrar o score existente.
  const orgL = mkOrg();
  pub(orgL, { domain: "finance", signalType: "big_purchase", severity: "risk", basis: "estimate", confidence: 0.8, impactAmount: 150000, impactUnit: "BRL", dedupeKey: "f:big" });
  pub(orgL, { domain: "tasks", signalType: "data_quality_low", severity: "info", basis: "estimate", confidence: 0.5, impactUnit: "score", dedupeKey: "t:dq" });
  const rl = P.prioritize(orgL);
  const big = rl.global.find((p: any) => p.signalType === "big_purchase");
  check("prioridade traz impactLevel + label + analysis", !!big && big.impactLevel === "L3" && big.impactLevelLabel === "alto impacto" && typeof big.analysis === "object");
  check("campos legados intactos (score/components preservados)", !!big && typeof big.score === "number" && big.components.normalizedImpact === 1);

  // ===================== (B) Evidence Package v1 =====================
  const orgA = mkOrg();
  F.recordEvent(orgA, { direction: "in", amount: 5000 });
  F.addPayable(orgA, { description: "Fornecedor", amount: 2000, dueDate: "2030-12-01" });
  F.addReceivable(orgA, { description: "Cliente atrasado", amount: 700, dueDate: "2020-01-01", probability: 1 });

  // Flag OFF (default): computa fresco, não persiste (cacheHit sempre false).
  const off1 = EP.build(orgA);
  check("EP off: cacheHit=false", off1.cacheHit === false);
  check("EP tem generatedAt/expiresAt/freshness", !!off1.generatedAt && !!off1.expiresAt && off1.freshness === "fresh");
  check("EP freshness inicial é fresh", off1.freshness === "fresh");
  check("EP confidence é número 0..1", typeof off1.confidence === "number" && off1.confidence >= 0 && off1.confidence <= 1);
  check("EP sources não vazio (finance)", Array.isArray(off1.sources) && off1.sources.length > 0);
  check("EP reusa Snapshot V2 (internalEvidence.finance)", !!off1.internalEvidence && !!off1.internalEvidence.finance);
  check("EP slots externo/histórico vazios na v1 (adiados)", Array.isArray(off1.externalEvidence) && off1.externalEvidence.length === 0 && off1.historicalEvidence.length === 0);
  check("EP off NÃO persiste no cache", EP.get(orgA, off1.subject) === null);

  // Liga o cache (opt-in).
  db.prepare("UPDATE organization_settings SET evidence_layer_enabled = 1 WHERE organization_id = ?").run(orgA);
  const on1 = EP.build(orgA);
  check("EP on (1º): cacheHit=false (miss)", on1.cacheHit === false);
  const on2 = EP.build(orgA);
  check("EP on (2º): cacheHit=true (reusa)", on2.cacheHit === true && on2.id === on1.id);
  const forced = EP.build(orgA, { force: true });
  check("EP force ignora o cache (recomputa)", forced.cacheHit === false && forced.id !== on1.id);

  // TTL 0 → nunca fresco → sempre recomputa; get() marca stale.
  const orgT = mkOrg();
  db.prepare("UPDATE organization_settings SET evidence_layer_enabled = 1 WHERE organization_id = ?").run(orgT);
  EP.build(orgT, { ttlMinutes: 0 });
  const staleRead = EP.get(orgT, `business_snapshot:${new Date().toISOString().slice(0, 7)}`);
  check("EP TTL 0 → get() devolve freshness=stale", !!staleRead && staleRead.freshness === "stale");
  const t2 = EP.build(orgT, { ttlMinutes: 0 });
  check("EP stale não é servido do cache (recomputa)", t2.cacheHit === false);

  // Isolamento por org.
  const orgB = mkOrg();
  db.prepare("UPDATE organization_settings SET evidence_layer_enabled = 1 WHERE organization_id = ?").run(orgB);
  EP.build(orgB);
  check("isolamento: cache da org A não vaza pra org B", EP.get(orgB, off1.subject)?.organizationId === orgB);

  console.log("\n=== TEST: Decision Intelligence DI-1 (ADR-135/136 aditivo) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
