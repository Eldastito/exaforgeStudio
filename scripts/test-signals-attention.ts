/**
 * TEST — ADR-160 F1 (Onda A): leitura TRANSVERSAL de atenção.
 *
 * Prova, determinístico (RN-004, derivado; zero tabela nova):
 *   - funde business_signals ABERTOS + decision_risks vivos num único feed;
 *   - ranqueia por severidade (critical > risk > attention > info), normalizando
 *     os dois vocabulários (info/attention/risk/critical e low/medium/high);
 *   - respeita o TTL: sinal expirado (expires_at no passado) NÃO aparece;
 *   - sinais acknowledged/resolved e riscos resolved NÃO aparecem;
 *   - risco `materialized` sobe de nível;
 *   - totais por severidade/domínio + isolamento multi-tenant.
 *
 * Uso: npm run test:signals-attention
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-attention-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-attention-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: SS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const sig = (orgId: string, domain: string, type: string, severity: string, opts: { status?: string; expiresAt?: string | null; amount?: number } = {}) =>
    SS.publish(orgId, { domain, signalType: type, severity, basis: "fact", confidence: 1, impactAmount: opts.amount ?? null, impactUnit: opts.amount != null ? "BRL" : null, sourceService: "test", evidence: { summary: `${type} ocorreu` }, dedupeKey: `${domain}:${type}:${randomUUID().slice(0, 6)}`, expiresAt: opts.expiresAt ?? null });
  const setStatus = (orgId: string, id: string, status: string) => db.prepare(`UPDATE business_signals SET status = ? WHERE id = ? AND organization_id = ?`).run(status, id, orgId);
  const mkRisk = (orgId: string, severity: string, status: string, desc: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO decision_risks (id, organization_id, source, description, severity, status, dedupe_key) VALUES (?, ?, 'premortem', ?, ?, ?, ?)`).run(id, orgId, desc, severity, status, `risk:${randomUUID().slice(0, 6)}`);
    return id;
  };

  const orgA = mkOrg();
  // Sinais de várias severidades/domínios.
  sig(orgA, "finance", "cash_below_minimum", "critical", { amount: 5000 });
  sig(orgA, "sales", "sales_recovery_proposed", "attention");
  sig(orgA, "churn", "churn_risk_high", "risk");
  sig(orgA, "plan", "near_limit", "info");
  // Um expirado (não deve aparecer) e um já acknowledged (não deve aparecer).
  sig(orgA, "retail_ops", "stockout", "risk", { expiresAt: "2020-01-01T00:00:00.000Z" });
  const acked = sig(orgA, "reputation", "manipulative_copy", "attention");
  setStatus(orgA, acked.id, "acknowledged");
  // Riscos DI-2.
  mkRisk(orgA, "high", "predicted", "Fornecedor pode atrasar");   // high → critical
  mkRisk(orgA, "medium", "materialized", "Custo subiu");          // medium(risk) materialized → critical
  mkRisk(orgA, "low", "resolved", "já resolvido");               // resolved → fora

  const att = SS.attention(orgA);

  // ===== 1. Fusão + filtros =====
  // Vivos: 4 sinais (critical/attention/risk/info) + 2 riscos = 6. (expirado, acked, risco resolvido fora)
  check("funde sinais + riscos vivos (6 itens; expirado/acked/resolvido fora)", att.total === 6 && att.items.length === 6);
  check("itens têm as 2 fontes (signal + risk)", att.items.some((i: any) => i.source === "signal") && att.items.some((i: any) => i.source === "risk"));

  // ===== 2. Ranqueamento por severidade =====
  const sevs = att.items.map((i: any) => i.severity);
  const rankOf: any = { critical: 0, risk: 1, attention: 2, info: 3 };
  check("ordenado por severidade (não-decrescente)", sevs.every((s: string, i: number) => i === 0 || rankOf[sevs[i - 1]] <= rankOf[s]));
  check("1º item é critical", att.items[0].severity === "critical");

  // ===== 3. Normalização das 2 escalas + bump de materialized =====
  check("risco high → critical (normalizado)", att.items.some((i: any) => i.source === "risk" && i.summary.startsWith("Fornecedor") && i.severity === "critical"));
  check("risco medium MATERIALIZED → critical (bump)", att.items.some((i: any) => i.source === "risk" && i.summary.startsWith("Custo") && i.severity === "critical"));

  // ===== 4. Totais por severidade/domínio =====
  check("bySeverity: 3 critical (cash + 2 riscos), 1 risk, 1 attention, 1 info", att.bySeverity.critical === 3 && att.bySeverity.risk === 1 && att.bySeverity.attention === 1 && att.bySeverity.info === 1);
  check("byDomain inclui finance e decision", att.byDomain.finance === 1 && att.byDomain.decision === 2);

  // ===== 5. TTL / status =====
  check("sinal EXPIRADO não aparece", !att.items.some((i: any) => i.type === "stockout"));
  check("sinal ACKNOWLEDGED não aparece", !att.items.some((i: any) => i.type === "manipulative_copy"));
  check("risco RESOLVED não aparece", !att.items.some((i: any) => i.summary.includes("já resolvido")));

  // ===== 6. Isolamento =====
  const orgB = mkOrg();
  sig(orgB, "finance", "cash_below_minimum", "critical");
  const attB = SS.attention(orgB);
  check("isolamento: orgB vê só o seu (1 item)", attB.total === 1);
  check("isolamento: atenção de orgA inalterada", SS.attention(orgA).total === 6);
  const attEmpty = SS.attention(mkOrg());
  check("org sem nada → feed vazio", attEmpty.total === 0 && attEmpty.items.length === 0);

  console.log("\n=== TEST: Leitura Transversal de Atenção (ADR-160 F1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Leitura Transversal de Atenção (F1) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
