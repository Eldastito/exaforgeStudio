/**
 * TEST — Tarefa por voz/texto do gestor (ADR-102, item #15 Fase 1).
 *
 * O gestor dita "cria tarefa ligar pro fornecedor pra João até sexta" no Zapp →
 * o áudio já vira texto → o orquestrador extrai título/responsável/prazo, casa o
 * responsável por nome e monta a tarefa CONFIRMADA antes de criar (SIM/NÃO). Ao
 * confirmar, cria via TaskService e cobra o responsável no WhatsApp (fallback
 * in-app). Nome não encontrado/ambíguo → tarefa sem responsável (nunca chuta).
 *
 * Mocka TaskAudioService.extractTaskFromText (sem chave OpenAI) e
 * MessageProviderService.sendMessage; exercita o fluxo real do orquestrador.
 *
 * Uso: npm run test:task-audio-intent
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-task-audio-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-task-audio-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");
  const { TaskAudioService } = await import("../src/server/TaskAudioService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const managerPhone = "5521999990000";
  const channelId = randomUUID();      // canal externo (por onde o gestor fala)
  const internalId = randomUUID();     // canal interno (Coordenador IA / cobrança)
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Dono')`).run(randomUUID(), orgId, managerPhone);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status, kind) VALUES (?, ?, 'Zap', 'evolution', 'me', 'active', 'client')`).run(channelId, orgId);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status, kind) VALUES (?, ?, 'Interno', 'evolution', 'int', 'active', 'internal')`).run(internalId, orgId);

  const joao = randomUUID(), maria = randomUUID(), joana = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role) VALUES (?, ?, 'João Silva', 'joao@t.com', '5521988887777', 'agent')`).run(joao, orgId);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role) VALUES (?, ?, 'Maria Souza', 'maria@t.com', NULL, 'agent')`).run(maria, orgId); // SEM telefone
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role) VALUES (?, ?, 'Joana Lima', 'joana@t.com', '5521977776666', 'agent')`).run(joana, orgId);

  // Mock da extração por IA (o resto do fluxo é real).
  (TaskAudioService as any).extractTaskFromText = async (_org: string, text: string) => {
    if (/obrigado|conversa/i.test(text)) return { isTask: false, title: "", assignee: "", dueAt: null, priority: "media" };
    if (/estoque|maria/i.test(text)) return { isTask: true, title: "Conferir o estoque", assignee: "Maria", dueAt: null, priority: "alta" };
    if (/vitrine|fulano/i.test(text)) return { isTask: true, title: "Organizar a vitrine", assignee: "Fulano", dueAt: null, priority: "media" };
    if (/arrumar a loja/i.test(text)) return { isTask: true, title: "Arrumar a loja", assignee: "Jo", dueAt: null, priority: "baixa" };
    if (/fornecedor/i.test(text)) return { isTask: true, title: "Ligar pro fornecedor", assignee: "João", dueAt: "2026-07-24", priority: "media" };
    return { isTask: false, title: "", assignee: "", dueAt: null, priority: "media" };
  };

  // Mock do envio WhatsApp (captura as cobranças).
  const sent: { ch: string; to: string; content: string }[] = [];
  (MessageProviderService as any).sendMessage = async (ch: string, to: string, content: string) => { sent.push({ ch, to, content }); return "ok"; };

  const send = (message: string) => AIOrchestratorService.processMessage({ message, organizationId: orgId, senderId: managerPhone, channelId });
  const taskCount = () => (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE organization_id = ?`).get(orgId) as any).c;

  // ===== 1. matchAssignee — casa único, ambíguo e inexistente =====
  check("matchAssignee('João') → João Silva", TaskAudioService.matchAssignee(orgId, "João")?.id === joao);
  check("matchAssignee('Jo') → ambíguo (null)", TaskAudioService.matchAssignee(orgId, "Jo") === null);
  check("matchAssignee('Fulano') → sem match (null)", TaskAudioService.matchAssignee(orgId, "Fulano") === null);

  // ===== 2. Gestor dita tarefa com responsável → confirmação (nada criado) =====
  const r1 = await send("cria tarefa ligar pro fornecedor pra João até sexta");
  check("pediu confirmação (SIM/NÃO)", /SIM/.test(r1.reply) && /tarefa/i.test(r1.reply));
  check("montou título + responsável + prazo", r1.reply.includes("Ligar pro fornecedor") && r1.reply.includes("João Silva") && r1.reply.includes("24/07"));
  const pend = db.prepare(`SELECT * FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone) as any;
  check("pendência 'task_create_audio' criada", pend?.action_type === "task_create_audio");
  check("NADA criado antes do SIM", taskCount() === 0);

  // ===== 3. SIM → cria a tarefa atribuída + cobra no WhatsApp =====
  const r3 = await send("SIM");
  check("confirmou criação + avisou no WhatsApp", /criada/i.test(r3.reply) && /WhatsApp/i.test(r3.reply));
  const t1 = db.prepare(`SELECT * FROM tasks WHERE organization_id = ? AND title = 'Ligar pro fornecedor'`).get(orgId) as any;
  check("tarefa criada e atribuída a João", !!t1 && t1.assigned_to === joao);
  check("prazo e prioridade gravados", t1?.due_at === "2026-07-24" && t1?.priority === "media");
  check("source = 'ia'", t1?.source === "ia");
  check("cobrança enviada pelo canal INTERNO ao telefone do João", sent.some(s => s.ch === internalId && s.to === "5521988887777"));
  check("pendência consumida (SIM limpou)", !db.prepare(`SELECT 1 FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone));

  // ===== 4. Responsável SEM telefone → cria, mas degradê p/ in-app =====
  const sentBefore = sent.length;
  await send("agenda tarefa conferir o estoque pra Maria");
  const r4 = await send("SIM");
  check("Maria sem telefone → avisa no painel (não WhatsApp)", /painel/i.test(r4.reply) && !/avisei no WhatsApp/i.test(r4.reply));
  check("nenhuma cobrança WhatsApp nova p/ Maria", sent.length === sentBefore);
  const tM = db.prepare(`SELECT assigned_to FROM tasks WHERE organization_id = ? AND title = 'Conferir o estoque'`).get(orgId) as any;
  check("tarefa da Maria criada e atribuída", tM?.assigned_to === maria);

  // ===== 5. Nome não encontrado → tarefa SEM responsável + aviso =====
  const r5a = await send("cria tarefa organizar a vitrine pra Fulano");
  check("avisa que não achou o nome", /não achei|nao achei/i.test(r5a.reply) && /Fulano/.test(r5a.reply));
  const r5b = await send("SIM");
  check("criada sem responsável", /sem responsável|sem responsavel/i.test(r5b.reply));
  const tF = db.prepare(`SELECT assigned_to FROM tasks WHERE organization_id = ? AND title = 'Organizar a vitrine'`).get(orgId) as any;
  check("tarefa 'Fulano' sem responsável (assigned_to null)", tF && tF.assigned_to === null);

  // ===== 6. Nome ambíguo ("Jo" casa João e Joana) → sem responsável =====
  const r6 = await send("cria tarefa arrumar a loja pra Jo");
  check("ambíguo também vira aviso de não-encontrado", /não achei|nao achei/i.test(r6.reply));
  await send("NÃO"); // cancela para limpar a pendência

  // ===== 7. Não é tarefa → não dispara nada =====
  const before = taskCount();
  try { await send("essa foi uma boa tarefa, obrigado!"); } catch { /* fall-through do fluxo geral sem OpenAI é tolerado */ }
  check("mensagem não-tarefa não cria pendência de tarefa", (() => {
    const p = db.prepare(`SELECT action_type FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone) as any;
    return !p || p.action_type !== "task_create_audio";
  })());
  check("mensagem não-tarefa não cria tarefa", taskCount() === before);

  // --- Relatório ---
  console.log("\n=== TEST: Tarefa por áudio no Zapp (ADR-102) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Tarefa por áudio OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
