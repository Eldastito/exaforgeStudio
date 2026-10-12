import db from "./db.js";
import { InstagramService } from "./InstagramService.js";
import { FacebookService } from "./FacebookService.js";
import { SocialConnectionService } from "./SocialConnectionService.js";
import { BrandDnaService } from "./BrandDnaService.js";
import { CampaignObjectiveContractService } from "./CampaignObjectiveContractService.js";
import { SocialProactivityService } from "./SocialProactivityService.js";
import { StudioBriefService } from "./StudioBriefService.js";
import { EditorialCalendarService } from "./EditorialCalendarService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { CreativeLearningService } from "./CreativeLearningService.js";
import { InstagramCommentIntentService } from "./InstagramCommentIntentService.js";
import { StorefrontAttributionService } from "./StorefrontAttributionService.js";
import { PaidMediaService } from "./PaidMediaService.js";

/**
 * GrowthEngineService (ADR-207 F11) — "Motor de Crescimento": UMA tela que mostra o ciclo
 * Radar → Criar → Aprovar → Programados → Resultados → Aprendizados + o "primeiro acesso" (ativação).
 *
 * É COMPOSIÇÃO e apresentação (PRD: "uma experiência, não um novo motor"): nenhum Scheduler, Estúdio, Decision Engine, memória,
 * tabela ou regra nova. Cada seção só LÊ o que os serviços existentes já produzem (ADR-166/167/168 + F1–F10 desta frente) e
 * degrada sozinha: se uma fonte falhar, aquela seção vem `available:false` com o motivo — a tela não cai inteira.
 *
 * Regras: read-only (não propõe, não aprova, não publica — as ações continuam nas rotas governadas existentes) · ativação
 * DERIVADA (sem flag nova: "ligado" é o que de fato está configurado) · honesto (sem dado → vazio/“—”, nunca inventa ideia,
 * resultado ou dinheiro) · fato ≠ estimativa (resultado vem de pedido pago/atribuição; o plano de mídia não entra aqui) ·
 * dinheiro só dono/admin (a ROTA é restrita).
 */
type Section<T> = ({ available: true } & T) | { available: false; reason: string };

const safe = <T>(fn: () => T): Section<T extends object ? T : { value: T }> => {
  try { const v: any = fn(); return { available: true, ...(v && typeof v === "object" ? v : { value: v }) } as any; }
  catch (e: any) { return { available: false, reason: String(e?.message || "indisponível").slice(0, 120) }; }
};

export interface ActivationStep { key: "channel" | "brand" | "objective" | "store"; label: string; done: boolean; required: boolean; detail: string; where: string }

export class GrowthEngineService {
  // ───────── ativação (primeiro acesso) ─────────
  static async activation(orgId: string) {
    const channels: string[] = [];
    try { if (InstagramService.isConnected(orgId)) channels.push("Instagram"); } catch { /* sem conexão */ }
    try { if (FacebookService.isConnected(orgId)) channels.push("Facebook"); } catch { /* sem conexão */ }
    try {
      for (const c of SocialConnectionService.list(orgId)) {
        if (c.state === "connected" && c.channel !== "stub" && c.channel !== "instagram" && c.channel !== "facebook") channels.push(c.channel);
      }
    } catch { /* sem hub */ }

    // "Marca preenchida" = pelo menos 3 dos campos de identidade (persona, público, posicionamento, voz, tom…): o mínimo para o conteúdo ter a cara da marca.
    const BRAND_MIN_FIELDS = 3;
    let filledFields = 0, totalFields = 11;
    try { const d = await BrandDnaService.get(orgId); totalFields = BrandDnaService.identityFieldCount(); filledFields = Math.round(d.completeness * totalFields); } catch { /* sem DNA */ }
    let objectives = 0;
    try { objectives = CampaignObjectiveContractService.list(orgId, { status: "active" }).length; } catch { /* sem contrato */ }
    const store = db.prepare("SELECT slug FROM storefront_settings WHERE organization_id = ? AND published = 1").get(orgId) as any;

    const steps: ActivationStep[] = [
      { key: "channel", label: "Conectar onde você publica", required: true, done: channels.length > 0, where: "channels",
        detail: channels.length ? `Conectado: ${channels.join(", ")}.` : "Nenhum canal conectado. Conecte o Instagram ou o Facebook em Canais." },
      { key: "brand", label: "Dizer quem é a marca", required: true, done: filledFields >= BRAND_MIN_FIELDS, where: "studio",
        detail: filledFields >= BRAND_MIN_FIELDS ? `Identidade da marca: ${filledFields} de ${totalFields} campos preenchidos.` : `Preencha ao menos ${BRAND_MIN_FIELDS} campos da identidade da marca (voz, público, posicionamento…) — hoje ${filledFields} de ${totalFields}.` },
      { key: "objective", label: "Escolher o que a campanha deve gerar", required: true, done: objectives > 0, where: "studio",
        detail: objectives > 0 ? `${objectives} objetivo${objectives > 1 ? "s" : ""} de campanha ativo${objectives > 1 ? "s" : ""}.` : "Escolha um objetivo (vender, gerar contatos…) para medir pelo resultado, não pelo like." },
      { key: "store", label: "Publicar a loja virtual (para vender)", required: false, done: !!store, where: "storefront",
        detail: store ? "Loja virtual publicada: os posts podem levar direto à compra." : "Sem loja publicada, o conteúdo não tem para onde levar a venda (opcional)." },
    ];
    const missing = steps.filter((s) => s.required && !s.done);
    const ready = missing.length === 0;
    const next = missing[0] || steps.find((s) => !s.done) || null;
    return {
      steps, ready, next: next ? { key: next.key, label: next.label, detail: next.detail, where: next.where } : null,
      message: ready ? "Motor ativado: já dá para criar, aprovar e acompanhar o resultado." : `Falta ${missing.length === 1 ? "1 passo" : `${missing.length} passos`} para ativar o Motor.`,
    };
  }

