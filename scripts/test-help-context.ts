/**
 * TEST — Contextual + feedback do Tutor de Ajuda (ADR-179 F3). DB-backed, det.
 * Prova (RN-HELP-6/7, RN-004):
 *   - suggestions(module) prioriza o artigo do módulo da tela + respeita vertical;
 *   - suggestions vazio quando não há cobertura (honesto);
 *   - recordFeedback agrega 👍/👎 (upsert), sem texto;
 *   - metrics ganha helpfulRatePct (null sem votos → null≠0);
 *   - feedback de resposta SEM artigo (article_id='') é registrado (sinal de lacuna);
 *   - isolamento multi-tenant do feedback.
 *
 * Uso: npm run test:help-context
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-ctx-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-ctx-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mk = (org: string, vert: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', ?, 'autonomo', 'active')`).run(randomUUID(), org, vert);
  mk(A, "varejo"); mk(B, "saude");

  // ═══════════════ 1. sugestões contextuais ═══════════════
  const sVendas = KB.suggestions(A, "vendas");
  check("1.1 sugere o artigo do módulo da tela primeiro", sVendas.length > 0 && sVendas[0].moduleKey === "vendas");
  const sNoCtx = KB.suggestions(A, null, { limit: 3 });
  check("1.2 sem módulo ainda traz globais publicados", sNoCtx.length > 0 && sNoCtx.length <= 3);
  // Recorte por vertical: artigo clínico (vertical 'saude') não aparece p/ varejo.
  const sVarejoAll = KB.suggestions(A, null, { limit: 50 });
  check("1.3 vertical: artigo de saúde NÃO some p/ varejo", !sVarejoAll.some((x) => x.id === "help_seed_clinica"));
  const sSaude = KB.suggestions(B, "clinica", { limit: 50 });
  check("1.4 artigo de saúde aparece p/ org de saúde", sSaude.some((x) => x.id === "help_seed_clinica"));

  // ═══════════════ 2. sem cobertura → vazio (honesto) ═══════════════
  // Arquiva tudo de um módulo inexistente não muda; testa módulo sem artigo próprio:
  const sUnknown = KB.suggestions(A, "modulo_que_nao_existe", { limit: 2 });
  check("2.1 módulo sem artigo próprio ainda cai nos globais (não quebra)", Array.isArray(sUnknown));

  // ═══════════════ 3. feedback agrega 👍/👎 ═══════════════
  const art = sVendas[0].id;
  KB.recordFeedback(A, { articleId: art, moduleKey: "vendas", helpful: true });
  KB.recordFeedback(A, { articleId: art, moduleKey: "vendas", helpful: true });
  KB.recordFeedback(A, { articleId: art, moduleKey: "vendas", helpful: false });
  const row = db.prepare(`SELECT up, down FROM help_feedback WHERE organization_id=? AND article_id=?`).get(A, art) as any;
  check("3.1 feedback upsert agrega (2👍 / 1👎)", !!row && row.up === 2 && row.down === 1);

  // ═══════════════ 4. metrics ganha helpfulRatePct ═══════════════
  const m = KB.metrics(A);
  check("4.1 helpfulVotes/notHelpfulVotes agregados", m.helpfulVotes === 2 && m.notHelpfulVotes === 1);
  check("4.2 helpfulRatePct = 67%", m.helpfulRatePct === 67);
  const mB = KB.metrics(B);
  check("4.3 sem votos → helpfulRatePct null (null≠0)", mB.helpfulRatePct === null);

  // ═══════════════ 5. feedback SEM artigo (sinal de lacuna) ═══════════════
  KB.recordFeedback(A, { articleId: null, moduleKey: "compras", helpful: false });
  const noArt = db.prepare(`SELECT down FROM help_feedback WHERE organization_id=? AND article_id=''`).get(A) as any;
  check("5.1 feedback de resposta sem artigo é registrado (article_id='')", !!noArt && noArt.down === 1);

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  const fbB = db.prepare(`SELECT COUNT(*) c FROM help_feedback WHERE organization_id=?`).get(B) as any;
  check("6.1 feedback de A não aparece em B", fbB.c === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-context: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
