/**
 * TEST — IDO / Índice de Dependência Operacional (OperationalDependencyService, PRD 04).
 * Prova o score determinístico (0-100, maior = mais dependente), confiança, faixa honesta,
 * recomendações, snapshot append-only + comparação antes→hoje→meta, e isolamento por org.
 *
 * Uso: npm run test:operational-dependency
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ido-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ido-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { OperationalDependencyService: IDO, IDO_QUESTIONS, IDO_DIMENSIONS } = await import("../src/server/OperationalDependencyService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'Acme', 'active')`).run(o);
    return o;
  };
  const allAnswers = (v: number) => Object.fromEntries(IDO_QUESTIONS.map((q: any) => [q.id, v]));

  // ── 1. Fórmula: pesos somam 100; questionário versionado ──
  check("1.1 pesos das dimensões somam 100", IDO_DIMENSIONS.reduce((s: number, d: any) => s + d.weight, 0) === 100);
  const q = IDO.questionnaire();
  check("1.2 questionário traz dimensões + perguntas + escala 0-4", q.dimensions.length === 9 && q.questions.length >= 12 && q.scale.max === 4);

  // ── 2. Cálculo determinístico + polaridade (maior = mais dependente) ──
  const low = IDO.compute(allAnswers(0));   // tudo "discordo" → baixa dependência
  const high = IDO.compute(allAnswers(4));  // tudo "concordo totalmente" → dependência máxima
  const mid = IDO.compute(allAnswers(2));   // neutro → 50
  check("2.1 tudo 0 → IDO 0 (baixa dependência)", low.ido === 0 && low.faixa === "saudavel");
  check("2.2 tudo 4 → IDO 100 (dependência crítica)", high.ido === 100 && high.faixa === "critico");
  check("2.3 tudo 2 → IDO 50 (alto)", mid.ido === 50 && mid.faixa === "alto");
  check("2.4 confiança alta com tudo respondido", high.confidence === "alta");

  // ── 3. Honestidade: sem resposta → null (não inventa) ──
  const empty = IDO.compute({});
  check("3.1 sem resposta → ido null + faixa indefinido", empty.ido === null && empty.faixa === "indefinido");
  check("3.2 sem resposta → confiança baixa", empty.confidence === "baixa");
  // parcial: só 1 pergunta respondida → confiança baixa, ido não-null
  const partial = IDO.compute({ owner_1: 4 });
  check("3.3 parcial → ido não-null, confiança baixa", partial.ido !== null && partial.confidence === "baixa");

  // ── 4. Recomendações: só dimensões que doem (>=50), mais dependentes primeiro ──
  check("4.1 tudo 4 → recomendações (top 3)", high.recommendations.length === 3 && high.recommendations.every((r: any) => r.text));
  check("4.2 tudo 0 → sem recomendações (nada dói)", low.recommendations.length === 0);
  // dimensão mais pesada dependente aparece
  const mixed = IDO.compute({ ...allAnswers(0), owner_1: 4, owner_2: 4 });
  check("4.3 recomendação prioriza a dimensão dependente (owner)", mixed.recommendations[0]?.dimension === "owner");

  // ── 5. Snapshot append-only + latest + histórico ──
  const A = mkOrg();
  const s1 = IDO.submit(A, allAnswers(3), "dono@acme");   // IDO 75
  check("5.1 submit persiste e devolve id + score", !!s1.id && s1.ido === 75);
  const s2 = IDO.submit(A, allAnswers(1), "dono@acme");   // IDO 25 (melhorou)
  check("5.2 latest = último assessment (25)", IDO.latest(A).ido === 25);
  check("5.3 histórico tem 2 (append-only)", IDO.history(A).length === 2);

  // ── 6. Meta + comparação antes→hoje→meta ──
  check("6.1 meta começa null (não inventa)", IDO.getTarget(A) === null);
  IDO.setTarget(A, 20);
  check("6.2 meta setada = 20", IDO.getTarget(A) === 20);
  let metaErr = false; try { IDO.setTarget(A, 150); } catch { metaErr = true; }
  check("6.3 meta fora de 0-100 rejeitada", metaErr);
  const cmp = IDO.comparison(A);
  check("6.4 comparação: antes 75, hoje 25, meta 20", cmp.before === 75 && cmp.current === 25 && cmp.target === 20);
  check("6.5 delta = queda de dependência (75-25=50, positivo=melhorou)", cmp.delta === 50 && cmp.assessments === 2);

  // ── 7. Isolamento multi-tenant ──
  const B = mkOrg();
  check("7.1 org B não vê assessments de A", IDO.latest(B) === null && IDO.history(B).length === 0);
  check("7.2 meta isolada por org", IDO.getTarget(B) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} operational-dependency: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
