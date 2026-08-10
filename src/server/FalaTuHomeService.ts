/**
 * FalaTuHomeService — PRD 1 Fase 9 (§zero-training): a "home" do Fala Tu. Ao
 * abrir, o usuário recebe TUDO que importa num payload só — sem precisar navegar
 * nem aprender onde cada coisa mora. É pura COMPOSIÇÃO do que já construímos
 * (nenhum motor novo, CA15):
 *   - saudação pela hora (SP);
 *   - resumo: contagem por categoria da Smart Inbox (Fase 3);
 *   - highlights: os itens de maior score que pedem ação (aprovação + risco +
 *     oportunidade), já no escopo do papel;
 *   - approvals: as aprovações pendentes acionáveis (Fase 4);
 *   - execution: o que está rodando agora (Fase 6);
 *   - proactiveEnabled: se a org opta por ser avisada primeiro (Fase 8).
 * Tudo herda o escopo por papel — a home de um vendedor não vaza finanças.
 */
import { SmartInboxService, InboxItem } from "./SmartInboxService.js";
import { FalaTuApprovalService } from "./FalaTuApprovalService.js";
import { FalaTuThreadService } from "./FalaTuThreadService.js";
import { FalaTuProactiveService } from "./FalaTuProactiveService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";

function greetFor(hourSP: number): string {
  if (hourSP < 12) return "Bom dia";
  if (hourSP < 18) return "Boa tarde";
  return "Boa noite";
}

export class FalaTuHomeService {
  static home(orgId: string, user: any, opts: { now?: Date } = {}): {
    greeting: string;
    summary: Record<string, number>;
    highlights: InboxItem[];
    approvals: { total: number; items: any[] };
    execution: { total: number; byType: Array<{ type: string; count: number }> };
    proactiveEnabled: boolean;
    generatedAt: string;
  } {
    const now = opts.now || new Date();
    const { hourSP } = FalaTuBriefingDigestService.spParts(now);
    const inbox = SmartInboxService.build(orgId, user, { now: now.getTime() });

    // Highlights: o que pede ação, ranqueado por score (aprovação + risco + oportunidade).
    const highlights = [...inbox.categories.needsApproval, ...inbox.categories.risk, ...inbox.categories.opportunity]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const approvals = FalaTuApprovalService.pending(orgId, user);
    const execution = FalaTuThreadService.executionStatus(orgId, user);

    return {
      greeting: greetFor(hourSP),
      summary: inbox.counts,
      highlights,
      approvals: { total: approvals.total, items: approvals.items.slice(0, 5) },
      execution: { total: execution.total, byType: execution.byType },
      proactiveEnabled: FalaTuProactiveService.enabled(orgId),
      generatedAt: new Date(now).toISOString(),
    };
  }
}
