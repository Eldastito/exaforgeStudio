import db from "./db.js";
import { CampaignService } from "./CampaignService.js";
import { CampaignAiCostService } from "./CampaignAiCostService.js";
import { BrandDnaService } from "./BrandDnaService.js";
import { LgpdService } from "./LgpdService.js";
import { ensureProductSlug } from "./productSlug.js";

/**
 * ContentBroadcastService (ADR-207 F13a) — conteúdo aprovado → mensagem de WhatsApp / e-mail, reaproveitando o que já foi criado.
 *
 * Só PREPARA. Nunca envia:
 *  - WHATSAPP: cria um RASCUNHO de campanha no motor de Campanhas que já existe (`CampaignService`: anti-ban, limite diário, opt-out,
 *    guarda de consentimento no envio). Quem dispara é uma pessoa, na tela de Campanhas — essa é a aprovação humana (mesmo padrão do RIC).
 *  - E-MAIL: devolve assunto + corpo prontos e a contagem do público. NÃO há envio de e-mail em massa para clientes no sistema (o
 *    transporte existente é só para o e-mail do próprio usuário) e enviar exige link de descadastro; isso é outra fatia. Aqui o dono
 *    copia o texto e usa a ferramenta dele.
 *
 * Regras:
 *  - Público = quem a empresa PODE contatar: segmento do CRM ∩ sem `marketing_opt_out` ∩ com consentimento `comunicacoes` registrado.
 *    Sem prova de consentimento, fora (nunca presume; não há opção de afrouxar). Mostra quantos ficaram de fora e por quê.
 *  - O texto sai do conteúdo que o DONO escreveu/aprovou (legenda do calendário). Hashtags saem (não fazem sentido numa mensagem direta);
 *    termos PROIBIDOS pela marca (Brand DNA) recusam a geração (não adivinha reescrita). Nada de IA aqui.
 *  - O link leva à loja com a origem (`zf_source=whatsapp|email`, `zf_campaign`, `zf_content`) → o funil da F1, a origem do contato (F2)
 *    e o resultado da F10 enxergam a venda. Sem loja publicada, vai sem link (dito).
 *  - A mensagem de WhatsApp termina com a instrução real de descadastro ("responda SAIR" — já tratada pelo webhook).
 *  - Idempotente: o mesmo conteúdo + canal não cria um 2º rascunho enquanto houver um rascunho/em andamento.
 *  - Isolado por empresa; sem dinheiro na resposta.
 */
