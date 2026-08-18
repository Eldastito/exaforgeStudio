/**
 * TEST — Base de ajuda do usuário + recuperação grounded (ADR-179 F1).
 * DB-backed, determinístico, isolado por org. Prova (RN-HELP-1/2/3/5/6/7/8):
 *   - seed idempotente da base curada (módulos mais usados);
 *   - retrieve casa a pergunta com o artigo certo (sobreposição de termos);
 *   - answer grounded: mensagem cita o artigo (fonte) + passo a passo;
 *   - sem cobertura → NÃO inventa (found=false) E registra a lacuna (help_gap_log);
 *   - só artigo PUBLICADO com reviewed_by é recuperável (rascunho não);
 *   - recorte por vertical (artigo de saúde não vaza p/ varejo);
 *   - ZeroTrainingHelpService.answer expõe `article` quando coberto e mantém
 *     0-regressão (unknown continua unknown; gap logado);
 *   - isolamento multi-tenant do gap log.
 *
 * Uso: npm run test:help-knowledge
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-kb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-kb-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");
  const { ZeroTrainingHelpService: HELP } = await import("../src/server/ZeroTrainingHelpService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;   // varejo
  const B = `org_${randomUUID().slice(0, 8)}`;   // saúde (clínica)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'Loja A', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'Clínica B', 'active', 'saude', 'autonomo', 'active')`).run(randomUUID(), B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const ownerA = { userId: "u1", email: "a@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };
  const ownerB = { userId: "u2", email: "b@x.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };

  // ═══════════════ 1. seed idempotente ═══════════════
  KB.ensureSeeded(); KB.ensureSeeded(); // 2ª vez não duplica
  const total = (db.prepare(`SELECT COUNT(*) c FROM help_articles WHERE status='published'`).get() as any).c;
  check("1.1 seed publicou artigos", total >= 5);
  const dup = (db.prepare(`SELECT COUNT(*) c FROM help_articles WHERE id='help_seed_diretor'`).get() as any).c;
  check("1.2 seed idempotente (sem duplicar por id)", dup === 1);
  const allReviewed = (db.prepare(`SELECT COUNT(*) c FROM help_articles WHERE status='published' AND (reviewed_by IS NULL OR reviewed_by='')`).get() as any).c;
  check("1.3 todo artigo publicado tem reviewed_by (RN-HELP-3)", allReviewed === 0);

  // ═══════════════ 2. retrieve casa a pergunta ═══════════════
  const rDiretor = KB.retrieve(A, "o que é o diretor executivo ia?");
  check("2.1 retrieve acha o artigo do Diretor IA", !!rDiretor && rDiretor!.id === "help_seed_diretor");
  const rEstoque = KB.retrieve(A, "como faço a reposição de estoque quando falta produto?");
  check("2.2 retrieve acha o artigo de Estoque/Compras", !!rEstoque && rEstoque!.id === "help_seed_estoque");
  const rNada = KB.retrieve(A, "xpto zzz nada disso existe");
  check("2.3 sem sobreposição → null (não força match fraco)", rNada === null);

  // ═══════════════ 3. answer grounded + citação ═══════════════
  const ans = KB.answer(A, "como funciona a central de saúde e o resumo no whatsapp?");
  check("3.1 answer grounded: found + article", ans.found === true && !!ans.article && ans.article!.id === "help_seed_central_saude");
  check("3.2 mensagem cita a fonte (RN-HELP-2)", !!ans.message && /fonte:/i.test(ans.message!));
  check("3.3 mensagem traz passo a passo", !!ans.message && /passo a passo/i.test(ans.message!));

  // ═══════════════ 4. sem cobertura → honesto + gap registrado ═══════════════
  const miss = KB.answer(A, "como emito nota fiscal eletronica pelo sistema?");
  check("4.1 sem cobertura → found=false, sem inventar (RN-HELP-1)", miss.found === false && miss.article === null && miss.message === null);
  const gap = db.prepare(`SELECT hits FROM help_gap_log WHERE organization_id=? AND query_norm LIKE '%nota%'`).get(A) as any;
  check("4.2 lacuna registrada no help_gap_log", !!gap && gap.hits >= 1);
  KB.answer(A, "como emito nota fiscal eletronica pelo sistema?"); // repete → incrementa
  const gap2 = db.prepare(`SELECT hits FROM help_gap_log WHERE organization_id=? AND query_norm LIKE '%nota%'`).get(A) as any;
  check("4.3 lacuna repetida incrementa hits (upsert)", !!gap2 && gap2.hits >= 2);

  // ═══════════════ 5. curadoria: rascunho não é recuperável ═══════════════
  db.prepare(`INSERT INTO help_articles (id, vertical, module_key, title, what, purpose, steps_json, common_errors_json, keywords, reviewed_by, status) VALUES (?, NULL, 'vendas', 'Rascunho secreto', 'x', 'y', '[]', '[]', 'giroflex unicornio magico', 'ninguem', 'draft')`).run(randomUUID());
  const rDraft = KB.retrieve(A, "giroflex unicornio magico");
  check("5.1 artigo em rascunho (draft) NÃO é recuperável (RN-HELP-3)", rDraft === null);

  // ═══════════════ 6. recorte por vertical ═══════════════
  const clinVarejo = KB.retrieve(A, "como dou alta do paciente com pin na clinica?");
  check("6.1 artigo de saúde NÃO vaza p/ org de varejo", clinVarejo === null);
  const clinSaude = KB.retrieve(B, "como dou alta do paciente com pin na clinica?");
  check("6.2 artigo de saúde recuperável na org de saúde", !!clinSaude && clinSaude!.id === "help_seed_clinica");
  const globalNaSaude = KB.retrieve(B, "o que é o diretor executivo ia?");
  check("6.3 artigo GLOBAL recuperável em qualquer vertical", !!globalNaSaude && globalNaSaude!.id === "help_seed_diretor");

  // ═══════════════ 7. integração com ZeroTrainingHelpService ═══════════════
  const zt = HELP.answer(A, ownerA, { text: "como funciona a central de saúde?" });
  check("7.1 ZeroTrainingHelp expõe article quando coberto", !!zt.article && zt.article!.id === "help_seed_central_saude");
  check("7.2 mensagem enriquecida cita a fonte", /fonte:/i.test(zt.message));
  const ztUnk = HELP.answer(A, ownerA, { text: "asdf qwer zxcv" });
  check("7.3 0-regressão: pergunta obscura segue unknown", ztUnk.intent === "unknown" && ztUnk.article === null && ztUnk.gapLogged === true);

  // ═══════════════ 8. isolamento multi-tenant do gap ═══════════════
  const gapB = db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=? AND query_norm LIKE '%nota%'`).get(B) as any;
  check("8.1 gap de A não aparece em B (isolamento)", gapB.c === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-knowledge: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
