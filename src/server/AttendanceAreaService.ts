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

  /** Detecta pedido de trocar de área / voltar ao menu. */
  static wantsSwitch(message: string): boolean {
    const t = (message || "").trim().toLowerCase();
    return /(trocar de [áa]rea|mudar de [áa]rea|outra [áa]rea|voltar ao menu|^menu$|falar com outr|outro atendimento)/.test(t);
  }

  /** Bloco de contexto da área injetado no prompt da IA. */
  static personaText(area: ServiceArea): string {
    let txt = `ÁREA DE ATENDIMENTO ATUAL: "${area.name}". Você atende EXCLUSIVAMENTE como esta área/profissional — não fale por outras áreas. `;
    if (area.description) txt += `Sobre a área: ${area.description}. `;
    if (area.persona) txt += `\nInstruções e tom desta área (siga à risca): ${area.persona}`;
    txt += `\nSe o cliente quiser falar com OUTRA área, diga que ele pode responder "trocar de área" para voltar ao menu.`;
    return txt;
  }
}
