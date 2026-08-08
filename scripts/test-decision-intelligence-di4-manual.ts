/**
 * TEST — Decision Intelligence DI-4.4 (ADR-156): provider MANUAL. O admin master
 * cola a pesquisa do nicho (sem rede externa). Passa pelo mesmo filtro de
 * anonimização; custo zero (não toca no orçamento); o tenant consome read-only.
 * Determinístico, offline. Sem chave de IA.
 *
 * Uso: npm run test:decision-intelligence-di4-manual
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di4m-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di4m-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBrokerService: Broker } = await import("../src/server/ResearchBrokerService.js");
  const { ResearchBudgetService: Budget } = await import("../src/server/ResearchBudgetService.js");
  const { containsPII } = await import("../src/server/researchAnonymize.js");

  const mkOrg = (vertical?: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, vertical || null); return id; };

  // ===================== Cola manual básica =====================
  const vi = VIS.runManual({ userId: "admin1" }, { vertical: "moda", topic: "inverno", region: "brasil", summary: "Demanda de inverno aquecida no varejo de moda; peças de alfaiataria em alta.", drivers: ["frio antecipado", "retomada do varejo"], sources: ["Relatório setorial 2026"] });
  check("runManual grava entrada fresca do provider 'manual'", !!vi && vi.provider === "manual" && vi.fresh === true);
  check("conteúdo colado preservado (summary/drivers)", vi.content?.summary?.includes("alfaiataria") && Array.isArray(vi.content?.drivers) && vi.content.drivers.length === 2);

  // ===================== Anonimização vale para o texto colado =====================
  const viPII = VIS.runManual({ userId: "admin1" }, { vertical: "food", topic: "delivery", summary: "Contato do fornecedor joao@acme.com, CPF 123.456.789-00, tel (11) 91234-5678." });
  check("anonimização: PII do texto colado é removida antes de gravar", !containsPII(JSON.stringify(viPII.content)));

  // ===================== Custo zero: não toca no orçamento =====================
  Budget.setBudgetCents(100);
  // Esgota o orçamento com uma pesquisa que custa 200c.
  const costing = { name: "costing", research: () => ({ content: { summary: "x" }, sources: [], confidence: 0.5, costCents: 200 }) };
  await VIS.runResearch({ userId: "admin1" }, { vertical: "servicos", topic: "a" }, { provider: costing as any });
  check("orçamento esgotado após a pesquisa cara", Budget.status().exhausted === true);
  let researchBlocked = false;
  try { await VIS.runResearch({ userId: "admin1" }, { vertical: "servicos", topic: "b" }, { provider: costing as any }); } catch (e: any) { researchBlocked = e?.code === "budget_exceeded"; }
  check("provider PAGO é bloqueado pelo orçamento", researchBlocked === true);
  // Manual passa mesmo com orçamento esgotado (custo zero).
  const viManualOverBudget = VIS.runManual({ userId: "admin1" }, { vertical: "servicos", topic: "c", summary: "pesquisa colada mesmo com orçamento esgotado" });
  check("manual NÃO é bloqueado pelo orçamento (custo zero)", !!viManualOverBudget && viManualOverBudget.provider === "manual");

  // ===================== Tenant consome a entrada manual (read-only) =====================
  const orgA = mkOrg("moda");
  db.prepare("UPDATE organization_settings SET external_intelligence_enabled = 1 WHERE organization_id = ?").run(orgA);
  const r = Broker.resolve(orgA, { vertical: "moda", topic: "inverno", region: "brasil" });
  check("tenant consome a pesquisa manual (hit L3)", r.available === true && r.source === "vertical_intelligence");

  // ===================== Dedup + validação + isolamento =====================
  VIS.runManual({ userId: "admin1" }, { vertical: "moda", topic: "inverno", region: "brasil", summary: "atualização da mesma pesquisa" });
  const cnt = (db.prepare("SELECT COUNT(*) c FROM vertical_intelligence WHERE vertical='moda' AND topic='inverno'").get() as any).c;
  check("dedup: recolar o mesmo nicho atualiza (não duplica)", cnt === 1);

  let threw = false;
  try { VIS.runManual({ userId: "admin1" }, { vertical: "moda", topic: "x", summary: "" }); } catch { threw = true; }
  check("validação: summary vazio é rejeitado", threw);

  const rawRow = db.prepare("SELECT * FROM vertical_intelligence LIMIT 1").get() as any;
  check("compartilhado (manual) NÃO tem organization_id", !("organization_id" in rawRow));

  console.log("\n=== TEST: Decision Intelligence DI-4.4 (provider manual) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-4.4 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
