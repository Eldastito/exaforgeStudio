/**
 * TEST — PRD 2 F3.1 (§16-20, CA4): correlação de sinais (confiança alta).
 * Vários sinais DIFERENTES do MESMO sujeito viram UMA situação com múltiplas
 * evidências — derivado sobre o ledger, sem destruir a evidência individual.
 *
 * Cenário §16: SKU-M com estoque=0 (ERP) + queda de venda (PDV) + relato humano.
 *
 * Prova (determinístico):
 *   - agrupa por (subject_type, subject_id), cruzando domínios; confiança high;
 *   - impacto REPRESENTATIVO = maior |amount| (nunca soma);
 *   - janela temporal: sinal aberto muito antigo não cola na rajada;
 *   - minEvidence: 1 sinal solto NÃO é situação; sem subject_id não agrupa;
 *   - CA4: evidência individual preservada (sinais seguem no ledger);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:signal-correlation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-corr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-corr-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { SignalCorrelationService: SC } = await import("../src/server/SignalCorrelationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (over: any) => BS.publish(org, { severity: "attention", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, ...over });
  const setDetected = (id: string, iso: string) => db.prepare(`UPDATE business_signals SET detected_at = ? WHERE id = ?`).run(iso, id);

  // SKU-M: 3 evidências recentes (multi-domínio) + 1 antiga (fora da janela).
  const s1 = pub({ domain: "inventory", signalType: "stockout_risk", severity: "risk", impactAmount: 6800, impactUnit: "BRL", dedupeKey: "m1", subjectType: "product", subjectId: "sku-M" });
  const s2 = pub({ domain: "sales", signalType: "conversion_drop", severity: "attention", impactAmount: 1200, impactUnit: "BRL", dedupeKey: "m2", subjectType: "product", subjectId: "sku-M" });
  const s3 = pub({ domain: "customer", signalType: "human_report", severity: "info", dedupeKey: "m3", subjectType: "product", subjectId: "sku-M" });
  const sOld = pub({ domain: "procurement", signalType: "supplier_delay", severity: "attention", dedupeKey: "m-old", subjectType: "product", subjectId: "sku-M" });
  setDetected(sOld.id, new Date(Date.now() - 200 * 3600e3).toISOString());
  // Ruído: 1 sinal solto (SKU-N) + 1 sem subject.
  pub({ domain: "inventory", signalType: "stockout_risk", severity: "risk", dedupeKey: "n1", subjectType: "product", subjectId: "sku-N" });
  pub({ domain: "finance", signalType: "cash_low", severity: "critical", dedupeKey: "f1" });

  // ===== 1. Cluster de confiança alta =====
  const out = SC.clusters(org);
  const m = out.clusters.find((c: any) => c.subjectId === "sku-M");
  check("1.1 UMA situação p/ sku-M, confiança high, 3 evidências (antiga fora da janela)", !!m && m.confidence === "high" && m.evidenceCount === 3);
  check("1.2 cruza domínios (inventory + sales + customer)", m && ["inventory", "sales", "customer"].every((d) => m.domains.includes(d)));
  check("1.3 maxSeverity = risk (a mais alta do cluster)", m?.maxSeverity === "risk");
  check("1.4 impacto REPRESENTATIVO = maior |amount| (6800), NÃO somado (≠8000)", m?.representativeImpact.amount === 6800 && m?.representativeImpact.unit === "BRL");
  check("1.5 CA4: cluster referencia os 3 signalIds", m && [s1.id, s2.id, s3.id].every((id) => m.signalIds.includes(id)) && !m.signalIds.includes(sOld.id));

  // ===== 2. Evidência individual preservada (não destruída) =====
  check("2.1 os sinais seguem no ledger, individualmente", BS.list(org, {}).filter((s: any) => s.subject_id === "sku-M").length === 4);

  // ===== 3. Janela temporal =====
  const wide = SC.clusters(org, { windowHours: 999 });
  const mWide = wide.clusters.find((c: any) => c.subjectId === "sku-M");
  check("3.1 janela ampla inclui o sinal antigo (4 evidências)", mWide?.evidenceCount === 4 && mWide.signalIds.includes(sOld.id));

  // ===== 4. minEvidence + sem-subject não agrupam =====
  check("4.1 sku-N (1 sinal) NÃO vira situação", !out.clusters.some((c: any) => c.subjectId === "sku-N"));
  check("4.2 sinal sem subject não entra em cluster nenhum", !out.clusters.some((c: any) => c.signalTypes.includes("cash_low")));

  // ===== 5. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("5.1 correlação de A não aparece em B", SC.clusters(orgB).total === 0);

  console.log("\n=== TEST: Correlation Engine F3.1 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Correlation Engine F3.1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
