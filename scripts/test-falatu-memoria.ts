/**
 * TEST — FalaTu Fatia 5 (ADR-151): memória com desambiguação ativa + briefing
 * diário proativo em business_signals (ADR-136).
 *
 * Guardrails RN-151 §F5 cobertos:
 * - Matching de menção é regra de CÓDIGO (0=new, 1=known auto-vínculo
 *   determinístico, 2+=ambiguous) — nunca a IA escolhe.
 * - Menção ambígua SEM resolução humana não vincula nem cria entidade na
 *   confirmação (memória não é poluída por palpite).
 * - resolveMention valida a escolha contra os candidatos sugeridos (cliente
 *   não injeta vínculo) e é isolado por org+user.
 * - WhatsApp pergunta "qual Carlos?" e "é N" só é interceptado com pendência
 *   ambígua derivada do banco.
 * - Briefing: 1 sinal por (usuário, dia), idempotente por dedupe_key, fecha
 *   sozinho quando deixa de valer; sweep do Scheduler respeita a flag da org
 *   (com bypass da org do operador); o sweep NUNCA materializa nada.
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu-memoria
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-mem-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-memoria-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@zapflow.test";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService, parseFalaTuMemory } = await import("../src/server/FalaTuService.js");
  const { FalaTuWhatsAppService } = await import("../src/server/FalaTuWhatsAppService.js");
  const { FalaTuBriefingTaskService } = await import("../src/server/FalaTuBriefingTaskService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);

  const OWNER_PHONE = "5511999998888";
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dona A', 'dona@a.test', ?, 'owner', 'active')`).run(userA, orgA, OWNER_PHONE);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dono B', 'dono@b.test', '5521955554444', 'owner', 'active')`).run(userB, orgB);

  // Mock da extração: devolve como "pessoa citada" o que vier depois de "com "
  // (sem \b após acento — \b é ASCII em JS e falharia depois de "amanhã").
  (FalaTuService as any).interpret = async (input: any) => {
    const text = String(input.text || "");
    const m = text.match(/com (.+)$/);
    const person = m ? m[1].replace(/\s+(?:sobre|amanh[ãa]|hoje)(?:\s.*)?$/i, "").trim() : "";
    const people = person ? [person] : [];
    return {
      transcription: text, summary: text.slice(0, 60), intent: "TASK",
      entities: { people, projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
      confidence: 0.9, suggestedAction: "sugestão",
    };
  };

  const entityRows = (org: string, user: string) => db.prepare(`SELECT * FROM falatu_entities WHERE organization_id = ? AND user_id = ? ORDER BY name`).all(org, user) as any[];
  const auditCount = (type: string) => (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgA, type) as any).c;
  const mentionsOf = (item: any) => parseFalaTuMemory(item.memory_json)?.mentions || [];

  // ===== 1. Menção inédita → 'new'; confirmação cria a entidade =====
  const cap1 = await FalaTuService.capture(orgA, userA, { text: "ligar com Carlos Silva sobre a obra" });
  const men1 = mentionsOf(cap1);
  check("menção inédita vira 'new' sem candidatos", men1.length === 1 && men1[0].status === "new" && men1[0].candidates.length === 0);
  FalaTuService.confirm(orgA, userA, cap1.id, {});
  check("confirm de 'new' cria a entidade", entityRows(orgA, userA).some((e) => e.name === "Carlos Silva"));

  // ===== 2. Match ÚNICO por prefixo → 'known' auto-vinculado =====
  const cap2 = await FalaTuService.capture(orgA, userA, { text: "reunião com Carlos amanhã" });
  const men2 = mentionsOf(cap2);
  const carlosSilvaId = entityRows(orgA, userA).find((e) => e.name === "Carlos Silva")?.id;
  check("match único (prefixo) vira 'known' auto-vinculado", men2[0]?.status === "known" && men2[0]?.resolvedEntityId === carlosSilvaId);
  const before2 = entityRows(orgA, userA).length;
  FalaTuService.confirm(orgA, userA, cap2.id, {});
  const silvaRow = entityRows(orgA, userA).find((e) => e.id === carlosSilvaId);
  check("confirm de 'known' atualiza contexto SEM criar duplicata 'carlos'", entityRows(orgA, userA).length === before2 && /reunião com Carlos/.test(silvaRow?.context || ""));

  // ===== 3. Segundo Carlos na memória → menção "Carlos" fica AMBÍGUA =====
  const capM = await FalaTuService.capture(orgA, userA, { text: "almoço com Carlos Mendes" });
  FalaTuService.confirm(orgA, userA, capM.id, {});
  const cap3 = await FalaTuService.capture(orgA, userA, { text: "cobrar orçamento com Carlos" });
  const men3 = mentionsOf(cap3);
  check("2 candidatos viram 'ambiguous' SEM auto-vínculo", men3[0]?.status === "ambiguous" && men3[0]?.candidates.length === 2 && men3[0]?.resolvedEntityId === null && men3[0]?.resolvedNew === false);

  // ===== 4. Guardrail: escolha fora dos candidatos é recusada =====
  let threw = false;
  try { FalaTuService.resolveMention(orgA, userA, cap3.id, "Carlos", randomUUID()); } catch { threw = true; }
  check("entityId fora dos candidatos é recusado (cliente não injeta vínculo)", threw);

  // ===== 5. Isolamento: outro usuário não resolve menção alheia =====
  threw = false;
  try { FalaTuService.resolveMention(orgB, userB, cap3.id, "Carlos", men3[0].candidates[0].id); } catch { threw = true; }
  check("resolveMention isolado por org+user", threw);

  // ===== 6. Ambígua SEM resolução → confirm NÃO vincula nem cria =====
  const before6 = entityRows(orgA, userA);
  const ctxBefore6 = before6.map((e) => `${e.id}:${e.context}`).join("|");
  FalaTuService.confirm(orgA, userA, cap3.id, {});
  const after6 = entityRows(orgA, userA);
  check("ambígua sem escolha: nenhuma entidade criada nem tocada (nunca chuta)", after6.length === before6.length && after6.map((e) => `${e.id}:${e.context}`).join("|") === ctxBefore6 && !after6.some((e) => e.name === "Carlos"));

  // ===== 7. Resolução humana via resolveMention + confirm =====
  const cap7 = await FalaTuService.capture(orgA, userA, { text: "pagar com Carlos" });
  const mendesId = entityRows(orgA, userA).find((e) => e.name === "Carlos Mendes")?.id;
  FalaTuService.resolveMention(orgA, userA, cap7.id, "Carlos", mendesId!);
  check("auditoria FALATU_RESOLVE_MENTION", auditCount("FALATU_RESOLVE_MENTION") >= 1);
  const before7 = entityRows(orgA, userA).length;
  FalaTuService.confirm(orgA, userA, cap7.id, {});
  const mendesRow = entityRows(orgA, userA).find((e) => e.id === mendesId);
  check("escolha humana vincula o Carlos certo (contexto atualizado, sem linha nova)", entityRows(orgA, userA).length === before7 && /pagar com Carlos/.test(mendesRow?.context || ""));

  // ===== 8. mentionResolutions no confirm (um clique na UI) — "new" cria =====
  const cap8 = await FalaTuService.capture(orgA, userA, { text: "treinar com Carlos" });
  FalaTuService.confirm(orgA, userA, cap8.id, { mentionResolutions: { "Carlos": "new" } });
  check("'outro/novo' via confirm cria a entidade da menção", entityRows(orgA, userA).some((e) => e.name === "Carlos"));

  // ===== 9. WhatsApp: pergunta ativa "qual Carlos?" + "é N" =====
  // (agora há 3 Carlos na memória: Carlos, Carlos Mendes, Carlos Silva)
  const r9 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota visitar com Carlos");
  check("captura ambígua pergunta 'Qual Carlos?' com opções numeradas", r9.handled === true && /Qual \*Carlos\*\?/.test(r9.reply) && /1\)/.test(r9.reply) && /0\) outro\/novo/.test(r9.reply));
  const r9b = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "é 9");
  check("'é N' fora do intervalo repete a pergunta", r9b.handled === true && /Opção inválida/.test(r9b.reply));
  const r9c = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "é 2");
  check("'é 2' resolve a menção e orienta o confere", r9c.handled === true && /Anotado: \*Carlos\*/.test(r9c.reply) && /confere/.test(r9c.reply));
  const pend9 = FalaTuWhatsAppService.pendingItem(orgA, userA);
  const men9 = mentionsOf(pend9);
  check("resolução do WhatsApp persistida no item (derivada do banco)", men9[0]?.resolvedEntityId === men9[0]?.candidates[1]?.id);
  const r9d = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "confere");
  check("confere efetiva após desambiguação", r9d.handled === true && /Confere!/.test(r9d.reply));

  // ===== 10. "é N" sem pendência ambígua NÃO é interceptado =====
  const r10 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "é 1");
  check("'é 1' sem pergunta pendente cai no fluxo normal", r10.handled === false);

  // ===== 11. Briefing proativo: sinal por (usuário, dia), idempotente =====
  const today = new Date().toISOString().slice(0, 10);
  const capB = await FalaTuService.capture(orgA, userA, { text: "lembrar com Zeca" }); // pendência de inbox
  db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time) VALUES (?, ?, ?, 'Dentista', ?, '10:00')`).run(randomUUID(), orgA, userA, today);
  const tasksBefore = (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(orgA) as any).c;
  const run1 = FalaTuBriefingTaskService.run(orgA, { date: today });
  check("sweep publica 1 sinal pro usuário com dia acionável", run1.published === 1 && run1.deduped === 0);
  const sig = FalaTuBriefingTaskService.list(orgA, userA);
  check("sinal aberto com severidade attention (inbox pendente) e evidência derivada", sig.length === 1 && sig[0].severity === "attention" && sig[0].evidence.pendingInbox >= 1 && sig[0].evidence.todayEvents.some((e: any) => e.title === "Dentista"));
  const run2 = FalaTuBriefingTaskService.run(orgA, { date: today });
  const sigCount = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'falatu_daily_briefing'`).get(orgA) as any).c;
  check("re-run deduplica (1 linha só, RN de idempotência)", run2.published === 0 && run2.deduped === 1 && sigCount === 1);
  const tasksAfter = (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(orgA) as any).c;
  check("sweep NUNCA materializa nada (só sinaliza)", tasksBefore === tasksAfter);

  // ===== 12. Sinal fecha sozinho quando o dia deixa de valer =====
  FalaTuService.discard(orgA, userA, capB.id);
  db.prepare(`UPDATE falatu_events SET event_date = '2099-12-31' WHERE organization_id = ? AND title = 'Dentista'`).run(orgA);
  const run3 = FalaTuBriefingTaskService.run(orgA, { date: today });
  check("dia esvaziado → sinal resolvido (não ecoa briefing velho)", run3.resolved === 1 && FalaTuBriefingTaskService.list(orgA, userA).length === 0);

  // ===== 13. Isolamento multi-tenant do briefing =====
  await FalaTuService.capture(orgB, userB, { text: "pagar aluguel com Zeca" });
  FalaTuBriefingTaskService.run(orgB, { date: today });
  check("sinal da org B não vaza pra org A", FalaTuBriefingTaskService.list(orgA, userA).length === 0 && FalaTuBriefingTaskService.list(orgB, userB).length === 1);
  // list() por usuário: o colega da MESMA org não vê o briefing pessoal do outro.
  check("briefing é pessoal (colega não lista o do outro)", FalaTuBriefingTaskService.list(orgB, randomUUID()).length === 0);

  // ===== 14. Scheduler: flag da org gateia o sweep (com bypass do operador) =====
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  const userC = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org C', 'active')`).run(randomUUID(), orgC);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'User C', 'c@c.test', NULL, 'owner', 'active')`).run(userC, orgC);
  db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, completed) VALUES (?, ?, ?, 'tarefa', 0)`).run(randomUUID(), orgC, userC);
  db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date) VALUES (?, ?, ?, 'Evento hoje', ?)`).run(randomUUID(), orgC, userC, today);
  Scheduler.falatuBriefingPass();
  check("org sem flag fica fora do sweep do Scheduler", FalaTuBriefingTaskService.list(orgC, userC).length === 0);
  // Bypass: a org do operador da plataforma entra mesmo sem flag (mesmo racional do falatuGate).
  db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(process.env.MASTER_ADMIN_EMAIL, userC);
  Scheduler.falatuBriefingPass();
  check("org do operador entra no sweep sem flag (bypass do gate)", FalaTuBriefingTaskService.list(orgC, userC).length === 1);

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 5 (memória + briefing proativo) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
