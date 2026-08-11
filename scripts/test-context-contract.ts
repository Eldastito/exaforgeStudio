/**
 * TEST — PRD 3 F10 (AC-A05/§127): Contrato do ContextPacket (SkillOS). DB-backed,
 * isolado por tmpDir. Determinístico. Prova o VALIDADOR que blinda a interface
 * PRD 3 ↔ PRD 4 contra regressão silenciosa:
 *
 *   - todo pacote REAL resolvido (F3) passa no contrato — em TODOS os perfis;
 *   - schemaVersion é a constante do contrato (o resolver emite a constante);
 *   - malformações são PEGAS com erro preciso: campo faltando, tipo errado,
 *     schemaVersion errado, budget incompleto, banda de confiança inválida,
 *     frescor não-inteiro, e a INVARIANTE de budget estourado (array > teto);
 *   - assertContextPacket LANÇA no pacote inválido; a fachada Engine.validatePacket
 *     delega; validar não vaza entre tenants (isolamento herdado do resolver).
 *
 * Uso: npm run test:context-contract
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-contract-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-contract-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextResolverService: R } = await import("../src/server/ContextResolverService.js");
  const { ContextEngineService: ENG } = await import("../src/server/ContextEngineService.js");
  const CM = await import("../src/server/contextModel.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };
  const org = mkOrg();
  // popula um pouco de sinal pra o pacote ter fatos/momento reais.
  for (let i = 0; i < 3; i++) {
    SIG.publish(org, { domain: "sales", signalType: `s${i}`, severity: "info", basis: "fact", confidence: 0.8, subjectType: "customer", subjectId: `c${i}`, sourceService: "t", evidence: {}, dedupeKey: `d${i}` });
  }

  // ═══════════════ 1. pacotes REAIS passam em todos os perfis ═══════════════
  for (const profile of ["minimal", "standard", "deep"] as const) {
    const pkt = R.resolve(org, { intent: "q", profile });
    const v = CM.validateContextPacket(pkt);
    check(`1.${profile} pacote real (${profile}) é válido`, v.valid && v.errors.length === 0);
  }
  const emptyOrgPkt = R.resolve(mkOrg(), { intent: "q" });
  check("1.4 pacote de org vazia também é válido (contrato robusto ao vazio)", CM.validateContextPacket(emptyOrgPkt).valid);

  // ═══════════════ 2. schemaVersion = constante ═══════════════
  const pkt = R.resolve(org, { intent: "q" });
  check("2.1 resolver emite a constante do contrato", pkt.schemaVersion === CM.CONTEXT_PACKET_SCHEMA_VERSION);

  // ═══════════════ 3. malformações PEGAS com erro preciso ═══════════════
  const clone = () => JSON.parse(JSON.stringify(pkt));
  const badType = (mut: (p: any) => void, needle: string, name: string) => {
    const c = clone(); mut(c); const v = CM.validateContextPacket(c);
    check(name, !v.valid && v.errors.some((e: string) => e.includes(needle)));
  };
  badType((c) => { delete c.tenantId; }, "tenantId", "3.1 tenantId faltando é pego");
  badType((c) => { c.facts = "x"; }, "facts", "3.2 facts não-array é pego");
  badType((c) => { c.schemaVersion = 99; }, "schemaVersion", "3.3 schemaVersion errado é pego");
  badType((c) => { c.truncated = "yes"; }, "truncated", "3.4 truncated não-boolean é pego");
  badType((c) => { delete c.budget.maxFacts; }, "budget.maxFacts", "3.5 budget incompleto é pego");
  badType((c) => { c.quality.confidence.band = "bogus"; }, "band", "3.6 banda de confiança inválida é pega");
  badType((c) => { c.quality.confidence.score = 2; }, "score", "3.7 confiança fora de [0,1] é pega");
  badType((c) => { c.quality.freshness.fresh = 1.5; }, "freshness.fresh", "3.8 frescor não-inteiro é pego");
  badType((c) => { c.moment = null; }, "moment", "3.9 moment ausente é pego");
  // INVARIANTE: budget estourado (mais fatos que o teto).
  badType((c) => { c.budget.maxFacts = 0; c.facts = [{}]; }, "acima do teto", "3.10 budget estourado (facts > teto) é pego");
  // acumula TODAS as violações (não para na 1ª).
  const many = clone(); delete many.tenantId; many.facts = 1; many.truncated = 2;
  check("3.11 acumula múltiplas violações", CM.validateContextPacket(many).errors.length >= 3);
  // não-objeto.
  check("3.12 não-objeto é inválido", !CM.validateContextPacket(null).valid && !CM.validateContextPacket("x").valid);

  // ═══════════════ 4. assert LANÇA + fachada delega ═══════════════
  // alias com tipo plano: chamar a assinatura de asserção via namespace import
  // dispara TS2775 (o binding precisa de tipo explícito) — aqui só queremos o throw.
  const assertPkt: (p: unknown) => void = CM.assertContextPacket;
  let threw = false; try { assertPkt({ foo: 1 }); } catch { threw = true; }
  check("4.1 assertContextPacket lança no inválido", threw);
  let okAssert = true; try { assertPkt(pkt); } catch { okAssert = false; }
  check("4.2 assertContextPacket não lança no válido", okAssert);
  check("4.3 fachada Engine.validatePacket delega", ENG.validatePacket(pkt).valid && !ENG.validatePacket({}).valid);

  console.log("\n=== TEST: Context Packet Contract (PRD 3 F10) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Packet Contract (F10) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
