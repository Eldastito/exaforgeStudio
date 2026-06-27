import db from "./db.js";
import { chat } from "./llm.js";
import { BusinessContextService } from "./BusinessContextService.js";

/**
 * Diretor Executivo IA / Central de Agentes (Fase A da visão de SO Empresarial),
 * VERTICALIZADO. O gestor pergunta em linguagem natural; o serviço monta o
 * PANORAMA REAL (BusinessContextService + dados específicos da vertical) e a IA
 * APENAS narra e recomenda com o "sotaque" do setor. Regra de ouro: nunca inventa.
 */

/** "Sotaque" do Diretor por vertical. Hoje completo para HOTELARIA. */
const VERTICAL_LENS: Record<string, string> = {
  hospitalidade: `CONTEXTO DO SETOR: você é o Diretor de um HOTEL / POUSADA / ESPAÇO DE EVENTOS.
Fale a língua da hotelaria: OCUPAÇÃO, diárias, reservas confirmadas vs canceladas, no-show,
eventos & grupos (casamentos, convenções, day use), recuperação de orçamentos, sazonalidade
(fim de semana/feriado) e atendimento pré-estadia (concierge).
Prioridades do setor: encher a ocupação, recuperar orçamentos parados, converter consultas de
evento e reduzir cancelamentos.`,
};

export class ExecutiveAdvisorService {
  private static readonly GUARDRAILS = `Você é o DIRETOR EXECUTIVO IA do negócio — um conselheiro de gestão direto e prático.
REGRAS:
- Baseie-se SOMENTE nos números do PANORAMA abaixo. NUNCA invente métricas, valores ou fatos.
- Se faltar dado para responder algo, diga claramente o que falta (ex.: "ainda não há dados de X").
- Cite números concretos do panorama ao explicar.
- Seja conciso e termine com uma lista curta de AÇÕES PRIORIZADAS (no máximo 5), da mais impactante para a menos.
- Tom de conselheiro de confiança: honesto, sem enrolação, sem jargão.`;

  /** Vertical da org (para escolher o sotaque). */
  private static vertical(orgId: string): string {
    try {
      const o = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      return o?.vertical || "";
    } catch (e) { return ""; }
  }

  /** Dados específicos da HOTELARIA (determinísticos) anexados ao panorama. */
  private static hospitalityData(orgId: string): string {
    const parts: string[] = [];
    try {
      const r = db.prepare(`SELECT status, COUNT(*) c FROM reservations WHERE organization_id = ? GROUP BY status`).all(orgId) as any[];
      if (r.length) {
        const map: any = r.reduce((a, x) => { a[x.status] = x.c; return a; }, {});
        const futuras = db.prepare(`SELECT COUNT(*) c FROM reservations WHERE organization_id = ? AND status IN ('pending','confirmed') AND start_at >= datetime('now')`).get(orgId) as any;
        parts.push(`RESERVAS: ${r.map(x => `${x.status}=${x.c}`).join(', ')}. Futuras (pendentes/confirmadas): ${futuras?.c || 0}.`);
      }
    } catch (e) { /* tabela pode não existir */ }
    try {
      const ev = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(won_amount),0) won FROM event_inquiries WHERE organization_id = ? GROUP BY status`).all(orgId) as any[];
      if (ev.length) {
        const won = ev.reduce((a, x) => a + (x.won || 0), 0);
        parts.push(`EVENTOS & GRUPOS (pipeline): ${ev.map(x => `${x.status}=${x.c}`).join(', ')}. Fechados (R$): ${won.toFixed(2)}.`);
      }
    } catch (e) { /* noop */ }
    try {
      const q = db.prepare(`SELECT COUNT(*) sent, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) acc, SUM(CASE WHEN status IN ('sent','viewed') THEN 1 ELSE 0 END) abertos FROM quotes WHERE organization_id = ?`).get(orgId) as any;
      if (q?.sent) parts.push(`ORÇAMENTOS: ${q.sent} enviados, ${q.acc || 0} aceitos, ${q.abertos || 0} em aberto (recuperáveis).`);
    } catch (e) { /* noop */ }
    return parts.length ? `\nDADOS DE HOTELARIA:\n${parts.join('\n')}` : "";
  }

  /** Monta o panorama completo (genérico + lente + dados da vertical). */
  private static fullContext(orgId: string): string {
    const base = BusinessContextService.build(orgId);
    const v = this.vertical(orgId);
    const lens = VERTICAL_LENS[v] ? `\n${VERTICAL_LENS[v]}\n` : "";
    const vData = v === "hospitalidade" ? this.hospitalityData(orgId) : "";
    return `${lens}${base}${vData}`;
  }

  /** Responde uma pergunta do gestor usando o panorama real do negócio. */
  static async ask(orgId: string, question: string): Promise<string> {
    const q = String(question || "").trim();
    if (!q) return "Faça uma pergunta sobre o seu negócio (ex.: \"por que minhas vendas caíram?\").";
    const panorama = this.fullContext(orgId);
    const prompt = `${this.GUARDRAILS}

PANORAMA DO NEGÓCIO (dados reais, últimos 30 dias salvo indicação):
${panorama}

PERGUNTA DO GESTOR:
"${q}"

Sua resposta (com números do panorama + ações priorizadas):`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[DiretorIA] Falha ao responder:", e);
      return "Não consegui analisar agora. Tente novamente em instantes.";
    }
  }

  /** Briefing diário: o que vai bem, o que preocupa e as ações do dia. */
  static async briefing(orgId: string): Promise<string> {
    const panorama = this.fullContext(orgId);
    const prompt = `${this.GUARDRAILS}

PANORAMA DO NEGÓCIO (dados reais):
${panorama}

Gere o BRIEFING DE HOJE em 3 blocos curtos, com base SOMENTE no panorama:
1. ✅ O que está indo bem (1-3 pontos com número).
2. ⚠️ O que merece atenção (1-3 pontos com número).
3. 🎯 Ações prioritárias de hoje (até 5, objetivas).
Não invente nada; se faltar dado, indique.`;
    try {
      return (await chat(prompt, { temperature: 0.3 })).trim();
    } catch (e) {
      console.error("[DiretorIA] Falha no briefing:", e);
      return "Não consegui gerar o briefing agora.";
    }
  }
}
