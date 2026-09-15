/**
 * StudioWhatsAppCommandService — WZ-1: comando de TAREFA "gere uma imagem…"
 * pelo WhatsApp de gestão (PRD WhatsApp Unificado, backlog do piloto 15/09/2026).
 *
 * Fluxo: gestor autorizado manda "Zapp, gere uma imagem de X" no canal interno /
 * modo misto → a IA encaminha pro Estúdio de Criação (`StudioService.generate`,
 * plan-gated) → a arte volta pelo PRÓPRIO WhatsApp como imagem nativa (fallback
 * declarado pro link — molde do PDF do Zapp gestor no webhookProcessor).
 *
 * Guardrails:
 * - Gatilho DETERMINÍSTICO (regex explícita verbo+«imagem»), nunca inferência de
 *   linguagem natural (RN-151) — pergunta aberta segue pro Diretor IA intacta.
 * - Só é chamado no caminho INTERNO (runInternalInbound): quem chega aqui já é
 *   gestor autorizado / canal interno; nenhum cliente aciona o Estúdio.
 * - Honesto: sem briefing → pergunta; limite/plano/IA indisponível → repassa a
 *   mensagem real do Estúdio; sem APP_URL → diz que a arte está no Estúdio (a
 *   Evolution baixa a mídia server-to-server, precisa de URL absoluta).
 * - Reusa o sink único de envio (`MessageProviderService.sendImage`, finalidade
 *   `gestao`) — sem 2º caminho de envio (§42/§184).
 * - Deps injetáveis (generate/sendImage/sendMessage) → teste roda em CI sem IA.
 */
import { MessageProviderService } from "./MessageProviderService.js";
import { StudioService, type StudioFormat } from "./StudioService.js";

export interface StudioCommandParse {
  intent: "generate_image" | "ask_briefing" | "none";
  briefing?: string;
  format?: StudioFormat;
}

export interface StudioCommandDeps {
  generate?: (orgId: string, briefing: string, format: StudioFormat) => Promise<{ id: string; mediaUrl: string; prompt: string }>;
  sendImage?: (channelId: string, to: string, url: string, caption?: string, opts?: any) => Promise<any>;
  sendMessage?: (channelId: string, to: string, text: string, opts?: any) => Promise<any>;
}

// Verbos de geração aceitos (explícitos — "anota comprar imagem" NÃO casa).
const TRIGGER = /^(?:zapp[\s,:!.-]*)?\s*(?:gera|gere|cria|crie|criar|faz|faça|fazer|monta|monte|desenha|desenhe|quero)\s+(?:uma?\s+|a\s+)?(?:imagem|arte|foto)\b\s*(.*)$/i;

export class StudioWhatsAppCommandService {
  /** Parser puro/determinístico do comando. */
  static parse(text: string): StudioCommandParse {
    const t = String(text || "").trim();
    const m = t.match(TRIGGER);
    if (!m) return { intent: "none" };
    let rest = (m[1] || "").trim();
    // Formato opcional dito pelo gestor ("… imagem story de …").
    let format: StudioFormat = "post";
    const fm = rest.match(/^(story|stories|banner|post)\b\s*/i);
    if (fm) {
      const f = fm[1].toLowerCase();
      format = f === "banner" ? "banner" : f.startsWith("stor") ? "story" : "post";
      rest = rest.slice(fm[0].length).trim();
    }
    // Conectivo inicial ("de", "do", "com", "pra"…) não faz parte do briefing.
    rest = rest.replace(/^(?:de|do|da|dos|das|com|sobre|para|pra|mostrando|:)\s+/i, "").trim();
    if (!rest) return { intent: "ask_briefing", format };
    return { intent: "generate_image", briefing: rest, format };
  }

  /**
   * Trata a mensagem se for comando de imagem. `handled:false` = não é comando
   * (o caller segue o fluxo normal: Controller/Diretor/Coordenador).
   */
  static async handle(
    orgId: string,
    channelId: string,
    senderId: string,
    text: string,
    deps?: StudioCommandDeps,
  ): Promise<{ handled: boolean; outcome?: "sent" | "link_fallback" | "no_app_url" | "asked_briefing" | "error" }> {
    const parsed = this.parse(text);
    if (parsed.intent === "none") return { handled: false };

    const send = deps?.sendMessage
      || ((cid: string, to: string, msg: string) => MessageProviderService.sendMessage(cid, to, msg, { feature: "gestao" }));

    if (parsed.intent === "ask_briefing") {
      await send(channelId, senderId, "🎨 Claro! Me diz o que a imagem deve mostrar. Ex.: *gere uma imagem de vestido azul em promoção com fundo claro*.");
      return { handled: true, outcome: "asked_briefing" };
    }

    await send(channelId, senderId, "🎨 Gerando sua imagem no Estúdio de Criação… isso leva até 1 minuto.");
    let creation: { id: string; mediaUrl: string; prompt: string };
    try {
      const generate = deps?.generate || ((o: string, b: string, f: StudioFormat) => StudioService.generate(o, b, f));
      creation = await generate(orgId, parsed.briefing!, parsed.format || "post");
    } catch (e: any) {
      // Mensagens do Estúdio já são honestas e em PT-BR (limite do plano, IA fora).
      await send(channelId, senderId, `Não consegui gerar a imagem: ${e?.message || "erro no Estúdio"}.`);
      return { handled: true, outcome: "error" };
    }

    // A Evolution baixa a mídia server-to-server → precisa de URL ABSOLUTA.
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    if (!base) {
      await send(channelId, senderId, "✅ Imagem gerada e salva no *Estúdio de Criação* (menu Estúdio). Não consegui enviá-la por aqui porque o servidor está sem APP_URL configurada.");
      return { handled: true, outcome: "no_app_url" };
    }
    const absoluteUrl = `${base}${creation.mediaUrl}`;
    const caption = `🎨 Pronto! Sua arte: ${parsed.briefing}\n(também salva no Estúdio de Criação)`;
    try {
      const sendImage = deps?.sendImage
        || ((cid: string, to: string, url: string, cap?: string) => MessageProviderService.sendImage(cid, to, url, cap, { feature: "gestao" }));
      await sendImage(channelId, senderId, absoluteUrl, caption);
      return { handled: true, outcome: "sent" };
    } catch (e) {
      // Fallback DECLARADO (nunca finge que anexou — molde F5.3).
      console.error("[Estúdio] Envio nativo da imagem falhou, usando link:", e);
      await send(channelId, senderId, `✅ Imagem gerada! Não consegui anexar aqui, mas ela está neste link:\n${absoluteUrl}\n(também salva no Estúdio de Criação)`);
      return { handled: true, outcome: "link_fallback" };
    }
  }
}
