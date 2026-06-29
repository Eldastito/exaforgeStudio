import db from "./db.js";
import { chat } from "./llm.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ModuleService } from "./ModuleService.js";
import { TaskService } from "./TaskService.js";
import { ExecutiveAdvisorService } from "./ExecutiveAdvisorService.js";

const onlyDigits = (s: string) => String(s || "").replace(/\D/g, "");
// Compara números de WhatsApp tolerando DDI/9º dígito (casa pelos últimos 10).
function phoneMatches(a: string, b: string): boolean {
  const x = onlyDigits(a), y = onlyDigits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const k = Math.min(11, Math.max(8, Math.min(x.length, y.length)));
  return x.slice(-k) === y.slice(-k);
}

const PRIO_EMOJI: Record<string, string> = { alta: "🔴", media: "🟡", baixa: "⚪" };

/**
 * Coordenador IA — a VOZ INTERNA do ZapFlow (Fase 2). Atende o número da
 * EQUIPE (canal kind='internal'): lista tarefas do colaborador, marca como
 * feita/iniciada, assessora a entrega e cria tarefas — tudo pelo WhatsApp.
 *
 * Segurança: só responde a números cadastrados como `users.phone` da própria
 * organização. Número desconhecido recebe um aviso e nada é executado.
 */
export class CoordenadorService {
  // Memória curta: última lista numerada por colaborador (para "concluir 2").
  private static lastList = new Map<string, { ids: string[]; at: number }>();

  private static resolveUser(orgId: string, fromNumber: string): any | null {
    const users = db.prepare(
      "SELECT id, name, email, phone, role FROM users WHERE organization_id = ? AND phone IS NOT NULL AND phone != ''"
    ).all(orgId) as any[];
    return users.find(u => phoneMatches(u.phone, fromNumber)) || null;
  }

  private static openTasks(orgId: string, userId: string): any[] {
    return TaskService.list(orgId, { assignedTo: userId })
      .filter(t => t.status === "a_fazer" || t.status === "fazendo");
  }

  private static firstName(u: any): string {
    return String(u?.name || "").trim().split(/\s+/)[0] || "";
  }

  private static fmtList(tasks: any[]): string {
    if (!tasks.length) return "🎉 Você não tem tarefas em aberto. Bom trabalho!";
    return tasks.map((t, i) => {
      const flag = PRIO_EMOJI[t.priority] || "";
      const st = t.status === "fazendo" ? " (em andamento)" : "";
      return `*${i + 1}.* ${flag} ${t.title}${st}`;
    }).join("\n");
  }

  private static menu(name: string): string {
    return `Olá${name ? `, ${name}` : ""}! Sou o *Coordenador IA* 🤝\nPosso te ajudar com suas tarefas. É só mandar:\n\n• *tarefas* — ver suas tarefas\n• *iniciar 2* — começar a tarefa 2\n• *concluir 2* — marcar a 2 como feita\n• *ajuda 2* — dicas de como entregar a 2\n• *nova: ligar para o cliente* — criar uma tarefa\n\nOu me escreva naturalmente que eu entendo. 😉`;
  }

