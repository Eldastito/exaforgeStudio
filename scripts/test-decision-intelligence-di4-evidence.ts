/**
 * TEST — Decision Intelligence DI-4.3 (ADR-156 D7): a inteligência externa
 * entra no fluxo de decisão.
 *   - Evidence Package preenche `externalEvidence[]` com as contextualizações
 *     frescas da org (read-only), vazio sem elas / sem opt-in.
 *   - DecisionEngine consome evidência externa SÓ em L3+ (via broker read-only,
 *     nunca dispara pesquisa). L0/L1 não consomem.
 *   - Isolamento por org. Determinístico, offline. Sem chave de IA.
 *
 * Uso: npm run test:decision-intelligence-di4-evidence
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di4e-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di4e-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { EvidencePackageService: EP } = await import("../src/server/EvidencePackageService.js");
  const { DecisionEngine: E } = await import("../src/server/DecisionEngine.js");

  const mkOrg = (vertical?: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, vertical || null); return id; };
  const enable = (id: string) => db.prepare("UPDATE organization_settings SET external_intelligence_enabled = 1 WHERE organization_id = ?").run(id);

  // Admin master roda a pesquisa do nicho (conta chamadas p/ provar read-only).
  let calls = 0;
  const countingStub = { name: "counting", research: (q: any) => { calls++; return { content: { summary: `mercado ${q.vertical}/${q.topic}` }, sources: ["s"], confidence: 0.6, costCents: 0 }; } };
  await VIS.runResearch(null, { vertical: "moda", topic: "inverno" }, { provider: countingStub as any });
  check("admin rodou a pesquisa 1×", calls === 1);

  const orgA = mkOrg("moda"); enable(orgA);

  // Antes de qualquer resolve: externalEvidence do pacote está vazio.
  check("Evidence Package: externalEvidence vazio antes de contextualizar", EP.build(orgA).externalEvidence.length === 0);

  // Decisão L3 (R$150k, risk) consome inteligência externa do nicho (read-only).
  const hi = E.analyze(orgA, { title: "Comprar coleção de inverno", decisionType: "purchase", externalTopic: "inverno", impactAmount: 150000, impactUnit: "BRL", severity: "risk" });
  check("L3: external.available = true (hit do nicho)", hi.level === "L3" && hi.external?.available === true && hi.external.source === "vertical_intelligence");
  check("L3: advocate cita a inteligência de mercado", Array.isArray(hi.advocate?.support) && hi.advocate.support.some((s: string) => s.includes("Inteligência de mercado")));
  check("read-only: DecisionEngine NÃO disparou pesquisa (calls segue 1)", calls === 1);

  // Agora o pacote reflete a contextualização criada no resolve.
  const epA = EP.build(orgA);
  check("Evidence Package: externalEvidence populado após consumo", epA.externalEvidence.length === 1 && epA.externalEvidence[0].vertical === "moda");

  // L1 (baixo impacto) não consome análise profunda nem externa.
  const low = E.analyze(orgA, { title: "follow-up", decisionType: "purchase", externalTopic: "inverno", impactAmount: 200, impactUnit: "BRL" });
  check("L1: análise pulada, sem consumo externo", low.skipped === true && low.external === undefined);

  // Opt-out: org não habilitada não recebe externa (mesmo em L3).
  const orgD = mkOrg("moda");
  const hiD = E.analyze(orgD, { title: "x", decisionType: "purchase", externalTopic: "inverno", impactAmount: 150000, impactUnit: "BRL", severity: "risk" });
  check("opt-out: external.available=false (reason opt_out)", hiD.external?.available === false && hiD.external.reason === "opt_out");
  check("opt-out: pacote sem externalEvidence", EP.build(orgD).externalEvidence.length === 0);

  // Sem pesquisa fresca do nicho: L3 pede, mas broker devolve indisponível.
  const orgE = mkOrg("food"); enable(orgE);
  const hiE = E.analyze(orgE, { title: "y", decisionType: "purchase", externalTopic: "inverno", impactAmount: 150000, impactUnit: "BRL", severity: "risk" });
  check("sem pesquisa do nicho: external.available=false", hiE.external?.available === false && hiE.external.reason === "no_fresh_vertical_intelligence");

  // Freshness: expira a pesquisa → o pacote da org A deixa de trazê-la.
  db.prepare("UPDATE vertical_intelligence SET valid_until = datetime('now','-1 day')").run();
  check("freshness: externalEvidence some quando a pesquisa expira", EP.build(orgA).externalEvidence.length === 0);

  // Isolamento: outra org habilitada (mesmo nicho) não vê a contextualização de A.
  const orgB = mkOrg("moda"); enable(orgB);
  check("isolamento: org B não vê externalEvidence de A", EP.build(orgB).externalEvidence.length === 0);

  console.log("\n=== TEST: Decision Intelligence DI-4.3 (evidência externa no fluxo) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-4.3 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
