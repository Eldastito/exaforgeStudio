/**
 * SocialProactivityService (PRD 10 / ADR-167 F14 — Fala Tu + Radar + Proatividade) —
 * a fatia SOCIAL entra nas superfícies proativas EXISTENTES (§42 — sem nova superfície).
 * A oportunidade (F7) já flui pro `attention()`/Smart Inbox e a publicação governada
 * (F11) já aparece como aprovação pendente; este service só COMPÕE um DIGEST humano da
 * fatia social pra o "Hoje" do Fala Tu / Radar, reusando os serviços canônicos:
 *   - oportunidades de conteúdo abertas (F7 via `StudioBriefService.listOpportunities`);
 *   - publicações aguardando SUA aprovação (F11 via `DecisionActionService.list`);
 *   - resultados recentes medidos (F12 via `SocialAttributionService.attribution`);
 *   - o que vem funcionando (F13 via `CreativeLearningService.effectiveness`).
 *
 * Read-only/determinístico; sem tabela nova. HONESTO: só mostra o que existe (oportunidade
 * fresca, aprovação real, engajamento medido) — nunca inventa. Isolamento (convenção #1).
 * As preferências do dono (quiet-hours / limiar de alerta, PRD 6) seguem sendo aplicadas
 * pelo `FalaTuProactiveService.selectUrgent` — este digest é a LEITURA, não o push.
 */
import { StudioBriefService } from "./StudioBriefService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { SocialAttributionService } from "./SocialAttributionService.js";
import { CreativeLearningService } from "./CreativeLearningService.js";
import { ProductOpportunityService } from "./ProductOpportunityService.js";
import { BusinessGoalService } from "./BusinessGoalService.js";
import { CreativeExperimentService } from "./CreativeExperimentService.js";

export interface SocialProactiveDigest {
  opportunities: Array<{ signalId: string; vertical: string | null; topic: string | null; channel: string | null; summary: string | null }>;
  pendingApprovals: Array<{ actionId: string; title: string; channel: string | null }>;
  recentResults: Array<{ actionId: string; variantKey: string | null; channel: string | null; engagement: number }>;
  learning: Array<{ patternType: string; effectiveness: number | null; acted: number }>;
  headline: string | null;
}

// Métricas de crescimento por conteúdo (F12) que entram no brief.
const GROWTH_METRICS = new Set(["content_revenue", "content_leads"]);

export interface GrowthBrief {
  whatToPost: Array<{ kind: "content" | "product"; ref: string; label: string; reason: string; marginBand?: string }>;
  goals: Array<{ metric: string; label: string; unit: string; target: number; current: number; remaining: number; attainmentPct: number; paceStatus: string }>;
  champions: Array<{ experimentId: string; hypothesis: string; winnerVariantKey: string | null }>;
  headline: string | null;
}

export class SocialProactivityService {
  static digest(orgId: string): SocialProactiveDigest {
    // 1. Oportunidades de conteúdo abertas (F7).
    const opportunities = StudioBriefService.listOpportunities(orgId).map((o) => ({
      signalId: o.signalId, vertical: o.vertical, topic: o.topic, channel: o.channel,
      summary: o.summary || (o.topic ? `Oportunidade de conteúdo sobre "${o.topic}"${o.vertical ? ` no nicho ${o.vertical}` : ""}.` : null),
    }));

    // 2. Publicações aguardando aprovação (F11) — governança na superfície proativa.
    const pendingApprovals = DecisionActionService.list(orgId, { status: "awaiting_approval", domain: "social" })
      .filter((a: any) => a.action_type === "social_publish")
      .map((a: any) => {
        let channel: string | null = null;
        try { channel = JSON.parse(a.command_payload_json || "{}").channel ?? null; } catch { /* noop */ }
        return { actionId: a.id, title: a.title || "Publicação", channel };
      });

    // 3. Resultados recentes MEDIDOS (F12) — só o que tem engajamento de fato.
    const recentResults = SocialAttributionService.attribution(orgId)
      .filter((r) => r.measured && typeof r.engagement === "number")
      .slice(0, 5)
      .map((r) => ({ actionId: r.actionId, variantKey: r.variantKey, channel: r.channel, engagement: Number(r.engagement) }));

    // 4. O que vem funcionando (F13) — ângulos/formatos com maior eficácia aprendida.
    const learning = CreativeLearningService.effectiveness(orgId)
      .map((e: any) => ({ patternType: e.pattern_type || e.patternType, effectiveness: e.effectiveness ?? null, acted: Number(e.acted) || 0 }))
      .sort((a, b) => (b.effectiveness ?? 0) - (a.effectiveness ?? 0))
      .slice(0, 5);

    // Headline humana (§44) — só fala do que existe.
    const parts: string[] = [];
    if (opportunities.length) parts.push(`${opportunities.length} oportunidade${opportunities.length > 1 ? "s" : ""} de conteúdo`);
    if (pendingApprovals.length) parts.push(`${pendingApprovals.length} publicaç${pendingApprovals.length > 1 ? "ões" : "ão"} pra aprovar`);
    if (recentResults.length) parts.push(`${recentResults.length} resultado${recentResults.length > 1 ? "s" : ""} medido${recentResults.length > 1 ? "s" : ""}`);
    const headline = parts.length ? parts.join(" · ") : null;

    return { opportunities, pendingApprovals, recentResults, learning, headline };
  }