export type BroadcastChannel = "whatsapp" | "email";
const MAX_RECIPIENTS = 500;
const WA_MAX = 600;
const EMAIL_MAX = 1200;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export class ContentBroadcastService {
  /** Legenda → texto de mensagem direta: sem hashtags, espaços limpos, tamanho limitado (corta em frase quando dá). */
  static cleanText(caption: string, max: number): string {
    const t = String(caption || "").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
    return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
  }

  private static link(orgId: string, channel: BroadcastChannel, campaign: string, entryId: string, productId?: string | null): string | null {
    const store = db.prepare("SELECT slug FROM storefront_settings WHERE organization_id = ? AND published = 1").get(orgId) as any;
    if (!store?.slug) return null;
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    let path = `/loja/${encodeURIComponent(store.slug)}`;
    if (productId) {
      const p = db.prepare("SELECT id, name, slug FROM products_services WHERE id = ? AND organization_id = ? AND active = 1").get(productId, orgId) as any;
      if (!p) throw new Error("Produto não encontrado nesta empresa.");
      path += `/produto/${encodeURIComponent(ensureProductSlug(orgId, p))}`;
    }
    return `${base}${path}?zf_source=${channel}&zf_campaign=${encodeURIComponent(campaign)}&zf_content=${encodeURIComponent(entryId.slice(0, 8))}`;
  }

  /** Público alcançável: segmento do CRM ∩ sem opt-out ∩ (consentimento registrado, se exigido). Sem R$, sem dados pessoais na resposta. */
  static audience(orgId: string, channel: BroadcastChannel, segment: any, requireConsent: boolean) {
    const base = CampaignService.resolveSegment(orgId, segment || {});          // já exclui marketing_opt_out e exige identifier
    let pool = base as Array<{ id: string; name: string; identifier: string; email?: string | null }>;
    if (channel === "email") {
      const ids = pool.map((c) => c.id);
      const withEmail = ids.length ? (db.prepare(`SELECT id, email FROM contacts WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND email IS NOT NULL AND TRIM(email) <> ''`).all(orgId, ...ids) as any[]) : [];
      const has = new Set(withEmail.map((r) => r.id));
      pool = pool.filter((c) => has.has(c.id));
    }
    const consented = requireConsent ? pool.filter((c) => LgpdService.hasConsent(orgId, c.id, "comunicacoes")) : pool;
    const included = consented.slice(0, MAX_RECIPIENTS);
    return {
      list: included,
      summary: {
        inSegment: base.length,
        reachableByChannel: pool.length,                                       // e-mail: só quem tem e-mail cadastrado
        withoutConsent: requireConsent ? pool.length - consented.length : 0,
        included: included.length,
        truncated: consented.length > MAX_RECIPIENTS,
        requireConsent,
      },
    };
  }

  private static existing(orgId: string, entryId: string, channel: BroadcastChannel) {
    if (channel !== "whatsapp") return null;
    const rows = db.prepare("SELECT id, status, segment FROM campaigns WHERE organization_id = ? AND status IN ('draft','running','paused') AND segment LIKE ?").all(orgId, `%"entryId":"${entryId}"%`) as any[];
    for (const r of rows) { try { const s = JSON.parse(r.segment || "{}"); if (s.source === "content" && s.entryId === entryId) return r; } catch { /* noop */ } }
    return null;
  }

  static async draft(orgId: string, actorId: string | null, input: { entryId: string; channel: BroadcastChannel; productId?: string | null; campaign?: string | null; segment?: any; dryRun?: boolean }) {
    const channel = input.channel;
    if (channel !== "whatsapp" && channel !== "email") throw new Error("Canal inválido (use whatsapp ou email).");
    const entry = db.prepare("SELECT id, caption, status, objective FROM scheduled_posts WHERE id = ? AND organization_id = ?").get(String(input.entryId || ""), orgId) as any;
    if (!entry) throw new Error("Conteúdo não encontrado.");
    if (entry.status === "canceled") throw new Error("Este conteúdo foi cancelado.");
    if (!String(entry.caption || "").trim()) throw new Error("O conteúdo não tem texto (legenda) para virar mensagem.");
    const requireConsent = true;          // sempre: só quem tem consentimento de comunicação registrado (nunca presume; sem opção de afrouxar)

    // Marca: termo proibido recusa (não tenta reescrever).
    try {
      const dna = await BrandDnaService.get(orgId);
      const low = String(entry.caption).toLowerCase();
      const hit = (dna.forbidden || []).find((t: string) => t && low.includes(String(t).toLowerCase()));
      if (hit) throw new Error(`O texto contém um termo que a marca proíbe ("${hit}"). Ajuste a legenda antes de transformar em mensagem.`);
    } catch (e: any) { if (/proíbe/.test(String(e?.message))) throw e; /* sem DNA: segue */ }

    const campaign = CampaignAiCostService.slug(input.campaign) || `conteudo-${entry.id.slice(0, 8)}`;
    const link = this.link(orgId, channel, campaign, entry.id, input.productId);
    const aud = this.audience(orgId, channel, input.segment, requireConsent);
    const caveats: string[] = [];
    if (!link) caveats.push("Sem loja publicada: a mensagem vai sem link de compra.");
    if (aud.summary.withoutConsent > 0) caveats.push(`${aud.summary.withoutConsent} contato(s) ficaram de fora por não terem consentimento de comunicação registrado.`);
    if (aud.summary.truncated) caveats.push(`Público limitado a ${MAX_RECIPIENTS} contatos por rascunho.`);

    if (channel === "email") {
      const body = this.cleanText(entry.caption, EMAIL_MAX);
      const subject = (body.split(/\n|(?<=[.!?])\s/)[0] || "Novidade").replace(/\s+/g, " ").slice(0, 70);
      const text = `Olá,\n\n${body}${link ? `\n\n${link}` : ""}\n\nSe não quiser mais receber nossos e-mails, responda esta mensagem pedindo o descadastro.`;
      const html = `<p>Olá,</p>${body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}${link ? `<p><a href="${esc(link)}">Ver na loja</a></p>` : ""}<p style="color:#666;font-size:12px">Se não quiser mais receber nossos e-mails, responda pedindo o descadastro.</p>`;
      return { channel, sendable: false, created: false, subject, text, html, campaign, link, audience: aud.summary, caveats: [...caveats, "O ZapFlow não envia e-mail em massa: copie o texto e use sua ferramenta de e-mail (inclua sempre o descadastro)."] };
    }

    const text = this.cleanText(entry.caption, WA_MAX);
    const message = `Oi {nome}! ${text}${link ? `\n\n${link}` : ""}\n\nPara não receber mais mensagens, responda SAIR.`;
    const dup = this.existing(orgId, entry.id, channel);
    if (input.dryRun) return { channel, sendable: true, created: false, dryRun: true, message, campaign, link, audience: aud.summary, existingCampaignId: dup?.id ?? null, caveats };
    if (dup) return { channel, sendable: true, created: false, existingCampaignId: dup.id, message, campaign, link, audience: aud.summary, caveats: [...caveats, "Já existe um rascunho/envio em andamento para este conteúdo; nada foi duplicado."] };
    if (!aud.list.length) return { channel, sendable: true, created: false, reason: "no_reachable_recipients", message, campaign, link, audience: aud.summary, caveats: [...caveats, aud.summary.requireConsent ? "Nenhum contato do segmento tem consentimento de comunicação registrado." : "Nenhum contato alcançável no segmento."] };

    const made = CampaignService.createCampaignForContacts(orgId, { name: `Conteúdo · ${campaign}`, message, contactIds: aud.list.map((c) => c.id), createdBy: actorId || undefined });
    if (!made.id) return { channel, sendable: true, created: false, reason: "no_reachable_recipients", message, campaign, link, audience: aud.summary, caveats };
    db.prepare("UPDATE campaigns SET segment = ? WHERE id = ? AND organization_id = ?").run(JSON.stringify({ source: "content", entryId: entry.id, channel, campaign, requireConsent }), made.id, orgId);
    return { channel, sendable: true, created: true, campaignId: made.id, status: "draft", message, campaign, link, audience: { ...aud.summary, included: made.total }, caveats: [...caveats, "Rascunho criado em Campanhas. Revise e dispare por lá — nada foi enviado."] };
  }
}

export default ContentBroadcastService;
