/**
 * TEST — PRD 3 F12 (§97/§98): GOLDEN TESTS do ContextPacket. DB-backed, isolado por
 * tmpDir. Determinístico. É o HARDENING que fecha o PRD 3: trava a forma+conteúdo do
 * pacote ponta-a-ponta e deixa os utilitários golden REUSÁVEIS pro PRD 4. Prova:
 *
 *   - REPRODUTIBILIDADE: a mesma org resolvida 2× dá pacote canônico IDÊNTICO;
 *   - PUREZA/ISOLAMENTO: duas orgs com os MESMOS insumos → canônicos IDÊNTICOS
 *     (o pacote é função dos insumos, não vaza estado/tenant) — golden cross-tenant;
 *   - SENSIBILIDADE: um insumo a mais muda o canônico (não ignora entrada);
 *   - VALORES golden travados de um cenário conhecido (momento/fato/qualidade);
 *   - CONTRATO (F10): todo pacote golden passa em validateContextPacket;
 *   - cenário VAZIO é estável e mínimo.
 *
 * Uso: npm run test:context-golden
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-golden-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-golden-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextResolverService: R } = await import("../src/server/ContextResolverService.js");
  const { validateContextPacket } = await import("../src/server/contextModel.js");
  const { canonicalizeContextPacket, goldenStringify, firstGoldenDiff } = await import("../src/server/contextGolden.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };

  // O CENÁRIO golden: insumos fixos e determinísticos (o mesmo pra qualquer org).
  const seedScenario = (org: string) => {
    SIG.publish(org, { domain: "sales", signalType: "payment_overdue", severity: "risk", basis: "fact", confidence: 0.9, subjectType: "customer", subjectId: "c1", impactAmount: 500, impactUnit: "BRL", sourceService: "golden", evidence: { note: "x" }, dedupeKey: "g1" });
    SIG.publish(org, { domain: "finance", signalType: "cash_low", severity: "attention", basis: "estimate", confidence: 0.8, subjectType: "account", subjectId: "main", sourceService: "golden", evidence: {}, dedupeKey: "g2" });
  };
  const REQ = { intent: "golden", profile: "standard" as const };

  // ═══════════════ 1. REPRODUTIBILIDADE (mesma org 2×) ═══════════════
  const orgA = mkOrg(); seedScenario(orgA);
  const c1 = goldenStringify(R.resolve(orgA, REQ), { org: orgA });
  const c2 = goldenStringify(R.resolve(orgA, REQ), { org: orgA });
  check("1.1 mesma org resolvida 2× → canônico idêntico", c1 === c2);

  // ═══════════════ 2. GOLDEN cross-tenant (mesmos insumos → mesmo canônico) ══════
  const orgB = mkOrg(); seedScenario(orgB);
  const canA = canonicalizeContextPacket(R.resolve(orgA, REQ), { org: orgA });
  const canB = canonicalizeContextPacket(R.resolve(orgB, REQ), { org: orgB });
  const diff = firstGoldenDiff(canA, canB);
  check("2.1 duas orgs c/ mesmos insumos → canônico IDÊNTICO (pureza/isolamento)", diff === null);
  if (diff) console.log("   ↳ primeira divergência:", diff);

  // ═══════════════ 3. SENSIBILIDADE (insumo a mais muda o canônico) ═══════════════
  SIG.publish(orgB, { domain: "sales", signalType: "extra_signal", severity: "info", basis: "fact", confidence: 0.7, subjectType: "customer", subjectId: "c9", sourceService: "golden", evidence: {}, dedupeKey: "g3" });
  const canB2 = goldenStringify(R.resolve(orgB, REQ), { org: orgB });
  check("3.1 insumo a mais MUDA o canônico (não ignora entrada)", canB2 !== goldenStringify(R.resolve(orgA, REQ), { org: orgA }));

  // ═══════════════ 4. VALORES golden travados (cenário conhecido) ═══════════════
  const pktA = R.resolve(orgA, REQ);
  check("4.1 momento total = 2 sinais abertos", pktA.moment.total === 2);
  const overdue = pktA.facts.find((f: any) => f.predicate === "payment_overdue");
  check("4.2 fato do sinal com subject customer:c1 + predicate=signalType", !!overdue && overdue.subject === "customer:c1");
  check("4.3 objeto do fato carrega o impacto {amount:500, unit:BRL}", !!overdue && (overdue.object as any)?.amount === 500 && (overdue.object as any)?.unit === "BRL");
  check("4.4 confiança do fato preservada (0.9)", !!overdue && overdue.confidence === 0.9);
  check("4.5 momento por domínio inclui sales e finance", pktA.moment.byDomain.sales >= 1 && pktA.moment.byDomain.finance >= 1);
  check("4.6 schemaVersion + tenantId canonizados", canA.schemaVersion === 1 && canA.tenantId === "<org>" && canA.generatedAt === "<ts>");

  // ═══════════════ 5. CONTRATO (F10) em todo golden ═══════════════
  check("5.1 pacote golden passa no contrato (F10)", validateContextPacket(pktA).valid);
  for (const profile of ["minimal", "deep"] as const) {
    check(`5.2 golden ${profile} também passa no contrato`, validateContextPacket(R.resolve(orgA, { intent: "golden", profile })).valid);
  }

  // ═══════════════ 6. cenário VAZIO estável e mínimo ═══════════════
  const empty1 = mkOrg(); const empty2 = mkOrg();
  const ce1 = goldenStringify(R.resolve(empty1, REQ), { org: empty1 });
  const ce2 = goldenStringify(R.resolve(empty2, REQ), { org: empty2 });
  check("6.1 duas orgs vazias → canônico idêntico", ce1 === ce2);
  const emptyPkt = R.resolve(empty1, REQ);
  check("6.2 org vazia: 0 fatos, momento 0, contrato OK", emptyPkt.facts.length === 0 && emptyPkt.moment.total === 0 && validateContextPacket(emptyPkt).valid);

  console.log("\n=== TEST: Context Golden (PRD 3 F12) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Golden (F12) OK — PRD 3 fechado.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