  /**
   * Growth Brief (PRD 11 / ADR-168 F13) — o "o que postar + impacto esperado + campeão" pra
   * o dono. COMPÕE (read-only) as fatias do PRD 11: o que postar (oportunidades de conteúdo F7
   * + de produto F11), o progresso das metas de CONTEÚDO (F12) e o campeão atual dos
   * experimentos (F6/F9). HONESTO: só o que existe; produto sem R$ (marginBand qualitativo,
   * RN-CG-06 — os números de meta são dinheiro, então a ROTA é role-gated). Não inventa.
   */
  static growthBrief(orgId: string): GrowthBrief {
    const whatToPost: GrowthBrief["whatToPost"] = [];

    // Conteúdo: oportunidades de nicho abertas (F7).
    for (const o of StudioBriefService.listOpportunities(orgId)) {
      if (!o.topic) continue;
      whatToPost.push({ kind: "content", ref: o.signalId, label: o.topic, reason: `Assunto em alta${o.vertical ? ` no nicho ${o.vertical}` : ""}.` });
    }
    // Produto: em estoque, alta margem, vendendo pouco (F11) — só QUALITATIVO (sem R$).
    for (const p of ProductOpportunityService.match(orgId, { publish: false }).opportunities) {
      whatToPost.push({ kind: "product", ref: p.productId, label: p.name, reason: `Produto de margem ${p.marginBand === "high" ? "alta" : "boa"} em estoque e vendendo pouco.`, marginBand: p.marginBand });
    }

    // Impacto esperado: progresso das metas de CONTEÚDO (F12) — distância-à-meta.
    const goals = BusinessGoalService.progress(orgId, { includeInactive: true }).goals
      .filter((g: any) => GROWTH_METRICS.has(g.metric))
      .map((g: any) => ({ metric: g.metric, label: g.label, unit: g.unit, target: g.target, current: g.current, remaining: g.remaining, attainmentPct: g.attainmentPct, paceStatus: g.paceStatus }));

    // Campeão atual: experimentos decididos com vencedor (F6/F9).
    const champions = CreativeExperimentService.list(orgId, { status: "completed" })
      .filter((e: any) => e.decision === "winner" && e.winner_variant_key)
      .slice(0, 5)
      .map((e: any) => ({ experimentId: e.id, hypothesis: e.hypothesis, winnerVariantKey: e.winner_variant_key ?? null }));

    const parts: string[] = [];
    if (whatToPost.length) parts.push(`${whatToPost.length} ideia${whatToPost.length > 1 ? "s" : ""} pra postar`);
    if (goals.length) parts.push(`${goals.length} meta${goals.length > 1 ? "s" : ""} de crescimento`);
    if (champions.length) parts.push(`${champions.length} campeã${champions.length > 1 ? "s" : "o"}`);
    const headline = parts.length ? parts.join(" · ") : null;

    return { whatToPost, goals, champions, headline };
  }
}

export default SocialProactivityService;
