/**
 * TEST — Decision Intelligence DI-5.3 (ADR-157): curadoria + publicação autônoma.
 *
 * ResearchCuratorService.curate liga provider → GATE de qualidade → anonimização
 * → publicação. Decisão do dono: o curador publica sozinho; o gate é o guarda.
 * RN-157-3: pacote reprovado (vazio/incoerente/confiança abaixo do piso) NÃO
 * publica e NÃO sobrescreve a última versão boa. Tudo offline, sem chave de IA.
 *
 * Uso: npm run test:decision-intelligence-di5-curate
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5c-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5c-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.EXTERNAL_RESEARCH_PROVIDER;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchCuratorService: Curator } = await import("../src/server/ResearchCuratorService.js");
  const { ResearchBudgetService: Budget } = await import("../src/server/ResearchBudgetService.js");
  const { containsPII } = await import("../src/server/researchAnonymize.js");

  const P = (r: any): any => ({ name: "llm", research: () => r });
  const good = P({ content: { summary: "Panorama sólido do nicho.", drivers: ["a", "b"], generatedBy: "llm" }, sources: ["Fonte"], confidence: 0.7, costCents: 2 });
  const empty = P({ content: { summary: "", drivers: [], generatedBy: "llm" }, sources: [], confidence: 0.9, costCents: 2 });
  const lowConf = P({ content: { summary: "x", drivers: ["a"], generatedBy: "llm" }, sources: [], confidence: 0.05, costCents: 2 });
  const pii = P({ content: { summary: "Fale com joao@acme.com CPF 123.456.789-00.", drivers: ["a"], generatedBy: "llm" }, sources: [], confidence: 0.7, costCents: 0 });

  Budget.setBudgetCents(0); // ilimitado para os testes que não são de orçamento

  // ===================== Gate de qualidade (função pura) =====================
  const qGood = Curator.assessQuality(good.research());
  check("assessQuality aprova pacote bom", qGood.ok === true && qGood.reasons.length === 0);
  const qEmpty = Curator.assessQuality(empty.research());
  check("assessQuality reprova pacote vazio ('empty')", qEmpty.ok === false && qEmpty.reasons.includes("empty"));
  const qLow = Curator.assessQuality(lowConf.research());
  check("assessQuality reprova confiança abaixo do piso ('low_confidence')", qLow.ok === false && qLow.reasons.includes("low_confidence"));

  // ===================== curate publica pacote bom =====================
  const r1 = await Curator.curate({ userId: "admin1" }, { vertical: "moda", topic: "inverno" }, { provider: good });
  check("curate publica pacote aprovado", r1.published === true && !!r1.result);
  const fp = researchFingerprint("moda", "inverno");
  const head1 = VIS.getByFingerprint(fp);
  check("head reflete o conteúdo publicado", head1?.content?.summary?.includes("sólido"));
  check("histórico ganhou a versão 1", VIS.history(fp).length === 1);

  // ===================== RN-157-3: pacote reprovado NÃO sobrescreve a base boa =====================
  const rReject = await Curator.curate({ userId: "admin1" }, { vertical: "moda", topic: "inverno" }, { provider: empty });
  check("curate reprova pacote vazio (published=false)", rReject.published === false && rReject.reason === "quality_rejected");
  const head2 = VIS.getByFingerprint(fp);
  check("RN-157-3: base boa PRESERVADA após reprovação", head2?.content?.summary?.includes("sólido"));
  check("RN-157-3: histórico NÃO cresce com reprovação", VIS.history(fp).length === 1);

  const rReject2 = await Curator.curate({ userId: "admin1" }, { vertical: "moda", topic: "inverno" }, { provider: lowConf });
  check("curate reprova confiança baixa (published=false)", rReject2.published === false);
  check("base boa segue preservada após 2ª reprovação", VIS.getByFingerprint(fp)?.content?.summary?.includes("sólido"));

  // ===================== Anonimização roda DEPOIS da curadoria =====================
  const rPii = await Curator.curate({ userId: "admin1" }, { vertical: "food", topic: "delivery" }, { provider: pii });
  check("curate publica pacote com PII no texto (aprovado)", rPii.published === true);
  const headPii = VIS.getByFingerprint(researchFingerprint("food", "delivery"));
  check("anonimização removeu PII no que foi publicado (RN-157-1)", !containsPII(JSON.stringify(headPii.content)));

  // ===================== Orçamento bloqueia antes do provider =====================
  Budget.setBudgetCents(100);
  let calls = 0;
  const costly = { name: "llm", research: () => { calls++; return { content: { summary: "ok", drivers: ["a"] }, sources: [], confidence: 0.7, costCents: 200 }; } };
  const rc1 = await Curator.curate({ userId: "admin1" }, { vertical: "servicos", topic: "a" }, { provider: costly });
  check("curate paga publica e esgota o orçamento", rc1.published === true && Budget.status().exhausted === true);
  const callsBefore = calls;
  const rc2 = await Curator.curate({ userId: "admin1" }, { vertical: "servicos", topic: "b" }, { provider: costly });
  check("curate recusa por orçamento (budget_exceeded)", rc2.published === false && rc2.reason === "budget_exceeded");
  check("provider NÃO é chamado quando o orçamento estourou", calls === callsBefore);

  // ===================== Fim-a-fim offline com o provider default (stub) =====================
  Budget.setBudgetCents(0);
  const rStub = await Curator.curate({ userId: "admin1" }, { vertical: "educacao", topic: "matriculas" }, {});
  check("curate offline com provider default (stub) publica", rStub.published === true && !!VIS.getByFingerprint(researchFingerprint("educacao", "matriculas")));

  // compartilhado sem organization_id (regressão)
  const rawRow = db.prepare("SELECT * FROM vertical_intelligence LIMIT 1").get() as any;
  check("compartilhado NÃO tem organization_id", !!rawRow && !("organization_id" in rawRow));

  console.log("\n=== TEST: Decision Intelligence DI-5.3 (curadoria + publicação autônoma) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.3 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
