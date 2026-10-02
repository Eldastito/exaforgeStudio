/**
 * SignalBriefService — "Entendi o que aconteceu… Quer que eu execute?" (PRD Fase 1 §23 + critério de sucesso).
 *
 * Antes, o botão de um sinal criava a ação NA HORA. O critério de sucesso do PRD pede outro diálogo: quando o ZapFlow acha um
 * problema, ele diz "Entendi o que aconteceu. Esta é a causa mais provável, estes são os dados que sustentam isso e esta é a ação
 * que recomendo. Quer que eu execute?" — e só então age. Este serviço monta esse BRIEFING, antes do clique que cria a ação.
 *
 * É FORMA + COMPOSIÇÃO (como o UxPresentationService): NÃO decide, NÃO cria ação, NÃO cria alerta, NÃO calcula nada novo.
 *  - o que aconteceu / o que significa / o rótulo da ação → `SignalLanguage.presentSignal` (a linguagem empresarial já existente);
 *  - a causa → `SignalInvestigationService.investigate` (determinística, hipótese NUNCA vira fato: "a causa MAIS PROVÁVEL é…").
 *    Sem correlação que a sustente: diz que ainda NÃO identificou a causa (nunca inventa);
 *  - os dados que sustentam → só chaves DA LISTA BRANCA da evidência, com rótulo humano (chave técnica desconhecida nunca vaza);
 *  - a ação → a MESMA que `POST /act` cria (`ImpactPrioritizationService.actionFor`) — que atravessa DecisionAction→ApprovalPolicy:
 *    "executar" aqui é CRIAR a ação governada; se a regra exigir aprovação, ela fica aguardando (nada executa sozinho).
 * Honestidade: fato × estimativa rotulados; dinheiro só aparece com visão completa (a rota é owner/admin — §73); sinal já resolvido
 * ou de outra organização = não encontrado. Read-only. Isola por organization_id.
 */
import db from "./db.js";
import { presentSignal } from "./SignalLanguage.js";
import { SignalInvestigationService } from "./SignalInvestigationService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";
import { SellerDiagnosisService } from "./SellerDiagnosisService.js";

// Lista branca: chave de evidência → rótulo humano. Qualquer outra chave é ignorada (nada técnico vaza pra tela).
const EVIDENCE_LABELS: Record<string, string> = {
  store: "Loja", product: "Produto", date: "Data", item: "Item", seller: "Vendedor",
  alerts: "Itens com divergência", count: "Ocorrências", unmatchedCount: "Conversões sem venda no PDV",
  reserved: "Reservado (online)", available: "Disponível", soldWindow: "Vendido no período", windowDays: "Janela analisada (dias)",
  thresholdMin: "Limite (minutos)", total: "Total",
};
const MONEY_KEYS = new Set(["soldWindow", "total", "unmatchedDeclaredValue"]);

const fmtNum = (v: number) => Number.isInteger(v) ? v.toLocaleString("pt-BR") : v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BASIS_LABEL: Record<string, string> = { fact: "fato", estimate: "estimativa", hypothesis: "hipótese", influenced: "influenciado" };

export type SignalBrief = {
  found: boolean; signalId: string;
  understood?: string; meaning?: string; operationAffected?: "yes" | "no" | "unknown"; domainLabel?: string; severity?: string;
  basis?: string | null;
  cause?: { known: boolean; text: string; confidencePct: number | null; basis: "hypothesis" | null; alternatives: string[] };
  evidence?: Array<{ label: string; value: string }>;
  /** S5 (§18): diagnóstico do vendedor (só sinais de vendedor, só com visão completa — traz R$). Fato × hipótese rotulados. */
  diagnosis?: { enough: boolean; reason?: string; findings: Array<{ kind: "fact" | "hypothesis"; text: string }> };
  impact?: { amount: number | null; unit: string | null; basis: string | null; restricted: boolean } | null;
  recommendation?: { label: string; willDo: string };
  governance?: string;
  question?: string;
  error?: string;
};

