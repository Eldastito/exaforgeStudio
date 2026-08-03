import db from "./db.js";
import { FalaTuService, FalaTuIntent } from "./FalaTuService.js";
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
 */

// "aí" fica FORA do \b: em JS, \b é ASCII e não enxerga fronteira depois de
// "í" — "anota aí X" falharia no branch com acento e sobraria "aí X" no
// conteúdo. Strip em 2 passos: gatilho, depois muleta "aí"/"ai" opcional.
const CAPTURE_RE = /^(?:anota|anotar|falatu)\b[:,]?\s*/i;
const CAPTURE_FILLER_RE = /^a[ií](?:\s+|$)[:,]?\s*/i;
const CONFIRM_RE = /^(?:confere|confirma|confirmar)\s*$/i;
const DISCARD_RE = /^(?:descarta|descartar|ignora|ignorar)\s*$/i;

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
    if (!isCapture && !isConfirm && !isDiscard) return { handled: false, reply: "" };

    const user = GestorCommandService.resolveUser(orgId, fromNumber);
    if (!user) {
      // confere/descarta de número desconhecido não é nosso: deixa o fluxo
      // normal responder (só o gatilho explícito ganha o aviso de cadastro).
      if (!isCapture) return { handled: false, reply: "" };
      return { handled: true, reply: "Olá! Não reconheço este número. 🙋 Peça ao administrador para cadastrar seu WhatsApp em *Configurações → Usuários*." };
    }

    // confere/descarta só são nossos quando EXISTE pendência de WhatsApp —
    // senão seguem pro Coordenador (podem ser resposta de outro fluxo).
    const pending = (isConfirm || isDiscard) ? this.pendingItem(orgId, user.id) : null;
    if ((isConfirm || isDiscard) && !pending) return { handled: false, reply: "" };

    if (!PermissionService.can(orgId, user, "falatu", "write")) {
      return { handled: true, reply: "Você não tem acesso ao FalaTu nesta conta. Fale com o gestor pra liberar seu perfil." };
    }

    if (isConfirm) {
      try {
        const r = FalaTuService.confirm(orgId, user.id, pending.id, {});
        const created = r.kind === "note"
          ? "Guardei como *nota* na sua memória."
          : `Criei a *${INTENT_LABEL[(pending.intent as FalaTuIntent) || "NOTE"] || r.kind}*: ${pending.summary || pending.transcription || pending.content}`;
        return { handled: true, reply: `✅ Confere! ${created}` };
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
      lines.push("Responda *confere* pra efetivar, *descarta* pra ignorar — ou resolva no painel (aba FalaTu).");
      return { handled: true, reply: lines.join("\n") };
    } catch (e: any) {
      return { handled: true, reply: `Não consegui anotar: ${e.message}` };
    }
  }
}

export default FalaTuWhatsAppService;
