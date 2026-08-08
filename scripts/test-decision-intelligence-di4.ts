/**
 * TEST — Decision Intelligence DI-4.1 (ADR-156): External Intelligence de
 * vertical COMPARTILHADA e anonimizada.
 *   - Camada compartilhada nunca tem organization_id / PII.
 *   - Dedup: 1 pesquisa por nicho, N contextualizações; tenant é read-only
 *     (nunca chama o provider).
 *   - Freshness, opt-in, isolamento por org.
 * Determinístico e offline (provider stub). Sem chave de IA.
 *
 * Uso: npm run test:decision-intelligence-di4
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di4-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di4-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchBrokerService: Broker } = await import("../src/server/ResearchBrokerService.js");
  const { sanitizeForShared, containsPII, stripPII } = await import("../src/server/researchAnonymize.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const enable = (id: string) => db.prepare("UPDATE organization_settings SET external_intelligence_enabled = 1 WHERE organization_id = ?").run(id);

  // ===================== (A) Filtro de anonimização =====================
  check("containsPII detecta e-mail/CPF/telefone", containsPII("fale com joao@acme.com") && containsPII("CPF 123.456.789-00") && containsPII("(11) 91234-5678"));
  check("stripPII remove os identificadores", !containsPII(stripPII("joao@acme.com / 123.456.789-00 / (11) 91234-5678")));
  let threw = false;
  try { sanitizeForShared({ nota: "Loja Toulon fez X" }, ["Toulon"]); } catch { threw = true; }
  check("assertNoTenantData barra nome de tenant no compartilhado", threw);

  // ===================== (B) runResearch: escreve compartilhado, sem org/PII =====================
  const piiProvider = { name: "pii", research: () => ({ content: { summary: "contato joao@acme.com, CPF 123.456.789-00, tel (11) 91234-5678", drivers: ["tendência do nicho"] }, sources: ["x"], confidence: 0.4 }) };
  await VIS.runResearch(null, { vertical: "moda", topic: "pii-test" }, { provider: piiProvider as any });
  const viModa = VIS.getFresh("moda", "pii-test");
  check("runResearch grava entrada compartilhada fresca", !!viModa && viModa.fresh === true);
  const viJson = JSON.stringify(viModa?.content || {});
  check("compartilhado: PII do provider é removida antes de gravar", !containsPII(viJson));
  const rawRow = db.prepare("SELECT * FROM vertical_intelligence LIMIT 1").get() as any;
  check("compartilhado NÃO tem coluna organization_id (por design)", !("organization_id" in rawRow));

  // ===================== (C) Dedup: 1 pesquisa, N contextualizações =====================
  let providerCalls = 0;
  const countingStub = { name: "counting", research: (q: any) => { providerCalls++; return { content: { summary: `mercado ${q.vertical} ${q.topic}` }, sources: ["s"], confidence: 0.5 }; } };
  await VIS.runResearch(null, { vertical: "varejo", topic: "inverno", region: "brasil", timeframe: "2026" }, { provider: countingStub as any });
  check("admin roda a pesquisa UMA vez (provider chamado 1×)", providerCalls === 1);

  const orgA = mkOrg(); enable(orgA);
  const orgB = mkOrg(); enable(orgB);
  const q = { vertical: "varejo", topic: "inverno", region: "brasil", timeframe: "2026" };
  const rA = Broker.resolve(orgA, q);
  const rB = Broker.resolve(orgB, q);
  check("tenant A recebe evidência (hit L3)", rA.available === true && rA.source === "vertical_intelligence");
  check("tenant B recebe a MESMA pesquisa (reaproveita)", rB.available === true);
  check("tenant read-only: broker NUNCA chamou o provider", providerCalls === 1);

  const fp = researchFingerprint("varejo", "inverno", "brasil", "2026");
  const viCount = (db.prepare("SELECT COUNT(*) c FROM vertical_intelligence WHERE fingerprint = ?").get(fp) as any).c;
  const ctxCount = (db.prepare("SELECT COUNT(*) c FROM organization_contextualization WHERE fingerprint = ?").get(fp) as any).c;
  check("1 entrada compartilhada + 2 contextualizações (1 pesquisa, N contextos)", viCount === 1 && ctxCount === 2);

  // Reconsultar reusa a contextualização por-org (L2), sem novo provider.
  const rA2 = Broker.resolve(orgA, q);
  check("reconsulta do tenant usa L2 (contextualização própria)", rA2.cacheLevel === "L2" && providerCalls === 1);

  // ===================== (D) Freshness =====================
  db.prepare("UPDATE vertical_intelligence SET valid_until = datetime('now','-1 day') WHERE fingerprint = ?").run(fp);
  check("entrada expirada some do getFresh", VIS.getFresh("varejo", "inverno", "brasil", "2026") === null);
  const rExpired = Broker.resolve(orgA, q);
  check("expirado: broker devolve available:false (sem chamar provider)", rExpired.available === false && rExpired.reason === "no_fresh_vertical_intelligence" && providerCalls === 1);

  // ===================== (E) Opt-in =====================
  const orgC = mkOrg(); // NÃO habilitado
  await VIS.runResearch(null, { vertical: "food", topic: "delivery" }, { provider: countingStub as any });
  check("org sem opt-in não consome (reason opt_out)", Broker.resolve(orgC, { vertical: "food", topic: "delivery" }).reason === "opt_out");

  // ===================== (F) Isolamento =====================
  check("isolamento: contextualizações de B nunca têm org de A", Broker.list(orgB).every((c: any) => c.organization_id === orgB));
  check("isolamento: A não vê contextualização de B", Broker.list(orgA).every((c: any) => c.organization_id === orgA));

  console.log("\n=== TEST: Decision Intelligence DI-4.1 (ADR-156) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-4.1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