export class SignalBriefService {
  static brief(orgId: string, signalId: string, user?: any): SignalBrief {
    const sig = db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND id = ? AND status = 'open'`).get(orgId, signalId) as any;
    if (!sig) return { found: false, signalId, error: "Sinal não encontrado ou já resolvido." };

    let evRaw: any = {};
    try { evRaw = JSON.parse(sig.evidence_json || "{}") || {}; } catch { evRaw = {}; }
    const action = ImpactPrioritizationService.actionFor(sig.signal_type);
    const pres = presentSignal({ signalType: sig.signal_type, domain: sig.domain, evidence: evRaw, actionType: action.actionType, severity: sig.severity });
    const fullVisibility = user ? ContextProjectionService.hasFullBusinessVisibility(orgId, user) : true;

    // causa — hipótese, nunca fato
    let cause: NonNullable<SignalBrief["cause"]> = { known: false, text: "Ainda não identifiquei a causa com segurança — não vou chutar.", confidencePct: null, basis: null, alternatives: [] };
    try {
      const inv = SignalInvestigationService.investigate(orgId, signalId);
      const top = inv.candidateCauses[0];
      if (inv.found && top && top.supportingEvidence.length > 0) {
        cause = { known: true, text: `Causa mais provável: ${top.cause} (hipótese — correlação, não causa comprovada).`, confidencePct: Math.round(top.confidence * 100), basis: "hypothesis", alternatives: inv.candidateCauses.slice(1, 3).map((c) => c.cause) };
      } else if (inv.found && inv.candidateCauses.length) {
        cause = { ...cause, text: "Ainda não identifiquei a causa com segurança — só tenho possibilidades, sem dados que as confirmem.", alternatives: inv.candidateCauses.slice(0, 3).map((c) => c.cause) };
      }
    } catch { /* investigação indisponível: mantém "não identifiquei" */ }

    // dados que sustentam — só lista branca
    const evidence: Array<{ label: string; value: string }> = [];
    for (const [k, label] of Object.entries(EVIDENCE_LABELS)) {
      const v = evRaw?.[k];
      if (v === null || v === undefined || typeof v === "object") continue;
      if (MONEY_KEYS.has(k) && !fullVisibility) continue;                                  // dinheiro só com visão completa (§73)
      const text = typeof v === "number" ? (MONEY_KEYS.has(k) ? brl(v) : fmtNum(v)) : String(v).slice(0, 80);
      if (!text) continue;
      evidence.push({ label, value: text });
    }

    // impacto — fato/estimativa rotulados; role-gated
    let impact: SignalBrief["impact"] = null;
    if (sig.impact_amount != null) {
      impact = fullVisibility
        ? { amount: Number(sig.impact_amount), unit: sig.impact_unit || null, basis: BASIS_LABEL[String(sig.basis)] || null, restricted: false }
        : { amount: null, unit: sig.impact_unit || null, basis: BASIS_LABEL[String(sig.basis)] || null, restricted: true };
    }

    // diagnóstico do vendedor (S5) — só sinais nominais de vendedor; dinheiro → só com visão completa (§73)
    let diagnosis: SignalBrief["diagnosis"];
    if (fullVisibility && (sig.signal_type === "seller_goal_streak" || sig.signal_type === "retail_seller_below_quota")) {
      try {
        const sid = sig.source_entity_type === "seller"
          ? sig.source_entity_id
          : (db.prepare(`SELECT id FROM retail_sellers WHERE organization_id = ? AND user_id = ? AND merged_into_seller_id IS NULL`).get(orgId, sig.source_entity_id) as any)?.id;
        if (sid) {
          const d = SellerDiagnosisService.diagnose(orgId, sid, new Date().toISOString().slice(0, 10));
          if (d.found) diagnosis = { enough: d.enough, reason: d.reason, findings: d.findings };
        }
      } catch { /* diagnóstico indisponível: o briefing segue sem ele */ }
    }

    return {
      found: true, signalId,
      understood: `Entendi o que aconteceu: ${pres.title}.`,
      meaning: pres.meaning, operationAffected: pres.operationAffected, domainLabel: pres.domainLabel, severity: sig.severity,
      basis: BASIS_LABEL[String(sig.basis)] || null,
      cause, evidence, diagnosis, impact,
      recommendation: { label: pres.actionLabel, willDo: pres.actionWillDo },
      governance: "Se você disser que sim, eu crio a ação. Se a sua regra de aprovação exigir, ela fica aguardando você — nada é executado sem passar por essa regra.",
      question: "Quer que eu execute?",
    };
  }
}

export default SignalBriefService;