  /** Ponto de entrada chamado pelo webhook quando o canal é interno. */
  static async handleInbound(orgId: string, channelId: string, fromNumber: string, text: string): Promise<void> {
    const reply = (msg: string) => MessageProviderService.sendMessage(channelId, fromNumber, msg);

    if (!ModuleService.isEnabled(orgId, "execucao")) {
      await reply("O módulo de Tarefas (Coordenador IA) não está ativo nesta conta.");
      return;
    }
    const user = this.resolveUser(orgId, fromNumber);
    if (!user) {
      await reply("Olá! Não reconheço este número. 🙋\nPeça ao administrador para cadastrar seu WhatsApp em *Configurações → Usuários* para você usar o Coordenador IA.");
      return;
    }

    const raw = String(text || "").trim();
    const msg = raw.toLowerCase();
    const key = `${orgId}:${user.id}`;
    const name = this.firstName(user);
    if (!raw) { await reply(this.menu(name)); return; }

    // Resolve o índice citado ("concluir 2") contra a última lista enviada.
    const taskByIndex = (n: number): any | null => {
      const remembered = this.lastList.get(key);
      const ids = remembered?.ids || this.openTasks(orgId, user.id).map(t => t.id);
      const id = ids[n - 1];
      if (!id) return null;
      return TaskService.get(orgId, id);
    };

    try {
      // ── Comandos determinísticos (rápidos, sem custo de IA) ──
      if (/^(oi|olá|ola|menu|ajuda|help|bom dia|boa tarde|boa noite)$/.test(msg)) {
        await reply(this.menu(name)); return;
      }
      if (/^(tarefas|minhas tarefas|o que tenho|lista|listar)/.test(msg)) {
        const tasks = this.openTasks(orgId, user.id);
        this.lastList.set(key, { ids: tasks.map(t => t.id), at: Date.now() });
        await reply(`📋 *Suas tarefas:*\n\n${this.fmtList(tasks)}`);
        return;
      }
      let m;
      if ((m = msg.match(/^(concluir|conclui|feito|finalizar|terminei|conclu[ií]da?)\s+(\d+)/))) {
        const t = taskByIndex(parseInt(m[2], 10));
        if (!t) { await reply("Não achei essa tarefa. Manda *tarefas* que eu numero pra você."); return; }
        TaskService.move(orgId, t.id, "feito", user.id);
        await reply(`✅ Marquei como *feita*: ${t.title}\nMandar bem! 👏`);
        return;
      }
      if ((m = msg.match(/^(iniciar|inicia|começar|comecar|comecei|fazendo)\s+(\d+)/))) {
        const t = taskByIndex(parseInt(m[2], 10));
        if (!t) { await reply("Não achei essa tarefa. Manda *tarefas* primeiro."); return; }
        TaskService.move(orgId, t.id, "fazendo", user.id);
        await reply(`🚀 Bora! Marquei *em andamento*: ${t.title}`);
        return;
      }
      if ((m = msg.match(/^(ajuda|como|me ajuda|dica)\s+(\d+)/))) {
        const t = taskByIndex(parseInt(m[2], 10));
        if (!t) { await reply("Não achei essa tarefa. Manda *tarefas* primeiro."); return; }
        await reply("Pensando na melhor forma… 💭");
        const tip = await ExecutiveAdvisorService.taskAssist(orgId, { title: t.title, description: t.description, contactName: t.contact?.name, refLabel: t.ref_label });
        await reply(tip);
        return;
      }
      if ((m = raw.match(/^(nova|nova tarefa|criar|cria)\s*:?\s+(.+)/i))) {
        const title = m[2].trim();
        const t = TaskService.create(orgId, { title, assignedTo: user.id, source: "ia", priority: "media" }, user.id);
        await reply(`📝 Criei a tarefa e atribuí a você:\n*${t.title}*`);
        return;
      }

      // ── Linguagem natural: a IA mapeia para uma ação sobre as tarefas ──
      await this.handleNatural(orgId, user, key, raw, reply);
    } catch (e: any) {
      console.error("[Coordenador] erro:", e);
      await reply("Tive um problema agora. Tenta de novo em instantes? 🙏");
    }
  }

  /** Interpreta uma frase livre como uma ação (list/start/complete/help/create/menu). */
  private static async handleNatural(orgId: string, user: any, key: string, raw: string, reply: (m: string) => any): Promise<void> {
    const tasks = this.openTasks(orgId, user.id);
    this.lastList.set(key, { ids: tasks.map(t => t.id), at: Date.now() });
    const listed = tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n") || "(sem tarefas em aberto)";
    const prompt = `Você interpreta a mensagem de um colaborador sobre as TAREFAS dele e devolve só JSON.
Tarefas em aberto (numeradas):
${listed}

Mensagem: "${raw}"

Responda JSON: {"action":"list|start|complete|help|create|menu","index":<número da tarefa quando aplicável, senão null>,"title":"<título quando action=create, senão vazio>"}
- "list" se ele quer ver as tarefas; "start" iniciar; "complete" concluir; "help" pedir ajuda/como fazer; "create" criar nova; "menu" se não entender.`;
    let action = "menu", index: number | null = null, title = "";
    try {
      const j = JSON.parse(await chat(prompt, { temperature: 0, json: true }));
      action = String(j.action || "menu");
      index = Number.isFinite(j.index) ? Number(j.index) : null;
      title = String(j.title || "").trim();
    } catch { /* cai no menu */ }

    const pick = (n: number | null) => (n && tasks[n - 1]) ? tasks[n - 1] : null;
    if (action === "list") { await reply(`📋 *Suas tarefas:*\n\n${this.fmtList(tasks)}`); return; }
    if (action === "create" && title) {
      const t = TaskService.create(orgId, { title, assignedTo: user.id, source: "ia", priority: "media" }, user.id);
      await reply(`📝 Criei e atribuí a você:\n*${t.title}*`); return;
    }
    const t = pick(index);
    if ((action === "complete" || action === "start" || action === "help") && !t) {
      await reply(`Não consegui identificar a tarefa. Suas tarefas:\n\n${this.fmtList(tasks)}\n\nResponda ex.: *concluir 2*.`); return;
    }
    if (action === "complete" && t) { TaskService.move(orgId, t.id, "feito", user.id); await reply(`✅ Feita: ${t.title} 👏`); return; }
    if (action === "start" && t) { TaskService.move(orgId, t.id, "fazendo", user.id); await reply(`🚀 Em andamento: ${t.title}`); return; }
    if (action === "help" && t) {
      await reply("Pensando… 💭");
      const tip = await ExecutiveAdvisorService.taskAssist(orgId, { title: t.title, description: t.description, contactName: t.contact?.name, refLabel: t.ref_label });
      await reply(tip); return;
    }
    await reply(this.menu(this.firstName(user)));
  }
}
