import db from "./db.js";
import { chat } from "./llm.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { phoneMatches } from "./phoneMatch.js";

/**
 * Tarefas por áudio/texto no Zapp (ADR-102, Fase 1). Espelha o arco do pedido de
 * compra por áudio (ADR-099): o gestor dita "agenda tarefa X pra Fulano até
 * sexta", a IA extrai os campos, casa o responsável por nome e monta uma tarefa
 * para confirmação. Nada é criado sem SIM.
 *
 * O áudio já chega transcrito (transcribeAudio roda no webhook antes do
 * orquestrador) — aqui só tratamos texto.
 */
const PRIORITIES = ["baixa", "media", "alta"];

export class TaskAudioService {
  /**
   * Extrai uma tarefa da fala do gestor. Método estático p/ ser mockável nos
   * testes (sem chave OpenAI). Retorna isTask=false quando não é uma ordem de
   * tarefa (conversa fiada, dúvida) — aí o orquestrador segue o fluxo normal.
   */
  static async extractTaskFromText(orgId: string, text: string, today?: string): Promise<{
    isTask: boolean; title: string; assignee: string; dueAt: string | null; priority: string;
  }> {
    const names = (db.prepare(`SELECT name FROM users WHERE organization_id = ? AND name IS NOT NULL AND name != ''`).all(orgId) as any[])
      .map(r => r.name).slice(0, 60);
    const hoje = today || new Date().toISOString().slice(0, 10);
    const system = [
      "Você extrai TAREFAS que o gestor de uma loja dita por voz ou texto para delegar à equipe.",
      'Responda SEMPRE em JSON: { "isTask": boolean, "title": string, "assignee": string, "dueAt": string|null, "priority": "baixa"|"media"|"alta" }.',
      "isTask=true só se a mensagem claramente pede para CRIAR/AGENDAR/DELEGAR uma tarefa. Pergunta, conversa ou pedido de compra => isTask=false.",
      "title: a ação a fazer, curta e clara (sem o nome do responsável). assignee: o nome da pessoa a quem foi delegada (vazio se não disser).",
      `dueAt: a data limite no formato ISO YYYY-MM-DD, resolvendo expressões relativas a partir de HOJE=${hoje} (ex.: "sexta", "amanhã", "dia 20"). null se não houver prazo.`,
      "priority: 'alta' se disser urgente/importante/hoje; 'baixa' se disser quando puder/sem pressa; senão 'media'.",
      names.length ? `Nomes da equipe (case o assignee com o mais próximo destes): ${names.join("; ")}` : "",
    ].filter(Boolean).join("\n");
    try {
      const raw = await chat(text, { json: true, temperature: 0, system });
      const p = JSON.parse(raw || "{}");
      const title = String(p.title || "").trim();
      const priority = PRIORITIES.includes(String(p.priority)) ? String(p.priority) : "media";
      const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(p.dueAt)) ? String(p.dueAt) : null;
      return { isTask: !!p.isTask && !!title, title, assignee: String(p.assignee || "").trim(), dueAt, priority };
    } catch (e) {
      console.warn("[TaskAudio] Falha ao extrair tarefa do texto:", e);
      return { isTask: false, title: "", assignee: "", dueAt: null, priority: "media" };
    }
  }

  /**
   * Casa um nome ditado ("Fulano") a um usuário da org por fuzzy match sobre
   * users.name. Retorna o usuário só quando o match é ÚNICO e claro; ambíguo
   * (dois nomes próximos) ou sem correspondência retorna null — o orquestrador
   * então cria a tarefa sem responsável e avisa (ADR-102: nunca chuta).
   */
  static matchAssignee(orgId: string, name: string): { id: string; name: string } | null {
    const q = this.norm(name);
    if (!q) return null;
    const users = db.prepare(`SELECT id, name FROM users WHERE organization_id = ? AND name IS NOT NULL AND name != ''`).all(orgId) as any[];
    const qTokens = q.split(" ").filter(Boolean);
    const scored = users.map(u => {
      const n = this.norm(u.name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.includes(q) || q.includes(n)) score = 70;
      else {
        // Primeiro nome bate exatamente? (o gestor costuma dizer só o primeiro nome)
        const first = n.split(" ")[0];
        if (first && (first === q || qTokens.includes(first))) score = 65;
        else {
          const nTokens = new Set(n.split(" ").filter(Boolean));
          const overlap = qTokens.filter(t => nTokens.has(t)).length;
          score = overlap > 0 ? (overlap / Math.max(qTokens.length, nTokens.size)) * 50 : 0;
        }
      }
      return { id: u.id, name: u.name, score };
    }).filter(s => s.score >= 40).sort((a, b) => b.score - a.score);

    if (!scored.length) return null;
    // Ambíguo: dois candidatos com pontuação próxima → não decide (evita chute).
    if (scored.length > 1 && scored[0].score - scored[1].score < 15) return null;
    return { id: scored[0].id, name: scored[0].name };
  }

  private static norm(s: string): string {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  /**
   * Cobra o responsável por WhatsApp pelo canal interno da org (o mesmo do
   * Coordenador IA). Degradê seguro: sem telefone do responsável OU sem canal
   * interno, retorna false e o fluxo cai só na notificação in-app do TaskService.
   */
  static async pingAssignee(orgId: string, userId: string, title: string, dueLabel?: string): Promise<boolean> {
    try {
      const u = db.prepare(`SELECT name, phone FROM users WHERE id = ? AND organization_id = ?`).get(userId, orgId) as any;
      const phone = String(u?.phone || "").replace(/\D/g, "");
      if (!phone) return false;
      const ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND kind = 'internal' LIMIT 1`).get(orgId) as any;
      if (!ch?.id) return false;
      const first = String(u?.name || "").trim().split(/\s+/)[0] || "";
      const prazo = dueLabel ? `\n🗓️ Prazo: *${dueLabel}*` : "";
      const msg = `Olá${first ? `, ${first}` : ""}! 📋 Você recebeu uma nova tarefa:\n\n*${title}*${prazo}\n\nResponda *tarefas* para ver todas as suas ou *iniciar* quando começar. 💪`;
      await MessageProviderService.sendMessage(ch.id, phone, msg);
      return true;
    } catch (e) {
      console.warn("[TaskAudio] Falha ao cobrar responsável no WhatsApp:", e);
      return false;
    }
  }
}
