/**
 * TEST — FalaTu Fatia 3 (ADR-151): captura via WhatsApp (canal interno).
 *
 * Cobre: gatilho explícito "anota …"/"falatu …" (mensagem sem gatilho passa
 * reto pro Controller/Coordenador — handled=false); org sem flag não
 * intercepta nada; número desconhecido só ganha aviso no gatilho explícito;
 * RBAC write no módulo `falatu` (owner captura, atendente é negado); captura
 * registra item pendente source='whatsapp' SEM materializar nada (RN-151);
 * "confere" resolve o pendente DERIVADO do banco (materializa a tarefa),
 * "descarta" descarta, e ambos sem pendência caem no fluxo normal; EVENT sem
 * data avisa que não inventa; teto de IA do plano trava com motivo no reply;
 * gatilho vazio vira dica de uso sem gastar IA; isolamento multi-tenant.
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu-whatsapp
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-f3-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-wa-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuWhatsAppService } = await import("../src/server/FalaTuWhatsAppService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkUser = (org: string, role: string, phone: string) => {
    const id = randomUUID();
    db.prepare("INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, ?, ?, ?, ?, 'active')")
      .run(id, org, `U ${role}`, `${id}@x.com`, phone, role);
    return id;
  };

  const orgA = mkOrg();
  const orgB = mkOrg();
  const OWNER_PHONE = "5511988887777";
  const AGENT_PHONE = "5511977776666";
  const ownerA = mkUser(orgA, "owner", OWNER_PHONE);
  mkUser(orgA, "agent", AGENT_PHONE);

  // Mock da extração (plan gate + persistência + consumo continuam reais).
  (FalaTuService as any).interpret = async (input: any) => {
    const text = input.text || "";
    const base = { transcription: text, confidence: 0.9, suggestedAction: "sugestão" };
    if (/dentista/.test(text)) return { ...base, summary: "Marcar dentista", intent: "EVENT", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null } };
    return { ...base, summary: "Ligar pro contador", intent: "TASK", entities: { people: [], projects: [], actions: ["ligar"], listItems: [], eventDate: null, eventTime: null } };
  };

  const inboxCount = (org: string) => (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ?`).get(org) as any).c;
  const taskCount = (org: string) => (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(org) as any).c;

  // ===== 1. Org sem flag: gatilho passa reto (módulo invisível) =====
  const r1 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota ligar pro contador");
  check("org sem flag → handled=false (nada interceptado)", r1.handled === false && inboxCount(orgA) === 0);

  FalaTuService.setOrgEnabled(orgA, true);

  // ===== 2. Mensagem SEM gatilho nunca é nossa (Controller/Coordenador intactos) =====
  for (const t of ["saldo", "tarefas", "aprovar 1", "quanto o Marcos vendeu?"]) {
    const r = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, t);
    if (r.handled) check(`mensagem "${t}" não deveria ser interceptada`, false);
  }
  check("comandos do Controller/Coordenador passam reto", results.every((x) => x.ok));

  // ===== 3. Número desconhecido =====
  const r3 = await FalaTuWhatsAppService.handle(orgA, "5599911112222", "anota comprar arroz");
  check("número desconhecido no gatilho → aviso de cadastro", r3.handled === true && /cadastrar/i.test(r3.reply));
  const r3b = await FalaTuWhatsAppService.handle(orgA, "5599911112222", "confere");
  check("confere de número desconhecido não é nosso", r3b.handled === false);

  // ===== 4. RBAC: atendente (fallback legado) não captura =====
  const r4 = await FalaTuWhatsAppService.handle(orgA, AGENT_PHONE, "anota comprar arroz");
  check("atendente sem nível em falatu é negado", r4.handled === true && /não tem acesso/i.test(r4.reply) && inboxCount(orgA) === 0);

  // ===== 5. Captura do owner → item pendente, nada materializado =====
  const r5 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota aí ligar pro contador sobre o imposto");
  check("captura responde com interpretação + instruções", r5.handled === true && /tarefa/.test(r5.reply) && /confere/.test(r5.reply));
  const item5 = db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgA) as any;
  check("item registrado como source='whatsapp' e pendente", item5?.source === "whatsapp" && item5?.status === "pending" && item5?.user_id === ownerA);
  check("gatilho 'anota aí' removido do conteúdo", item5?.content === "ligar pro contador sobre o imposto");
  check("NADA materializado antes do confere (RN-151)", taskCount(orgA) === 0);

  // ===== 6. "confere" resolve o pendente derivado do banco =====
  const r6 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "confere");
  check("confere materializa a tarefa", r6.handled === true && /✅/.test(r6.reply) && taskCount(orgA) === 1);
  const item6 = db.prepare(`SELECT status, confirmed_kind FROM falatu_inbox_items WHERE id = ?`).get(item5.id) as any;
  check("item vira confirmed/task", item6?.status === "confirmed" && item6?.confirmed_kind === "task");
  const r6b = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "confere");
  check("confere sem pendência cai no fluxo normal", r6b.handled === false);

  // ===== 7. EVENT sem data: avisa que não inventa (RN-151) =====
  const r7 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota preciso marcar dentista");
  check("EVENT sem data → aviso 'não invento'", r7.handled === true && /Sem data explícita/i.test(r7.reply));
  const r7b = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "descarta");
  check("descarta resolve o pendente", r7b.handled === true && /Descartado/i.test(r7b.reply));
  // Conta por status (created_at tem precisão de segundo — ordenar empataria).
  const discarded = (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ? AND status = 'discarded'`).get(orgA) as any).c;
  check("item descartado é UPDATE de status (nunca DELETE)", discarded === 1 && inboxCount(orgA) === 2);
  const r7c = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "descarta");
  check("descarta sem pendência cai no fluxo normal", r7c.handled === false);

  // ===== 8. Gatilho vazio → dica de uso sem gastar IA =====
  const before8 = (db.prepare(`SELECT COUNT(*) c FROM ai_interactions_log WHERE organization_id = ?`).get(orgA) as any).c;
  const r8 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota");
  const after8 = (db.prepare(`SELECT COUNT(*) c FROM ai_interactions_log WHERE organization_id = ?`).get(orgA) as any).c;
  check("'anota' vazio vira dica de uso, sem ação de IA", r8.handled === true && /Ex\.:/.test(r8.reply) && before8 === after8);

  // ===== 9. Teto do plano trava com motivo no reply =====
  db.prepare(`INSERT INTO plans (id, name, price, features) VALUES ('test_nano_wa', 'Nano', 1, ?)`).run(JSON.stringify({ ai_monthly_limit: 2 }));
  db.prepare(`UPDATE organization_settings SET plan_id = 'test_nano_wa' WHERE organization_id = ?`).run(orgA);
  const r9 = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "anota mais uma coisa");
  check("captura acima do teto responde o motivo", r9.handled === true && /Limite mensal/i.test(r9.reply));

  // ===== 10. Isolamento multi-tenant =====
  const ownerB = mkUser(orgB, "owner", "5521955554444");
  FalaTuService.setOrgEnabled(orgB, true);
  const rB = await FalaTuWhatsAppService.handle(orgB, "5521955554444", "anota pagar o aluguel");
  check("org B captura no próprio inbox", rB.handled === true && inboxCount(orgB) === 1);
  const itemB = db.prepare(`SELECT organization_id, user_id FROM falatu_inbox_items WHERE organization_id = ?`).get(orgB) as any;
  check("item da org B chaveado por org+user certos", itemB?.organization_id === orgB && itemB?.user_id === ownerB);
  // "confere" do owner A não pode resolver pendência da org B.
  const rA = await FalaTuWhatsAppService.handle(orgA, OWNER_PHONE, "confere");
  check("pendência de outra org invisível no confere", rA.handled === false);

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 3 (captura via WhatsApp) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
