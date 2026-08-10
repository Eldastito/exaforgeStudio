import db from "./db.js";
import { FalaTuService, FalaTuIntent, FalaTuMention, parseFalaTuMemory } from "./FalaTuService.js";
import { GestorCommandService } from "./GestorCommandService.js";
import { PermissionService } from "./PermissionService.js";

/**
 * FalaTu via WhatsApp (ADR-151 Fatia 3) — captura pelo CANAL INTERNO da
 * equipe, sem webhook próprio (o webhook aberto era o achado nº 4 do
 * levantamento da origem; aqui reusamos o canal interno já autenticado por
 * número + a transcrição de áudio que o webhook roda antes do orquestrador,
 * padrão ADR-102 — voz chega aqui como texto).
 *
 * Gatilho EXPLÍCITO ("anota …" / "falatu …"): o canal interno já é disputado
 * pelo Controller (saldo/aprovações) e pelo Coordenador (tarefas), e o
 * fallback do Controller manda mensagem livre de gestor pro Diretor IA — sem
 * prefixo determinístico, a captura roubaria (ou perderia) mensagens dos
 * fluxos existentes. O webhookProcessor chama handle() ANTES do Controller
 * exatamente por isso: "anota" nunca colide com os comandos deles.
 *
 * "Fala → Faz → CONFERE" continua valendo (RN-151): a captura só registra o
 * item pendente; "confere"/"descarta" na conversa resolvem o item — e o
 * pendente é DERIVADO do banco (último item source='whatsapp' pendente do
 * usuário), nunca de estado em memória: sobrevive a restart e não divergem
 * painel e conversa. Sem item pendente, confere/descarta caem no fluxo
 * normal (handled=false) — não sequestramos palavras do Coordenador.
 *
 * Gates (mesmas 3 camadas da Fatia 2): flag `falatu_enabled` da org (sem ela
 * o gatilho passa reto, módulo invisível); RBAC nível write no módulo
 * `falatu` (PermissionService.can sobre o usuário resolvido por número, como
 * o Controller faz com `financeiro`); teto de IA do plano (o capture() já
 * enforça e conta — o reply devolve o motivo quando trava).
 *
 * Fatia 5 (desambiguação ativa): quando a captura acha 2+ candidatos na
 * memória pra uma menção ("Carlos" com Carlos Silva E Carlos Mendes), o reply
 * PERGUNTA "qual Carlos?" com opções numeradas e o humano responde "é 1"
 * (ou "é 0" = outro/novo). A resposta numérica segue a mesma regra do
 * confere/descarta: só é interceptada com pendência derivada do banco — aqui,
 * pendência COM menção ambígua em aberto.
 */

// "aí" fica FORA do \b: em JS, \b é ASCII e não enxerga fronteira depois de
// "í" — "anota aí X" falharia no branch com acento e sobraria "aí X" no
// conteúdo. Strip em 2 passos: gatilho, depois muleta "aí"/"ai" opcional.
const CAPTURE_RE = /^(?:anota|anotar|falatu)\b[:,]?\s*/i;
const CAPTURE_FILLER_RE = /^a[ií](?:\s+|$)[:,]?\s*/i;
const CONFIRM_RE = /^(?:confere|confirma|confirmar)\s*$/i;
const DISCARD_RE = /^(?:descarta|descartar|ignora|ignorar)\s*$/i;
// Fatia 5 — resposta à desambiguação ativa ("qual Carlos?"): "é 1" / "é 0".
// Só é interceptada quando EXISTE pendência de WhatsApp com menção ambígua
// sem resolução (derivada do banco) — fora disso cai no fluxo normal, então
// um "é 2" solto de outra conversa nunca é sequestrado.
const RESOLVE_RE = /^[eé]\s*(\d{1,2})\s*$/i;

const INTENT_LABEL: Record<FalaTuIntent, string> = {
  TASK: "tarefa",
  EVENT: "compromisso",
  LIST: "lista",
  NOTE: "nota",
  UNKNOWN: "nota",
};

export interface FalaTuWaResult { handled: boolean; reply: string }

