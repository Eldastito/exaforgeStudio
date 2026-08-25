/**
 * TEST — Executive Proactive Briefing (ADR-190, diferida entregue). Digest executivo
 * SEMANAL por EXCEÇÃO publicado na ESPINHA (business_signals), de onde flui pras
 * superfícies proativas existentes. Não é 2º motor — é um publisher (molde publishLearnOne).
 *
 * Cobre: negócio calmo → não publica (anti-ruído) · com exceção → notable + publica info ·
 * gate 7d (idempotente) · money-free (qualitativo, sem R$) · TTL semanal · flui pro
 * attention() · isolamento.
 *
 * Uso: npm run test:executive-proactive-briefing
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-exproa-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-exproa-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveProactiveService: P } = await import("../src/server/ExecutiveProactiveService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const O = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), O);

  // ── 1. Negócio calmo → não notable, não publica (anti-ruído §115) ──
  const b0 = P.briefing(O);
  check("1.1 negócio calmo → notable false", b0.notable === false);
  check("1.2 texto calmo", b0.text.includes("sob controle"));
  const p0 = P.publish(O);
  check("1.3 não publica quando não há nada estratégico", p0.published === false && p0.reason === "nothing_notable");

  // ── 2. Com desvio crítico → notable + digest publicado (info) ──
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "t", evidence: { n: 3 }, dedupeKey: "fin-crit",
  });
  const b1 = P.briefing(O);
  check("2.1 agora notable", b1.notable === true);
  check("2.2 aponta pior pilar Financeiro + restrição", b1.worstPillar?.pillar === "finance" && !!b1.constraintFact);
  check("2.3 money-free (sem R$ no texto)", !/R\$/.test(b1.text));
  const p1 = P.publish(O);
  check("2.4 publicou o digest", p1.published === true);
  const sig = BusinessSignalService.attention(O).items.find((i: any) => i.type === "executive_briefing");
  check("2.5 digest na espinha (attention), severidade info", !!sig && sig.severity === "info");
  check("2.6 impacto R$ null (money-free)", sig?.impactAmount === null);

  // ── 3. Gate 7d: republicar não duplica ──
  const p2 = P.publish(O);
  check("3.1 gate 7d (not_due)", p2.published === false && p2.reason === "not_due");
  const count = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND signal_type='executive_briefing'`).get(O) as any).n;
  check("3.2 apenas 1 digest (idempotente na semana)", count === 1);

  // ── 4. force ignora o gate (preview/teste) ──
  const p3 = P.publish(O, { force: true });
  check("4.1 force republica (mesma dedupe da semana → atualiza, não duplica)", p3.published === true);
  const count2 = (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND signal_type='executive_briefing'`).get(O) as any).n;
  check("4.2 dedupe semanal mantém 1 linha", count2 === 1);

  // ── 5. Isolamento ──
  const Q = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), Q);
  check("5.1 org Q calma → não publica", P.publish(Q).published === false);
  check("5.2 org Q não vê o digest de O", !BusinessSignalService.attention(Q).items.some((i: any) => i.type === "executive_briefing"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-proactive-briefing: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
