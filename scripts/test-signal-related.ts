/**
 * TEST — PRD 2 F3.3 (§17-18, CA4): correlação de confiança MÉDIA. O mesmo tipo
 * de sinal em SUJEITOS DISTINTOS na janela = "possivelmente relacionado" (padrão)
 * — elo fraco que NÃO colapsa automaticamente (só a alta agrupa).
 *
 * Prova (determinístico):
 *   - related: (domain, signal_type) com ≥minRelated sujeitos distintos → medium;
 *   - a média NÃO colapsa no attention (só a alta); os sinais seguem individuais;
 *   - minRelated + janela temporal barram padrões fracos;
 *   - alta e média são ortogonais (mesmo sinal pode estar nas duas leituras);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:signal-related
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-related-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-related-1234567890";

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

  // Padrão: stockout em 3 SKUs (M/N/O). sku-M ainda tem 2 sinais → também é cluster ALTO.
  const mStock = pub({ domain: "inventory", signalType: "stockout_risk", severity: "risk", impactAmount: 6800, impactUnit: "BRL", dedupeKey: "m-stock", subjectType: "product", subjectId: "sku-M" });
  pub({ domain: "sales", signalType: "conversion_drop", dedupeKey: "m-conv", subjectType: "product", subjectId: "sku-M" });
  pub({ domain: "customer", signalType: "human_report", severity: "info", dedupeKey: "m-human", subjectType: "product", subjectId: "sku-M" });
  const nStock = pub({ domain: "inventory", signalType: "stockout_risk", dedupeKey: "n-stock", subjectType: "product", subjectId: "sku-N" });
  const oStock = pub({ domain: "inventory", signalType: "stockout_risk", dedupeKey: "o-stock", subjectType: "product", subjectId: "sku-O" });
  // 4º SKU antigo (fora da janela padrão).
  const pStock = pub({ domain: "inventory", signalType: "stockout_risk", dedupeKey: "p-stock", subjectType: "product", subjectId: "sku-P" });
  setDetected(pStock.id, new Date(Date.now() - 200 * 3600e3).toISOString());

  // ===== 1. related (média) =====
  const out = SC.clusters(org);
  const pat = out.related.find((r: any) => r.key === "inventory:stockout_risk");
  check("1.1 alta (clusters) traz o cluster de sku-M", out.clusters.some((c: any) => c.subjectId === "sku-M"));
  check("1.2 média (related): padrão stockout com 3 sujeitos distintos, confidence medium", !!pat && pat.confidence === "medium" && pat.evidenceCount === 3);
  check("1.3 subjectIds = M/N/O (antigo P fora da janela)", pat && ["sku-M", "sku-N", "sku-O"].every((s) => pat.subjectIds.includes(s)) && !pat.subjectIds.includes("sku-P"));
  check("1.4 ortogonal: sku-M aparece na alta E no padrão médio", pat.subjectIds.includes("sku-M") && out.clusters.some((c: any) => c.subjectId === "sku-M"));

  // ===== 2. Média NÃO colapsa no attention (só a alta) =====
  const att = BS.attention(org, { correlate: true });
  check("2.1 attention colapsa a alta (situação sku-M)", att.items.some((i: any) => i.source === "situation" && i.subjectId === "sku-M"));
  check("2.2 mas os stockouts de N/O seguem INDIVIDUAIS (média não agrupa)", [nStock.id, oStock.id].every((id) => att.items.some((i: any) => i.source === "signal" && i.id === id)));

  // ===== 3. minRelated + janela =====
  check("3.1 minRelated=4 → sem padrão (só 3 na janela)", !SC.clusters(org, { minRelated: 4 }).related.some((r: any) => r.key === "inventory:stockout_risk"));
  check("3.2 janela ampla inclui sku-P → 4 sujeitos", (() => { const r = SC.clusters(org, { windowHours: 999 }).related.find((x: any) => x.key === "inventory:stockout_risk"); return r?.evidenceCount === 4 && r.subjectIds.includes("sku-P"); })());

  // ===== 4. Isolamento =====
  const orgB = mkOrg();
  check("4.1 padrão de A não aparece em B", SC.clusters(orgB).relatedTotal === 0);

  console.log("\n=== TEST: Correlação média F3.3 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Correlação média F3.3 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
