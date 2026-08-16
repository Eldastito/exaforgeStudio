/**
 * TESTE — LEGAL: orientação trabalhista (PRD Moda/TOULON; ADR-178)
 * ---------------------------------------------------------------
 * Prova, offline (LaborLawAdvisorService), o SCAFFOLD HONESTO:
 *   - base VAZIA: status = awaitingCuration, taxonomia presente;
 *   - advise sem base → grounded=false + "aguardando validação jurídica",
 *     NUNCA inventa CLT; disclaimer sempre presente;
 *   - curate EXIGE reviewedBy (RN-178-003) e topic válido;
 *   - após curar, advise GROUNDA na entrada revisada (com reviewedBy/citações);
 *   - pergunta sem match → volta ao honesto (não força a entrada errada);
 *   - disclaimer cravado em TODA resposta.
 *
 * Uso:  npm run test:labor-law-advisor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-labor-law-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-labor-law-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { LaborLawAdvisorService } = await import("../src/server/LaborLawAdvisorService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;

  // ===== 1. base vazia: aguardando curadoria =====
  const st0 = LaborLawAdvisorService.status();
  check("base vazia → awaitingCuration + curated false", st0.awaitingCuration === true && st0.curated === false && st0.entriesCount === 0);
  check("taxonomia de temas presente (10)", Array.isArray(st0.topics) && st0.topics.length === 10 && st0.topics.every((t: any) => t.entries === 0));
  check("status carrega disclaimer + nota de curadoria", !!st0.disclaimer && /valida..o jur/i.test(st0.note || ""));

  // ===== 2. advise sem base → honesto, nunca inventa =====
  const a0 = LaborLawAdvisorService.advise("como calcular verbas rescisórias na demissão sem justa causa?", { orgId: org });
  check("advise sem base → grounded false + awaitingCuration", a0.grounded === false && a0.awaitingCuration === true);
  check("advise sem base → mensagem 'validação jurídica'", /valida..o jur/i.test(a0.orientacao));
  check("advise sem base → sem citações + disclaimer presente", Array.isArray(a0.citations) && a0.citations.length === 0 && !!a0.disclaimer);

  // ===== 3. curate: guardrails =====
  let noReviewer = false;
  try { LaborLawAdvisorService.curate({ topic: "rescisao", title: "Verbas na demissão sem justa causa", guidance: "…", reviewedBy: "" }, "master"); }
  catch { noReviewer = true; }
  check("curate sem reviewedBy é rejeitado (RN-178-003)", noReviewer);

  let badTopic = false;
  try { LaborLawAdvisorService.curate({ topic: "inexistente", title: "X", guidance: "Y", reviewedBy: "Dra. Ana (OAB 123)" }, "master"); }
  catch { badTopic = true; }
  check("curate com topic inválido é rejeitado", badTopic);

  // ===== 4. curate válido → advise GROUNDA =====
  const cur = LaborLawAdvisorService.curate({
    topic: "rescisao",
    title: "Verbas na demissão sem justa causa",
    guidance: "Na demissão sem justa causa são devidos: saldo de salário, aviso prévio, férias proporcionais + 1/3, 13º proporcional, saque do FGTS e multa de 40%.",
    reviewedBy: "Dra. Ana Trabalhista (OAB/MG 123456)",
    citations: [{ norma: "CLT art. 477" }, { norma: "Lei 8.036/90 (FGTS)" }],
    terms: ["verbas rescis", "demissao sem justa causa", "rescisao", "multa 40", "aviso previo"],
    source: "curadoria interna 2026-08",
  }, "master");
  check("curate válido retorna id + reviewedBy", !!cur.id && cur.reviewedBy.includes("OAB"));

  const st1 = LaborLawAdvisorService.status();
  check("status: base agora curada (1 entrada; tema rescisao=1)", st1.curated === true && st1.entriesCount === 1 && st1.topics.find((t: any) => t.key === "rescisao").entries === 1);

  const a1 = LaborLawAdvisorService.advise("quais as verbas rescisórias de uma demissão sem justa causa?", { orgId: org });
  check("advise agora GROUNDA na entrada curada", a1.grounded === true && a1.awaitingCuration === false && /FGTS/.test(a1.orientacao));
  check("advise grounded traz reviewedBy + citações", a1.reviewedBy.includes("OAB") && a1.citations.length === 2);
  check("advise grounded mantém disclaimer", !!a1.disclaimer);

  // ===== 5. pergunta sem match → volta ao honesto (não força) =====
  const a2 = LaborLawAdvisorService.advise("posso vender bebida alcoólica para menor?", { orgId: org });
  check("pergunta fora do tema → não força a entrada (honesto)", a2.grounded === false && Array.isArray(a2.citations) && a2.citations.length === 0);

  console.log("\n=== TEST: LEGAL — orientação trabalhista (scaffold honesto, ADR-178) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
