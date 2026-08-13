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

export interface SocialProactiveDigest {
  opportunities: Array<{ signalId: string; vertical: string | null; topic: string | null; channel: string | null; summary: string | null }>;
  pendingApprovals: Array<{ actionId: string; title: string; channel: string | null }>;
  recentResults: Array<{ actionId: string; variantKey: string | null; channel: string | null; engagement: number }>;
  learning: Array<{ patternType: string; effectiveness: number | null; acted: number }>;
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
}

export default SocialProactivityService;
