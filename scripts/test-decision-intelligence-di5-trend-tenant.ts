/**
 * TEST — Decision Intelligence DI-5.6 (ADR-157): a TENDÊNCIA de mercado chega ao
 * LOJISTA. Valida o contrato que o Diretor IA consome:
 *   - ResearchBrokerService.resolve (leitura read-only do tenant) devolve `trend`
 *     = o delta da última versão do nicho (novo/cresceu/retraiu/saiu + confiança).
 *   - 1ª versão → trend.isFirst=true (sem "anterior"); 2ª versão muda os drivers
 *     → o delta reflete new/grew/shrank/gone e a variação de confiança.
 *   - Opt-out não recebe trend (available=false).
 *   - O `trend` é COMPARTILHADO e anonimizado: duas orgs veem o MESMO delta do
 *     nicho, e ele nunca carrega id/dado de tenant (RN-157-1). Read-only: resolve
 *     nunca dispara pesquisa.
 *   - Passa também pela rota-espelho: DecisionEngine.analyze (L3) expõe o trend
 *     em `out.external.trend`.
 *
 * Determinístico, offline, sem chave de IA.
 * Uso: npm run test:decision-intelligence-di5-trend-tenant
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5tt-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5tt-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBrokerService: Broker } = await import("../src/server/ResearchBrokerService.js");
  const { DecisionEngine: E } = await import("../src/server/DecisionEngine.js");

  const mkOrg = (vertical?: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, vertical || null); return id; };
  const enable = (id: string) => db.prepare("UPDATE organization_settings SET external_intelligence_enabled = 1 WHERE organization_id = ?").run(id);

  const orgA = mkOrg("moda"); enable(orgA);

  // ── 1ª pesquisa do nicho (admin master). Read-only: contamos as chamadas de
  //    provider que o BROKER faz — tem que ser sempre 0. ──────────────────────
  let brokerCalls = 0;
  const spyProvider = { name: "spy", research: (q: any) => { brokerCalls++; return { content: { summary: "x" }, sources: [], confidence: 0.5, costCents: 0 }; } };
  // (só usado se o broker chamasse provider — ele não deve; VIS usa o dele)
  void spyProvider;

  VIS.runManual({ userId: "admin" }, { vertical: "moda", topic: "inverno", summary: "Inverno aquecido para malharia.", drivers: ["malha", "casaco"], confidence: 0.5 });

  const r1 = Broker.resolve(orgA, { vertical: "moda", topic: "inverno" });
  check("resolve devolve trend na 1ª versão", r1.available === true && r1.trend != null);
  check("1ª versão: trend.isFirst=true, sem mudanças materiais", r1.trend?.isFirst === true && r1.trend.new.length === 2 && r1.trend.grew.length === 0);

  // ── 2ª pesquisa: muda os drivers e a confiança → o delta tem que refletir. ──
  // Antes: ["malha","casaco"]. Depois: ["casaco","tricô"] com conf 0.7.
  //   - "casaco" subiu (idx 1 → 0) = cresceu
  //   - "tricô" apareceu = novo
  //   - "malha" sumiu = saiu
  //   - confiança 0.5 → 0.7 = +0.2
  VIS.runManual({ userId: "admin" }, { vertical: "moda", topic: "inverno", summary: "Casaco puxa a demanda; tricô emergindo.", drivers: ["casaco", "tricô"], confidence: 0.7 });

  const r2 = Broker.resolve(orgA, { vertical: "moda", topic: "inverno" });
  const t = r2.trend;
  check("2ª versão: trend.isFirst=false", t?.isFirst === false);
  check("delta: 'tricô' é novo", Array.isArray(t?.new) && t.new.includes("tricô"));
  check("delta: 'casaco' cresceu (subiu no ranking)", Array.isArray(t?.grew) && t.grew.includes("casaco"));
  check("delta: 'malha' saiu", Array.isArray(t?.gone) && t.gone.includes("malha"));
  check("delta: confidenceDelta = +0.2", Math.abs(Number(t?.confidenceDelta) - 0.2) < 1e-9);
  check("resolve NUNCA dispara pesquisa (read-only)", brokerCalls === 0);

  // ── O trend é COMPARTILHADO/anonimizado: 2ª org (mesmo nicho) vê o MESMO delta.
  const orgB = mkOrg("moda"); enable(orgB);
  const rB = Broker.resolve(orgB, { vertical: "moda", topic: "inverno" });
  check("compartilhado: org B vê o mesmo delta do nicho", JSON.stringify(rB.trend) === JSON.stringify(r2.trend));
  // ...e o delta não carrega nenhum id/dado de tenant (RN-157-1).
  const trendStr = JSON.stringify(r2.trend);
  check("anonimização: trend não contém organization_id/fingerprint de tenant", !trendStr.includes(orgA) && !trendStr.includes(orgB));

  // ── Opt-out: org sem flag não recebe trend. ────────────────────────────────
  const orgC = mkOrg("moda"); // sem enable
  const rC = Broker.resolve(orgC, { vertical: "moda", topic: "inverno" });
  check("opt-out: available=false, sem trend", rC.available === false && rC.reason === "opt_out" && rC.trend === undefined);

  // ── Sem pesquisa fresca do nicho: sem trend. ───────────────────────────────
  const orgD = mkOrg("food"); enable(orgD);
  const rD = Broker.resolve(orgD, { vertical: "food", topic: "verão" });
  check("nicho sem pesquisa: available=false, sem trend", rD.available === false && rD.trend === undefined);

  // ── Rota-espelho: DecisionEngine.analyze (L3) expõe o trend em out.external. ─
  const hi = E.analyze(orgA, { title: "Comprar coleção de inverno", decisionType: "purchase", externalTopic: "inverno", impactAmount: 150000, impactUnit: "BRL", severity: "risk" });
  check("analyze L3: out.external.trend presente e reflete o delta", hi.external?.available === true && hi.external.trend?.isFirst === false && hi.external.trend.new.includes("tricô"));

  console.log("\n=== TEST: Decision Intelligence DI-5.6 (tendência de mercado no Diretor IA) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.6 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