export class FalaTuWhatsAppService {
  /** Último item pendente capturado via WhatsApp pelo usuário (derivado, não cacheado). */
  static pendingItem(orgId: string, userId: string): any | null {
    return db.prepare(`
      SELECT * FROM falatu_inbox_items
      WHERE organization_id = ? AND user_id = ? AND source = 'whatsapp' AND status = 'pending'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(orgId, userId) || null;
  }

  /** Primeira menção ambígua ainda sem resolução humana no item (Fatia 5). */
  static firstAmbiguous(item: any): FalaTuMention | null {
    const memory = parseFalaTuMemory(item?.memory_json);
    return memory?.mentions.find((m) => m.status === "ambiguous" && !m.resolvedEntityId && !m.resolvedNew) || null;
  }

  private static askLine(m: FalaTuMention): string {
    const opts = m.candidates.map((c, i) => `${i + 1}) ${c.name}`).join("  ");
    return `🧠 Qual *${m.mention}*? ${opts}  0) outro/novo — responda *é 1* (por ex.).`;
  }

  /**
   * Processa uma mensagem do canal interno. `handled=false` = não é assunto do
   * FalaTu (sem flag, sem gatilho, ou confere/descarta sem pendência) — o
   * webhook segue pro Controller/Coordenador como sempre. Não envia nada; quem
   * envia o `reply` é o chamador (mesmo contrato do GestorCommandService).
   */
  static async handle(orgId: string, fromNumber: string, text: string): Promise<FalaTuWaResult> {
    const raw = String(text || "").trim();
    if (!raw || !FalaTuService.orgEnabled(orgId)) return { handled: false, reply: "" };

    const isCapture = CAPTURE_RE.test(raw);
    const isConfirm = CONFIRM_RE.test(raw);
    const isDiscard = DISCARD_RE.test(raw);
    const resolveMatch = raw.match(RESOLVE_RE);
    if (!isCapture && !isConfirm && !isDiscard && !resolveMatch) return { handled: false, reply: "" };

    const user = GestorCommandService.resolveUser(orgId, fromNumber);
    if (!user) {
      // confere/descarta/é-N de número desconhecido não é nosso: deixa o fluxo
      // normal responder (só o gatilho explícito ganha o aviso de cadastro).
      if (!isCapture) return { handled: false, reply: "" };
      return { handled: true, reply: "Olá! Não reconheço este número. 🙋 Peça ao administrador para cadastrar seu WhatsApp em *Configurações → Usuários*." };
    }

    // confere/descarta/é-N só são nossos quando EXISTE pendência de WhatsApp —
    // senão seguem pro Coordenador (podem ser resposta de outro fluxo).
    const pending = (isConfirm || isDiscard || resolveMatch) ? this.pendingItem(orgId, user.id) : null;
    if ((isConfirm || isDiscard) && !pending) return { handled: false, reply: "" };
    // "é N" exige, além da pendência, uma menção ambígua em aberto — um número
    // solto sem pergunta nossa pendente segue pros outros fluxos.
    const ambiguous = resolveMatch && pending ? this.firstAmbiguous(pending) : null;
    if (resolveMatch && !isConfirm && !isDiscard && !ambiguous) return { handled: false, reply: "" };

    if (!PermissionService.can(orgId, user, "falatu", "write")) {
      return { handled: true, reply: "Você não tem acesso ao FalaTu nesta conta. Fale com o gestor pra liberar seu perfil." };
    }

    if (resolveMatch && ambiguous && pending) {
      const n = parseInt(resolveMatch[1], 10);
      if (n > ambiguous.candidates.length) {
        return { handled: true, reply: `Opção inválida. ${this.askLine(ambiguous)}` };
      }
      try {
        const chosen = n === 0 ? null : ambiguous.candidates[n - 1];
        const updated = FalaTuService.resolveMention(orgId, user.id, pending.id, ambiguous.mention, chosen ? chosen.id : null);
        const next = this.firstAmbiguous(updated);
        const lines = [`🧠 Anotado: *${ambiguous.mention}* ${chosen ? `é *${chosen.name}*` : "é outra pessoa/projeto (vou criar na memória)"}.`];
        lines.push(next ? this.askLine(next) : "Responda *confere* pra efetivar ou *descarta* pra ignorar.");
        return { handled: true, reply: lines.join("\n") };
      } catch (e: any) {
        return { handled: true, reply: `Não consegui registrar a escolha: ${e.message}` };
      }
    }

    if (isConfirm) {
      try {
        const r = FalaTuService.confirm(orgId, user.id, pending.id, {});
        const created = r.kind === "note"
          ? "Guardei como *nota* na sua memória."
          : `Criei a *${INTENT_LABEL[(pending.intent as FalaTuIntent) || "NOTE"] || r.kind}*: ${pending.summary || pending.transcription || pending.content}`;
        // ADR-160 F8 — porta I/O observável no WhatsApp: quando o choke-point
        // espelhou no domínio canônico, o operador vê o desfecho (mesma
        // materialização do painel — paridade de canal).
        const bridged: string[] = [];
        if (r.bridgedTaskId) bridged.push("📋 também entrou no seu quadro de tarefas");
        if (r.bridgedRequisitionId) bridged.push("🛒 itens do catálogo entraram na *requisição de compras* (rascunho — aprove no painel)");
        const tail = bridged.length ? `\n${bridged.join("\n")}.` : "";
        return { handled: true, reply: `✅ Confere! ${created}${tail}` };
      } catch (e: any) {
        return { handled: true, reply: `Não consegui confirmar: ${e.message}` };
      }
    }

    if (isDiscard) {
      try {
        FalaTuService.discard(orgId, user.id, pending.id);
        return { handled: true, reply: `🗑️ Descartado: ${pending.summary || pending.content || "item"}.` };
      } catch (e: any) {
        return { handled: true, reply: `Não consegui descartar: ${e.message}` };
      }
    }

    // ── Captura ──
    const content = raw.replace(CAPTURE_RE, "").replace(CAPTURE_FILLER_RE, "").trim();
    if (!content) {
      return { handled: true, reply: "Manda junto o que é pra anotar. 😉 Ex.: *anota ligar pro contador amanhã* — pode ser áudio também." };
    }
    try {
      const item = await FalaTuService.capture(orgId, user.id, { text: content, source: "whatsapp" });
      // F8.7 — a captura pode ter sido reconhecida como PROTOCOLO (regra de
      // código dentro do capture): responde o desfecho e não trata como nota.
      const proto = (item as any)?.protocol;
      if (proto) {
        if (proto.kind === "activated") return { handled: true, reply: `🚨 Protocolo *${proto.name}* ativado — seu telefone vai tocar em ${proto.delayMinutes} min. Diga *cancela o protocolo* pra abortar.` };
        if (proto.kind === "ambiguous") return { handled: true, reply: `Qual protocolo? Você tem: ${proto.names.map((n: string) => `*${n}*`).join(", ")}. Fala o nome completo.` };
        if (proto.kind === "unverified") return { handled: true, reply: `O protocolo *${proto.name}* existe, mas o número ainda não foi verificado — confirme no app (aba Protocolos) antes de usar.` };
        if (proto.kind === "cancelled") return { handled: true, reply: `✅ Protocolo cancelado — a ligação não vai acontecer.` };
        if (proto.kind === "nothing_to_cancel") return { handled: true, reply: `Não tinha protocolo agendado pra cancelar.` };
      }
      const label = INTENT_LABEL[(item.intent as FalaTuIntent) || "NOTE"] || "nota";
      const lines = [`📥 Anotado! Entendi como *${label}*: ${item.summary || content}`];
      // RN-151: compromisso sem data explícita fica sem data — avisamos em vez
      // de inventar (o humano completa no painel ou dita a data e recaptura).
      if (item.intent === "EVENT") {
        let ents: any = {};
        try { ents = JSON.parse(item.entities_json || "{}"); } catch { /* noop */ }
        lines.push(ents?.eventDate ? `🗓️ ${ents.eventDate}${ents.eventTime ? ` às ${ents.eventTime}` : ""}` : "🗓️ Sem data explícita — não invento: complete na confirmação do painel, ou descarta e dita com a data.");
      }
      if (Number(item.confidence) < 0.5) lines.push("🤔 Não tenho muita certeza dessa interpretação — vale conferir no painel.");
      // Fatia 5 — memória: transparência do auto-vínculo (match único) e
      // pergunta ativa quando há 2+ candidatos ("qual Carlos?").
      const memory = parseFalaTuMemory(item.memory_json);
      for (const m of memory?.mentions || []) {
        if (m.status === "known" && m.resolvedEntityId) {
          const linked = m.candidates.find((c) => c.id === m.resolvedEntityId);
          if (linked && linked.name !== m.mention) lines.push(`🧠 *${m.mention}* → *${linked.name}* (da sua memória).`);
        }
      }
      const ask = this.firstAmbiguous(item);
      if (ask) lines.push(this.askLine(ask));
      lines.push("Responda *confere* pra efetivar, *descarta* pra ignorar — ou resolva no painel (aba FalaTu).");
      return { handled: true, reply: lines.join("\n") };
    } catch (e: any) {
      return { handled: true, reply: `Não consegui anotar: ${e.message}` };
    }
  }
}

export default FalaTuWhatsAppService;
