import db from "./db.js";
import { chat } from "./llm.js";

export interface MemoryConfig {
  memoryEnabled: boolean;        // a IA lembra de conversas anteriores
  greetEnabled: boolean;         // saudação especial p/ quem volta
  greetMinDays: number;          // dias parado p/ tratar como "voltou"
}

export interface CustomerMemory {
  facts: string;                 // fatos durÁveis (rapport): pet, família, preferências…
  summary: string;               // resumo curto da última conversa
  updatedAt: string | null;
}

/**
 * Memória de relacionamento por cliente. Faz a IA "lembrar" de conversas
 * anteriores: guarda fatos durÁveis (nome do pet, filho, preferências, contexto
 * de saúde compartilhado pelo próprio cliente, datas) e um resumo da última
 * conversa, e reconhece quem volta após um tempo parado para abrir com uma
 * saudação calorosa de retorno.
 *
 * Privacidade/LGPD: a memória é opcional (ai_memory_enabled), visível e
 * editável no contato, e pode ser apagada a qualquer momento (clear()).
 */
export class CustomerMemoryService {
  static config(orgId: string): MemoryConfig {
    let row: any = {};
    try {
      row = db.prepare(
        "SELECT ai_memory_enabled, returning_greeting_enabled, returning_greeting_min_days FROM organization_settings WHERE organization_id = ?"
      ).get(orgId) || {};
    } catch { /* colunas podem não existir ainda */ }
    return {
      memoryEnabled: row.ai_memory_enabled == null ? true : !!row.ai_memory_enabled,
      greetEnabled: row.returning_greeting_enabled == null ? true : !!row.returning_greeting_enabled,
      greetMinDays: row.returning_greeting_min_days && row.returning_greeting_min_days > 0 ? row.returning_greeting_min_days : 7,
    };
  }

  static getMemory(orgId: string, contactId: string): CustomerMemory {
    let row: any = {};
    try {
      row = db.prepare(
        "SELECT memory_facts, memory_summary, memory_updated_at FROM contacts WHERE id = ? AND organization_id = ?"
      ).get(contactId, orgId) || {};
    } catch { /* noop */ }
    return { facts: row.memory_facts || "", summary: row.memory_summary || "", updatedAt: row.memory_updated_at || null };
  }

  /** Epoch ms de um datetime do banco (UTC sem 'Z' inclusive). */
  private static ms(s?: string | null): number | null {
    if (!s) return null;
    const v = String(s).trim();
    const norm = /(z|[+-]\d\d:?\d\d)$/i.test(v) ? v : v.replace(" ", "T") + "Z";
    const t = Date.parse(norm);
    return isNaN(t) ? null : t;
  }

  /**
   * Quem está voltando? Recebe o último contato ANTERIOR (capturado antes do
   * touchContact) e se é uma conversa nova. Devolve os dias parados quando passa
   * do limite configurado — senão null (não saúda como retorno).
   */
  static returningDays(orgId: string, prevContactAt: string | null | undefined, isNewConversation: boolean): number | null {
    if (!isNewConversation) return null;
    const cfg = this.config(orgId);
    if (!cfg.greetEnabled) return null;
    const prev = this.ms(prevContactAt);
    if (prev == null) return null; // primeiro contato: não é "retorno"
    const days = Math.floor((Date.now() - prev) / 86400000);
    return days >= cfg.greetMinDays ? days : null;
  }

