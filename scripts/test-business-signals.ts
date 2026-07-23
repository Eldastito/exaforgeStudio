/**
 * TEST — Ledger de Sinais Empresariais (ADR-136, Epic 2 — C1).
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:business-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { BusinessSignalService: SS } = await import("../src/server/BusinessSignalService.js");
  const { FinanceSignalPublisher: Pub } = await import("../src/server/FinanceSignalPublisher.js");

  const day = new Date().toISOString().slice(0, 10);
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const cnt = (o: string) => (db.prepare("SELECT COUNT(*) c FROM business_signals WHERE organization_id=?").get(o) as any).c;

  const orgA = mkOrg();
  F.recordEvent(orgA, { direction: "out", amount: 1000 });                                            // caixa -1000
  F.addReceivable(orgA, { description: "Atrasado", amount: 700, dueDate: "2020-01-01", probability: 1 }); // vencido 700

  // ===== 1. Publisher deriva sinais dos motores financeiros =====
  const r1 = Pub.run(orgA);
  check("FinanceSignalPublisher publica ≥ 2 sinais", r1.count >= 2 && r1.published.includes("cash_below_minimum") && r1.published.includes("receivable_overdue"));
  const open = SS.list(orgA, { status: "open" });
  const cashSig = open.find((s: any) => s.signal_type === "cash_below_minimum");
  check("caixa negativo: critical, fato, impacto -1000, evidência JSON", !!cashSig && cashSig.severity === "critical" && cashSig.basis === "fact" && cashSig.impact_amount === -1000 && typeof cashSig.evidence === "object");
  const recSig = open.find((s: any) => s.signal_type === "receivable_overdue");
  check("recebível vencido: attention, impacto 700", !!recSig && recSig.severity === "attention" && recSig.impact_amount === 700);
  check("lista vem ordenada por severidade (critical primeiro)", open[0].severity === "critical");

  // ===== 2. Idempotência: rodar de novo no mesmo dia NÃO duplica =====
  const before = cnt(orgA);
  const r2 = Pub.run(orgA);
  check("re-rodar no mesmo dia não cria linhas novas (idempotente)", cnt(orgA) === before && r2.count === r1.count);
  const k = `finance:custom_test:${day}`;
  const a = SS.publish(orgA, { domain: "finance", signalType: "custom_test", severity: "info", basis: "fact", confidence: 0.5, evidence: {}, sourceService: "test", dedupeKey: k });
  const b = SS.publish(orgA, { domain: "finance", signalType: "custom_test", severity: "risk", basis: "fact", confidence: 0.9, evidence: {}, sourceService: "test", dedupeKey: k });
  check("mesmo dedupe_key: 2ª publicação é deduped e reusa o id", b.deduped === true && b.id === a.id && a.deduped === false);

  // ===== 3. Validação =====
  let threw = false;
  try { SS.publish(orgA, { domain: "", signalType: "", severity: "info", basis: "fact", confidence: 0.5, evidence: {}, sourceService: "t", dedupeKey: "" } as any); } catch { threw = true; }
  check("publish sem domain/type/dedupe lança", threw);
  let threwSev = false;
  try { SS.publish(orgA, { domain: "finance", signalType: "x", severity: "URGENTE", basis: "fact", confidence: 1, evidence: {}, sourceService: "t", dedupeKey: "k2" } as any); } catch { threwSev = true; }
  check("severidade inválida é rejeitada", threwSev);

  // ===== 4. acknowledge / dismiss =====
  check("acknowledge move para 'acknowledged'", SS.acknowledge(orgA, recSig.id).ok === true && SS.list(orgA, { status: "acknowledged" }).some((s: any) => s.id === recSig.id));
  check("dismiss tira dos abertos", SS.dismiss(orgA, cashSig.id).ok === true && !SS.list(orgA, { status: "open" }).some((s: any) => s.id === cashSig.id));

  // ===== 5. Isolamento (sinais de A não vazam para B) =====
  const orgB = mkOrg();
  check("isolamento: org B não vê os sinais de A", SS.list(orgB).length === 0);
  Pub.run(orgB);
  check("isolamento: nenhum sinal de A aparece em B", !SS.list(orgB).some((s: any) => s.impact_amount === -1000 || s.signal_type === "receivable_overdue"));

  console.log("\n=== TEST: Ledger de Sinais (ADR-136 C1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Ledger de Sinais OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
