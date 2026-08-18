/**
 * TEST — Treinamento além do Q&A (ADR-179 F5): tour + mídia curada + "aprenda 1 coisa".
 * DB-backed, determinístico, isolado. Prova (RN-HELP-3/5, conv. nº 12):
 *   - tour(module) deriva os passos do artigo PUBLICADO do módulo (não inventa);
 *     null sem artigo/sem passos; rascunho não vira tour;
 *   - mídia curada opcional (media_url) trafega via upsert → suggestions/tour/answer;
 *   - learnOne pega o PRÓXIMO artigo publicado ainda não dado como dica;
 *   - publishLearnOne publica no business_signals (dedupe help_learn:<id>),
 *     idempotente; avança pro próximo; gate semanal (not_due); sem conteúdo → no_content;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:help-training
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-train-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-train-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'A', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'B', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), B);

  // ═══════════════ 1. tour deriva do artigo publicado do módulo ═══════════════
  const tVendas = KB.tour(A, "vendas");
  check("1.1 tour do módulo tem passos do artigo publicado", !!tVendas && tVendas!.steps.length > 0 && tVendas!.articleId === "help_seed_vendas");
  check("1.2 tour de módulo sem artigo → null", KB.tour(A, "modulo_inexistente") === null);
  check("1.3 tour sem módulo → null", KB.tour(A, null) === null);
  // Rascunho não vira tour.
  const d = KB.upsert({ moduleKey: "reservas", title: "Reservas", steps: ["passo a", "passo b"], keywords: "reservas" }, "m1");
  check("1.4 rascunho NÃO vira tour (só publicado)", KB.tour(A, "reservas") === null);
  KB.publish(d.id, "Curador", "m1");
  check("1.5 após publicar, o tour aparece", KB.tour(A, "reservas")?.articleId === d.id);

  // ═══════════════ 2. mídia curada opcional ═══════════════
  KB.upsert({ id: d.id, mediaUrl: "https://cdn.exemplo/reservas.gif" }, "m1");
  check("2.1 media_url trafega no tour", KB.tour(A, "reservas")?.mediaUrl === "https://cdn.exemplo/reservas.gif");
  const sug = KB.suggestions(A, "reservas", { limit: 5 }).find((s) => s.id === d.id);
  check("2.2 media_url trafega nas sugestões", sug?.mediaUrl === "https://cdn.exemplo/reservas.gif");
  KB.upsert({ id: d.id, mediaUrl: null }, "m1");
  check("2.3 salvar mídia em branco REMOVE (null)", KB.tour(A, "reservas")?.mediaUrl === null);

  // ═══════════════ 3. aprenda 1 coisa ═══════════════
  const t1 = KB.learnOne(A);
  check("3.1 learnOne devolve um artigo publicado", !!t1 && !!t1!.articleId);
  const p1 = await KB.publishLearnOne(A, { force: true });
  check("3.2 publishLearnOne publica (force)", p1.published === true && p1.articleId === t1!.articleId);
  const sig = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='help' AND signal_type='learn_one' AND dedupe_key=?`).get(A, `help_learn:${t1!.articleId}`) as any;
  check("3.3 dica publicada no business_signals (dedupe help_learn:<id>)", sig.c === 1);
  const p1b = await KB.publishLearnOne(A, { force: true });
  check("3.4 idempotente/avança: NÃO repete o mesmo artigo", p1b.published === true && p1b.articleId !== t1!.articleId);
  const noDup = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `help_learn:${t1!.articleId}`) as any;
  check("3.5 sem duplicar a linha do 1º artigo", noDup.c === 1);

  // ═══════════════ 4. gate semanal + esgotamento ═══════════════
  const notDue = await KB.publishLearnOne(A); // sem force → gate 7 dias
  check("4.1 gate semanal: not_due logo após publicar", notDue.published === false && notDue.reason === "not_due");
  // Esgota o conteúdo publicável de A (força até acabar).
  let guard = 0; let last = await KB.publishLearnOne(A, { force: true });
  while (last.published && guard++ < 50) last = await KB.publishLearnOne(A, { force: true });
  check("4.2 sem conteúdo novo → no_content (não inventa)", last.published === false && last.reason === "no_content");

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  const bTip = KB.learnOne(B);
  check("5.1 B tem sua própria fila de dicas (nada de A)", !!bTip);
  const bSigs = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND domain='help'`).get(B) as any;
  check("5.2 sinais de A não vazam p/ B", bSigs.c === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-training: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
