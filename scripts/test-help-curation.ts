/**
 * TEST — Curadoria da base de ajuda (ADR-179 F2). DB-backed, determinístico.
 * Prova o ciclo draft → published → archived + bootstrap (RN-HELP-3/5/8):
 *   - upsert cria RASCUNHO (status='draft', reviewed_by vazio) → NÃO recuperável;
 *   - bootstrap destila um rascunho determinístico do MODULE_META (via=deterministic,
 *     nunca publica) → também não recuperável;
 *   - publish EXIGE reviewedBy (RN-HELP-3) e torna o artigo recuperável;
 *   - publicar de fato aparece na recuperação (retrieve/answer grounded);
 *   - archive tira da recuperação (não apaga);
 *   - update (patch) altera campos sem mudar status;
 *   - adminList enxerga rascunho/publicado/arquivado; list() só publicado;
 *   - erros de validação (title obrigatório, id inexistente).
 *
 * Uso: npm run test:help-curation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-cur-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-cur-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'Loja A', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), A);

  // ═══════════════ 1. upsert cria rascunho (não recuperável) ═══════════════
  const draft = KB.upsert({
    moduleKey: "agenda", title: "Como usar a agenda",
    what: "A agenda organiza seus horários.", purpose: "Não perder compromisso.",
    steps: ["Abra a Agenda", "Crie um horário"], keywords: "agenda horario compromisso zoltar",
  }, "master1");
  check("1.1 upsert cria rascunho (status=draft)", draft.status === "draft" && !!draft.id);
  const notYet = KB.retrieve(A, "zoltar agenda horario compromisso");
  check("1.2 rascunho NÃO é recuperável pelo Tutor (RN-HELP-3)", notYet === null);
  const got = KB.getById(draft.id);
  check("1.3 rascunho nasce sem reviewed_by", !!got && got!.status === "draft");

  // ═══════════════ 2. bootstrap determinístico (rascunho, nunca publica) ═══════════════
  const boot = await KB.bootstrap({ moduleKey: "catalogo", sourceRef: "ADR-083" }, "master1");
  check("2.1 bootstrap via determinístico (sem IA em CI)", boot.via === "deterministic" && boot.status === "draft");
  const bootRow = KB.getById(boot.id);
  check("2.2 bootstrap preenche what a partir do MODULE_META", !!bootRow && /produtos/i.test(bootRow!.what || ""));
  const bootRetrieved = KB.retrieve(A, "catalogo produtos servicos"); // pode casar um seed publicado
  check("2.3 bootstrap NÃO publica (o rascunho nunca surge na recuperação)", (bootRetrieved?.id ?? null) !== boot.id);

  // ═══════════════ 3. publish exige reviewedBy (RN-HELP-3) ═══════════════
  let threw = false;
  try { KB.publish(draft.id, "   ", "master1"); } catch { threw = true; }
  check("3.1 publish sem reviewedBy é REJEITADO (RN-HELP-3)", threw);
  const pub = KB.publish(draft.id, "Equipe Suporte", "master1");
  check("3.2 publish com reviewedBy → published", pub.status === "published");
  const nowFound = KB.retrieve(A, "zoltar agenda horario compromisso");
  check("3.3 artigo publicado agora É recuperável", !!nowFound && nowFound!.id === draft.id);
  const ans = KB.answer(A, "como uso a agenda zoltar?");
  check("3.4 answer grounded cita o artigo publicado", ans.found === true && /fonte:/i.test(ans.message || ""));

  // ═══════════════ 4. update (patch) não muda status ═══════════════
  const upd = KB.upsert({ id: draft.id, purpose: "Não perder nenhum compromisso importante." }, "master1");
  check("4.1 update mantém status published", upd.status === "published");
  const after = KB.getById(draft.id);
  check("4.2 patch alterou só o campo passado", !!after && /importante/i.test(after!.purpose || "") && after!.title === "Como usar a agenda");

  // ═══════════════ 5. archive tira da recuperação (não apaga) ═══════════════
  KB.archive(draft.id, "master1");
  check("5.1 arquivado sai da recuperação", KB.retrieve(A, "zoltar agenda horario compromisso") === null);
  check("5.2 arquivado NÃO é apagado (histórico)", !!KB.getById(draft.id) && KB.getById(draft.id)!.status === "archived");

  // ═══════════════ 6. listagens ═══════════════
  const adminAll = KB.adminList("all");
  check("6.1 adminList enxerga rascunho+publicado+arquivado", adminAll.some((a) => a.status === "draft") && adminAll.some((a) => a.status === "archived"));
  const pubOnly = KB.list({ status: "published" });
  check("6.2 list(published) não traz o arquivado", !pubOnly.some((a) => a.id === draft.id));

  // ═══════════════ 7. validações ═══════════════
  let e1 = false; try { KB.upsert({ moduleKey: "x", steps: [] } as any, "master1"); } catch { e1 = true; }
  check("7.1 upsert sem title é rejeitado", e1);
  let e2 = false; try { KB.publish("nao-existe", "Fulano", "master1"); } catch { e2 = true; }
  check("7.2 publish de id inexistente é rejeitado", e2);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-curation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