  // ───────── a tela inteira ─────────
  static async overview(orgId: string) {
    const activation = await this.activation(orgId);

    const radar = safe(() => {
      const brief = SocialProactivityService.growthBrief(orgId);
      let commentsToAnswer = 0;
      try {
        const l = InstagramCommentIntentService.list(orgId, { status: "new", limit: 200 });
        commentsToAnswer = (l.comments as any[]).filter((c) => ["price", "availability", "buy"].includes(c.intent)).length;
      } catch { /* leitura de comentários desligada/indisponível */ }
      return { whatToPost: brief.whatToPost.slice(0, 8), commentsToAnswer };
    });

    const create = safe(() => {
      const briefs = StudioBriefService.listOpportunities(orgId).slice(0, 5).map((o) => {
        const b = StudioBriefService.fromOpportunity(orgId, o.signalId);
        return { signalId: o.signalId, topic: o.topic, vertical: o.vertical, channel: o.channel, briefingText: b?.briefingText ?? null };
      }).filter((b) => b.briefingText);
      return { briefs };
    });

    const approve = safe(() => {
      const pending = (DecisionActionService.list(orgId, { status: "awaiting_approval", domain: "social" }) as any[])
        .filter((a) => a.action_type === "social_publish").slice(0, 20)
        .map((a) => { let channel: string | null = null; try { channel = JSON.parse(a.command_payload_json || "{}").channel ?? null; } catch { /* noop */ } return { actionId: a.id, title: a.title || "Publicação", channel }; });
      const approvedToPublish = (DecisionActionService.list(orgId, { status: "approved", domain: "social" }) as any[])
        .filter((a) => a.action_type === "social_publish").slice(0, 20)
        .map((a) => { let channel: string | null = null; try { channel = JSON.parse(a.command_payload_json || "{}").channel ?? null; } catch { /* noop */ } return { actionId: a.id, title: a.title || "Publicação", channel }; });
      const drafts = EditorialCalendarService.calendar(orgId).filter((e) => e.status === "draft").slice(0, 20);
      return { pending, approvedToPublish, drafts };
    });

    const scheduled = safe(() => ({ entries: EditorialCalendarService.calendar(orgId).filter((e) => e.status === "scheduled").slice(0, 20) }));

    const results = safe(() => {
      const digest = SocialProactivityService.digest(orgId);
      const brief = SocialProactivityService.growthBrief(orgId);
      let campaigns: any[] = [];
      try {
        campaigns = StorefrontAttributionService.funnel(orgId, { days: 30 }).attributed.filter((r) => r.campaign).slice(0, 5)
          .map((r) => ({ campaign: r.campaign, source: r.source, views: r.views, paidOrders: r.paidOrders, revenuePaid: r.revenuePaid, marginPaid: r.marginPaid }));
      } catch { /* sem funil */ }
      let media: any[] = [];
      try { media = PaidMediaService.results(orgId, { days: 30 }).campaigns.slice(0, 5).map((c) => ({ campaign: c.campaign, spend: c.spend, roas: c.roas, profit: c.profit, poas: c.poas })); } catch { /* sem mídia */ }
      return { measured: digest.recentResults, goals: brief.goals, campaigns, media };
    });

    const learnings = safe(() => {
      const brief = SocialProactivityService.growthBrief(orgId);
      const learning = CreativeLearningService.effectiveness(orgId)
        .map((e: any) => ({ patternType: e.pattern_type || e.patternType, effectiveness: e.effectiveness ?? null, acted: Number(e.acted) || 0 }))
        .sort((a, b) => (b.effectiveness ?? 0) - (a.effectiveness ?? 0)).slice(0, 5);
      return { learning, champions: brief.champions };
    });

    const counts = {
      ideas: radar.available ? radar.whatToPost.length : 0,
      approvals: approve.available ? approve.pending.length + approve.drafts.length : 0,
      scheduled: scheduled.available ? scheduled.entries.length : 0,
    };
    const parts: string[] = [];
    if (counts.ideas) parts.push(`${counts.ideas} ideia${counts.ideas > 1 ? "s" : ""} pra postar`);
    if (counts.approvals) parts.push(`${counts.approvals} pra aprovar`);
    if (counts.scheduled) parts.push(`${counts.scheduled} programado${counts.scheduled > 1 ? "s" : ""}`);
    return {
      activation, radar, create, approve, scheduled, results, learnings,
      headline: activation.ready ? (parts.join(" · ") || "Tudo em dia: nada novo para decidir agora.") : activation.message,
      note: "Esta tela só mostra o que o sistema já produz; aprovar e publicar continuam passando pela governança de sempre.",
    };
  }
}

export default GrowthEngineService;
