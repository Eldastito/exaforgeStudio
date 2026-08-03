/**
 * TEST — FalaTu Fatia 1 (ADR-151): captura multimodal "Fala → Faz → Confere".
 *
 * Cobre os guardrails RN-151: nada materializa antes do confirm humano; data
 * de compromisso nunca é inventada (null quando a entrada não trouxe); itens
 * de lista vêm da extração ou do humano; confirm relê do banco (cliente não
 * forja dono); entidades deduplicam por nome normalizado; toggles validam
 * dono na query (anti-IDOR); isolamento multi-tenant; auditoria; retenção
 * (discard é UPDATE de status, nunca DELETE).
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userA2 = randomUUID(); // outro usuário da MESMA org (dados são por usuário)
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);

  // Mock da extração por IA (o resto do fluxo é real). Os cenários espelham o
  // contrato de FalaTuService.interpret — inclusive o RN de nunca inventar data.
  (FalaTuService as any).interpret = async (input: any) => {
    const text = input.text || (input.audio ? "áudio: ligar pro contador amanhã" : "") || (input.image ? "nota: arroz, feijão, café" : "");
    const base = { transcription: text, confidence: 0.9, suggestedAction: "sugestão" };
    if (/reunião.*sexta|10:30/.test(text)) {
      return { ...base, summary: "Reunião com a equipe", intent: "EVENT", entities: { people: ["Carlos"], projects: [], actions: [], listItems: [], eventDate: "2026-08-07", eventTime: "10:30" } };
    }
    if (/dentista/.test(text)) { // entrada SEM data explícita → extração devolve null (RN-151)
      return { ...base, summary: "Marcar dentista", intent: "EVENT", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null } };
    }
    if (/nota|mercado/.test(text)) {
      return { ...base, summary: "Compras do mercado", intent: "LIST", entities: { people: [], projects: [], actions: [], listItems: ["arroz", "feijão", "café"], eventDate: null, eventTime: null } };
    }
    if (/contador|fornecedor/.test(text)) {
      return { ...base, summary: "Ligar pro contador", intent: "TASK", entities: { people: ["carlos"], projects: ["Projeto Fiscal"], actions: ["ligar"], listItems: [], eventDate: null, eventTime: null } };
    }
    return { ...base, summary: text.slice(0, 40), intent: "UNKNOWN", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null } };
  };

  const taskCount = (org: string) => (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(org) as any).c;
  const auditCount = (type: string) => (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgA, type) as any).c;

  // ===== 1. Captura de texto → item PENDENTE, nada materializado =====
  const cap1 = await FalaTuService.capture(orgA, userA, { text: "ligar pro contador sobre o imposto" });
  check("captura cria item pendente", cap1?.status === "pending" && cap1?.intent === "TASK");
  check("transcrição/summary/confiança gravados", !!cap1.summary && cap1.confidence === 0.9);
  check("NADA criado antes do confirm (RN-151)", taskCount(orgA) === 0);
  check("auditoria FALATU_CAPTURE", auditCount("FALATU_CAPTURE") === 1);

  // ===== 2. Entrada vazia → recusa =====
  let threw = false;
  try { await FalaTuService.capture(orgA, userA, {}); } catch { threw = true; }
  check("captura vazia recusada", threw);

  // ===== 3. Confirm TASK → materializa com dono correto =====
  const conf1 = FalaTuService.confirm(orgA, userA, cap1.id, {});
  check("confirm cria tarefa", conf1.kind === "task" && taskCount(orgA) === 1);
  const t1 = db.prepare(`SELECT * FROM falatu_tasks WHERE id = ?`).get(conf1.refId) as any;
  check("tarefa chaveada por org + user", t1?.organization_id === orgA && t1?.user_id === userA);
  check("inbox vinculado ao que criou", conf1.item.status === "confirmed" && conf1.item.confirmed_ref_id === conf1.refId);
  check("auditoria FALATU_CONFIRM", auditCount("FALATU_CONFIRM") === 1);

  // ===== 4. Confirm duas vezes → recusa =====
  threw = false;
  try { FalaTuService.confirm(orgA, userA, cap1.id, {}); } catch { threw = true; }
  check("re-confirm recusado (já resolvido)", threw);

  // ===== 5. EVENT sem data na entrada → data NUNCA inventada =====
  const cap2 = await FalaTuService.capture(orgA, userA, { text: "preciso marcar dentista" });
  const conf2 = FalaTuService.confirm(orgA, userA, cap2.id, {});
  const ev2 = db.prepare(`SELECT * FROM falatu_events WHERE id = ?`).get(conf2.refId) as any;
  check("evento sem data fica NULL (não vira 'hoje')", conf2.kind === "event" && ev2?.event_date === null && ev2?.event_time === null);

  // ===== 6. EVENT com data explícita + override humano =====
  const cap3 = await FalaTuService.capture(orgA, userA, { text: "reunião com Carlos sexta 10:30" });
  const ents3 = JSON.parse(cap3.entities_json);
  check("extração trouxe data explícita", ents3.eventDate === "2026-08-07" && ents3.eventTime === "10:30");
  const conf3 = FalaTuService.confirm(orgA, userA, cap3.id, { eventDate: "2026-08-14", eventTime: "15:00" });
  const ev3 = db.prepare(`SELECT * FROM falatu_events WHERE id = ?`).get(conf3.refId) as any;
  check("humano sobrepõe data/hora na confirmação", ev3?.event_date === "2026-08-14" && ev3?.event_time === "15:00");

  // ===== 7. LIST via imagem (nota) → itens SÓ da extração =====
  const cap4 = await FalaTuService.capture(orgA, userA, { image: { mimeType: "image/jpeg", data: "Zm9vYmFy" } });
  check("captura de imagem registra media_type", cap4.media_type === "image" && cap4.intent === "LIST");
  const conf4 = FalaTuService.confirm(orgA, userA, cap4.id, {});
  const items4 = FalaTuService.listItems(orgA, userA, conf4.refId!);
  check("lista com itens da extração", conf4.kind === "list" && items4.length === 3 && items4.map((i: any) => i.name).join(",") === "arroz,feijão,café");

  // ===== 8. Humano edita itens na confirmação (override explícito) =====
  const cap5 = await FalaTuService.capture(orgA, userA, { text: "lista do mercado" });
  const conf5 = FalaTuService.confirm(orgA, userA, cap5.id, { listItems: ["banana", "leite"], listType: "shopping" });
  const items5 = FalaTuService.listItems(orgA, userA, conf5.refId!);
  check("itens do humano substituem os da IA", items5.length === 2 && items5[0].name === "banana");
  const l5 = db.prepare(`SELECT list_type FROM falatu_lists WHERE id = ?`).get(conf5.refId) as any;
  check("tipo da lista respeitado", l5?.list_type === "shopping");

  // ===== 9. Toggle de item valida dono na query (anti-IDOR da origem) =====
  const toggled = FalaTuService.toggleListItem(orgA, userA, items5[0].id, true);
  check("dono alterna item", (toggled as any).realized === 1);
  threw = false;
  try { FalaTuService.toggleListItem(orgA, userA2, items5[0].id, false); } catch { threw = true; }
  check("outro usuário NÃO alterna item alheio", threw && (db.prepare(`SELECT realized FROM falatu_list_items WHERE id = ?`).get(items5[0].id) as any).realized === 1);
  threw = false;
  try { FalaTuService.toggleTask(orgB, userB, t1.id, true); } catch { threw = true; }
  check("outra org NÃO alterna tarefa alheia", threw);

  // ===== 10. Entidades deduplicadas por nome normalizado =====
  const entsA = FalaTuService.entities(orgA, userA);
  const carlos = entsA.filter((e: any) => e.entity_type === "PERSON" && e.name_norm === "carlos");
  check("'Carlos' + 'carlos' → 1 entidade (upsert)", carlos.length === 1);
  check("projeto citado vira entidade", entsA.some((e: any) => e.entity_type === "PROJECT" && e.name === "Projeto Fiscal"));

  // ===== 11. Discard = UPDATE de status (nunca DELETE) =====
  const cap6 = await FalaTuService.capture(orgA, userA, { text: "qualquer coisa" });
  FalaTuService.discard(orgA, userA, cap6.id);
  const disc = db.prepare(`SELECT status FROM falatu_inbox_items WHERE id = ?`).get(cap6.id) as any;
  check("descartado preservado no banco", disc?.status === "discarded");
  threw = false;
  try { FalaTuService.discard(orgA, userA, cap6.id); } catch { threw = true; }
  check("re-discard recusado", threw);
  check("auditoria FALATU_DISCARD", auditCount("FALATU_DISCARD") === 1);

  // ===== 12. Isolamento multi-tenant e por usuário =====
  await FalaTuService.capture(orgB, userB, { text: "tarefa da org B: fornecedor" });
  check("org B não vê inbox da org A", FalaTuService.listInbox(orgB, userB).length === 1);
  check("org B não vê tarefas da org A", FalaTuService.tasks(orgB, userB).length === 0);
  check("userA2 (mesma org) não vê dados do userA", FalaTuService.tasks(orgA, userA2).length === 0 && FalaTuService.listInbox(orgA, userA2).length === 0);
  threw = false;
  try { FalaTuService.listItems(orgB, userB, conf5.refId!); } catch { threw = true; }
  check("lista de outra org inacessível", threw);
  check("item de inbox de outra org invisível", !FalaTuService.getInboxItem(orgB, userB, cap1.id));

  // ===== 13. Toggle de tarefa marca completed_at =====
  const done = FalaTuService.toggleTask(orgA, userA, t1.id, true) as any;
  check("tarefa concluída com timestamp", done.completed === 1 && !!done.completed_at);
  const undone = FalaTuService.toggleTask(orgA, userA, t1.id, false) as any;
  check("desfazer limpa timestamp", undone.completed === 0 && undone.completed_at === null);

  // ===== 14. Briefing =====
  const brief = FalaTuService.briefing(orgA, userA);
  check("briefing: contagem de pendências do inbox", brief.pendingInbox.c === 0);
  check("briefing: eventos sem data aparecem (pro humano datar)", brief.todayEvents.some((e: any) => e.id === conf2.refId));
  check("briefing: listas ativas com progresso", brief.lists.some((l: any) => l.id === conf5.refId && l.item_count === 2 && l.realized_count === 1));

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 1 (ADR-151) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
