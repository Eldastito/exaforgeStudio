import db from "./db.js";

export type ServiceArea = {
  id: string; organization_id: string; name: string; description?: string;
  persona?: string; assigned_user_id?: string; position: number; active: number;
};

// Áreas de Atendimento: vários profissionais/departamentos que dividem o mesmo
// número de WhatsApp. A IA recebe a 1ª mensagem, oferece um menu e "tranca" a
// conversa na área escolhida (respondendo como aquele profissional).
export class AttendanceAreaService {
  static activeAreas(orgId: string): ServiceArea[] {
    return db.prepare(
      "SELECT * FROM service_areas WHERE organization_id = ? AND active = 1 ORDER BY position ASC, created_at ASC"
    ).all(orgId) as any[];
  }

  static getArea(orgId: string, areaId: string): ServiceArea | null {
    return (db.prepare("SELECT * FROM service_areas WHERE id = ? AND organization_id = ?").get(areaId, orgId) as any) || null;
  }

  /**
   * Saudação sensível ao horário (Bom dia / Boa tarde / Boa noite), no fuso do
   * negócio (APP_TIMEZONE, padrão America/Sao_Paulo). O servidor roda em UTC, por
   * isso NÃO usamos a hora local do processo.
   */
  static greeting(): string {
    const tz = process.env.APP_TIMEZONE || "America/Sao_Paulo";
    let hour = 12;
    try {
      hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()));
      if (hour === 24) hour = 0;
    } catch { /* fuso inválido → cai no padrão 12 (boa tarde) */ }
    if (hour >= 5 && hour < 12) return "Bom dia";
    if (hour >= 12 && hour < 18) return "Boa tarde";
    return "Boa noite";
  }

  /**
   * Mensagem com que a ÁREA ESCOLHIDA assume a conversa na hora: saudação
   * sensível ao horário + identificação da área + se coloca à disposição. Evita o
   * beco-sem-saída de "vou te encaminhar" sem ninguém assumir. A descrição da área
   * (configurada em "Áreas de Atendimento") entra na saudação como tom/contexto.
   */
  static welcomeMessage(area: ServiceArea, contactName?: string): string {
    const first = (contactName || "").trim().split(/\s+/)[0] || "";
    const who = first ? `, ${first}` : "";
    const desc = area.description ? ` ${area.description.trim().replace(/\.?$/, ".")}` : "";
    return `${this.greeting()}${who}! 👋 Você está falando com *${area.name}*.${desc} Como posso te ajudar hoje? 😊`;
  }

  /** Mensagem de boas-vindas + menu numerado das áreas. */
  static buildMenu(orgId: string, contactName?: string): string {
    const areas = this.activeAreas(orgId);
    const greeting = contactName ? `Olá, ${contactName}! 👋` : "Olá! 👋";
    const lines = areas.map((a, i) => `${i + 1}) ${a.name}${a.description ? ` — ${a.description}` : ""}`);
    return `${greeting} Para te direcionar melhor, com qual área você quer falar?\n\n${lines.join("\n")}\n\nÉ só responder com o número ou o nome. 🙂`;
  }

  /** Casa a mensagem com uma área: número (1..n) OU nome/palavra-chave. */
  static match(orgId: string, message: string): ServiceArea | null {
    const areas = this.activeAreas(orgId);
    if (areas.length === 0) return null;
    const t = (message || "").trim();
    if (!t) return null;

    // 1) Número direto (responde "2", "opção 2", etc.) — só se a msg for curta,
    //    para não confundir com números no meio de uma frase longa.
    if (t.length <= 16) {
      const num = t.match(/\b(\d{1,2})\b/);
      if (num) {
        const idx = parseInt(num[1], 10) - 1;
        if (idx >= 0 && idx < areas.length) return areas[idx];
      }
    }

    // 2) Nome/keyword.
    const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const tn = norm(t);
    for (const a of areas) {
      const an = norm(a.name);
      if (an && (tn.includes(an) || (an.length >= 4 && an.includes(tn)))) return a;
      const words = an.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      if (words.some(w => tn.includes(w))) return a;
    }
    return null;
  }

  /** Detecta pedido genérico de trocar de área / voltar ao menu. */
  static wantsSwitch(message: string): boolean {
    const t = (message || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return /(trocar de area|mudar de area|outra area|voltar ao menu|^menu$|falar com outr|outro atendimento|outro setor|outro departamento|me transfer|quero transfer|pode transfer|transferir)/.test(t);
  }

  /**
   * Bloco de contexto da área injetado no prompt da IA. Quando há outras áreas
   * ativas, ensina a IA a ROTEAR (route_to_area) em vez de prometer transferência
   * que não acontece — esse era o bug do "vou transferir e não transfere".
   */
  static personaText(area: ServiceArea): string {
    let txt = `ÁREA DE ATENDIMENTO ATUAL: "${area.name}". Você atende como esta área/profissional. `;
    if (area.description) txt += `Sobre a área: ${area.description}. `;
    if (area.persona) txt += `\nInstruções e tom desta área (siga à risca): ${area.persona}`;

    // Lista as OUTRAS áreas ativas e ensina o roteamento via route_to_area.
    const others = this.activeAreas(area.organization_id).filter(a => a.id !== area.id);
    if (others.length > 0) {
      const list = others.map(a => `- ${a.name}${a.description ? ` (${a.description})` : ""}`).join("\n");
      txt += `\n\nOUTRAS ÁREAS DISPONÍVEIS (para onde você PODE encaminhar o cliente):\n${list}\n`;
      txt += `ROTEAMENTO: se o cliente quiser falar com outra área/profissional, pedir para ser transferido, ou pedir algo que claramente é de OUTRA área da lista acima, defina o campo "route_to_area" com o NOME EXATO dessa área. NÃO prometa a transferência no texto e NÃO diga que vai "verificar" — o sistema faz o encaminhamento na hora. Quando rotear, escreva uma "reply" curtinha, ex.: "Claro! Já te encaminho para {area} 😊". Se o cliente quiser apenas voltar ao menu de áreas, oriente-o a responder "trocar de área". Responda normalmente (sem route_to_area) quando o assunto for da SUA área.`;
    }
    return txt;
  }
}
