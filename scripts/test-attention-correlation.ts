/**
 * TEST — PRD 2 F3.2 (§20, §58-60, CA10): surface da situação no attention().
 * O feed único passa a poder colapsar sinais correlatos (mesma situação) num
 * item-situação — OPT-IN (param ou flag por org), sem fonte nova, sem regredir.
 *
 * Prova (determinístico):
 *   - correlate OFF (default) → comportamento pré-F3.2 (sinais soltos);
 *   - correlate ON → 1 item 'situation' (evidenceCount + signalIds) no lugar dos
 *     N sinais; os não-correlatos seguem individuais;
 *   - flag por org liga sem passar param; isolamento multi-tenant.
 *
 * Uso: npm run test:attention-correlation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-att-corr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-att-corr-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (over: any) => BS.publish(org, { severity: "attention", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, ...over });

  // Cluster sku-M (3 evidências) + 1 sinal solto (finance, sem subject).
  const m1 = pub({ domain: "inventory", signalType: "stockout_risk", severity: "risk", impactAmount: 6800, impactUnit: "BRL", dedupeKey: "m1", subjectType: "product", subjectId: "sku-M" });
  const m2 = pub({ domain: "sales", signalType: "conversion_drop", dedupeKey: "m2", subjectType: "product", subjectId: "sku-M" });
  const m3 = pub({ domain: "customer", signalType: "human_report", severity: "info", dedupeKey: "m3", subjectType: "product", subjectId: "sku-M" });
  pub({ domain: "finance", signalType: "cash_low", severity: "critical", dedupeKey: "solo" });

  // ===== 1. OFF (default) vs ON =====
  const off = BS.attention(org, { correlate: false });
  check("1.1 correlate OFF: 4 itens soltos, sem 'situation'", off.items.length === 4 && !off.items.some((i: any) => i.source === "situation"));

  const on = BS.attention(org, { correlate: true });
  const sit = on.items.find((i: any) => i.source === "situation");
  check("1.2 correlate ON: 1 situação + 1 solo = 2 itens", on.items.length === 2 && !!sit);
  check("1.3 situação traz evidenceCount 3 + signalIds", sit?.evidenceCount === 3 && [m1.id, m2.id, m3.id].every((id) => sit.signalIds.includes(id)));
  check("1.4 situação herda a maior severidade (risk) + impacto representativo (6800)", sit?.severity === "risk" && sit?.impactAmount === 6800);
  check("1.5 os 3 sinais colapsados NÃO aparecem soltos", !on.items.some((i: any) => i.source === "signal" && [m1.id, m2.id, m3.id].includes(i.id)));
  check("1.6 o sinal solto (finance) segue individual", on.items.some((i: any) => i.source === "signal" && i.type === "cash_low"));

  // ===== 2. Flag por org liga sem param =====
  db.prepare(`UPDATE organization_settings SET radar_attention_correlate_enabled = 1 WHERE organization_id = ?`).run(org);
  check("2.1 flag ON: attention() sem param já colapsa", BS.attention(org).items.some((i: any) => i.source === "situation"));
  const org2 = mkOrg();
  const x = BS.publish(org2, { domain: "inventory", signalType: "x", severity: "risk", basis: "fact", confidence: 1, sourceService: "test", evidence: {}, dedupeKey: "x1", subjectType: "product", subjectId: "sku-Z" });
  BS.publish(org2, { domain: "sales", signalType: "y", severity: "attention", basis: "fact", confidence: 1, sourceService: "test", evidence: {}, dedupeKey: "y1", subjectType: "product", subjectId: "sku-Z" });
  check("2.2 flag OFF (default) numa org nova: attention() NÃO colapsa (regressão segura)", !BS.attention(org2).items.some((i: any) => i.source === "situation") && BS.attention(org2).items.length === 2);

  // ===== 3. Isolamento =====
  check("3.1 situação de A não aparece em B", !BS.attention(org2, { correlate: true }).items.some((i: any) => i.subjectId === "sku-M"));

  console.log("\n=== TEST: Attention correlacionado F3.2 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Attention correlacionado F3.2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