  /** Bloco de memória p/ o prompt da IA (vazio quando desligado ou sem dados). */
  static memoryText(orgId: string, contactId: string, returningDays: number | null): string {
    const cfg = this.config(orgId);
    if (!cfg.memoryEnabled) return "";
    const m = this.getMemory(orgId, contactId);
    const blocks: string[] = [];
    if (m.facts && m.facts.trim()) {
      blocks.push(`MEMÓRIA DO CLIENTE (de conversas anteriores — use com naturalidade para criar conexão, sem soar invasivo):\n${m.facts.trim()}`);
    }
    if (m.summary && m.summary.trim()) {
      blocks.push(`RESUMO DA ÚLTIMA CONVERSA: ${m.summary.trim()}`);
    }
    if (returningDays != null) {
      const quando = returningDays <= 0 ? "hoje" : returningDays === 1 ? "1 dia" : `${returningDays} dias`;
      blocks.push(
        `CLIENTE QUE VOLTOU: este cliente já conversou com a gente antes e ficou ${quando} sem contato. ` +
        `ABRA a resposta com uma saudação calorosa de retorno (ex.: "${'{nome}'}, que bom te ver de novo! Faz ${quando} desde a última vez que conversamos"), ` +
        `e, se fizer sentido, puxe UM detalhe da memória acima para criar rapport (ex.: perguntar do pet/filho/como está se sentindo). ` +
        `Seja genuíno e breve; depois siga normalmente ajudando no que ele precisa. NUNCA invente detalhes que não estejam na memória.`
      );
    }
    return blocks.join("\n");
  }

  /**
   * Extrai/atualiza a memória durÁvel a partir do histórico da conversa.
   * Mescla com o que já existe (atualiza/dedup) e guarda também um resumo curto.
   * Best-effort: falha de LLM não quebra o fluxo.
   */
  static async extractAndMerge(
    orgId: string,
    contactId: string,
    history: { role: string; text: string }[],
    currentMessage?: string,
  ): Promise<void> {
    if (!this.config(orgId).memoryEnabled) return;
    const linhas = history.map(h => `${h.role}: ${h.text}`);
    if (currentMessage) linhas.push(`Cliente: ${currentMessage}`);
    if (linhas.length < 2) return; // pouco conteúdo para memória

    const prev = this.getMemory(orgId, contactId);
    const prompt = `Você mantém a MEMÓRIA DE RELACIONAMENTO de um cliente para um atendimento por WhatsApp.
A partir da conversa abaixo e da memória atual, devolva a memória ATUALIZADA: apenas fatos DURÁVEIS e úteis para criar conexão em conversas futuras.

INCLUA quando o cliente mencionar: nome próprio e de familiares/filhos, nome e tipo de pet, profissão, cidade, preferências e gostos, datas importantes (aniversário, etc.), contexto pessoal que ELE compartilhou (inclusive saúde, se ele falou), e produtos/serviços de interesse.
NÃO inclua: dados efêmeros (saudações, "ok", "obrigado"), suposições não ditas, nem dados de pagamento/sensíveis financeiros.
Consolide com a memória atual (atualize o que mudou, não duplique). Máximo 10 itens curtos, em português, um por linha começando com "- ".

MEMÓRIA ATUAL:
${prev.facts || "(vazia)"}

CONVERSA:
${linhas.join("\n")}

Responda em JSON: {"facts": "lista em bullets (string) ou vazio", "summary": "1-2 frases resumindo esta conversa"}`;

    try {
      const raw = await chat(prompt, { temperature: 0.2, json: true });
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { return; }
      const facts = typeof parsed.facts === "string" ? parsed.facts.trim() : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      // Só grava se houver algo aproveitável.
      if (!facts && !summary) {
        // marca o timestamp mesmo assim p/ não reprocessar a mesma conversa.
        db.prepare("UPDATE contacts SET memory_updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(contactId, orgId);
        return;
      }
      db.prepare(
        "UPDATE contacts SET memory_facts = ?, memory_summary = ?, memory_updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?"
      ).run(facts || prev.facts || null, summary || prev.summary || null, contactId, orgId);
    } catch (e) {
      console.error("[Memory] Falha ao extrair memória:", e);
    }
  }

  /** Apaga a memória de um contato (LGPD / "esquecer"). */
  static clear(orgId: string, contactId: string): void {
    try {
      db.prepare(
        "UPDATE contacts SET memory_facts = NULL, memory_summary = NULL, memory_updated_at = NULL WHERE id = ? AND organization_id = ?"
      ).run(contactId, orgId);
    } catch (e) { /* noop */ }
  }
}
