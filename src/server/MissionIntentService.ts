import { BusinessGoalService } from "./BusinessGoalService.js";
import { MissionService, Mission } from "./MissionService.js";

/**
 * MissionIntentService — ADR-189 F2 (Mission OS): INTENÇÃO → MISSÃO (shadow-first).
 *
 * O usuário diz "quero vender mais" / "recuperar clientes antigos" / "cobrar quem está
 * atrasado"; este serviço DETECTA a intenção empresarial e PROPÕE uma missão — sem
 * executar NADA (§9/§35). Determinístico primeiro (RN-MOL-3/§12): casamento por padrão
 * mapeia a intenção a um formato de missão (título/estado final/métrica-alvo). LLM fica
 * pra fatia futura (§61 escada de custo) — aqui é 100% regra, reproduzível, roda em CI.
 *
 * SHADOW (RN-MOL-4): `propose` por padrão NÃO grava; só quando `persist:true` cria uma
 * missão `draft`/autonomia `off`/`source:'system_proposed'` — nunca planeja nem executa,
 * nunca cria `decision_action`. Reusa `BusinessGoalService.isKnownMetric` (nunca inventa
 * métrica) e o `MissionService` (não duplica o contrato). Isolado por org.
 */

interface IntentPattern {
  id: string;
  test: RegExp;
  metric: string | null;         // métrica conhecida OU null (missão qualitativa)
  unit: "BRL" | "count" | null;
  desiredState: string;
  titleFor: (v: number | null) => string;
}

const brl = (n: number) => `R$ ${n.toLocaleString("pt-BR")}`;

// Ordem IMPORTA: padrões específicos (recuperar cliente / cobrança) antes do genérico (faturamento).
const PATTERNS: IntentPattern[] = [
  {
    id: "recover_customer",
    test: /(recuperar|reativar|trazer de volta|voltar a comprar).*client|client.*(inativ|sumido|antig|parou de comprar|não volt)/i,
    metric: null, unit: "count",
    desiredState: "recuperar clientes inativos",
    titleFor: (v) => v ? `Recuperar ${v} clientes inativos` : "Recuperar clientes inativos",
  },
  {
    id: "collect_receivable",
    test: /(cobran|cobrar|inadimpl|em atraso|atrasad|d[ií]vida|receber.*atrasad|quem (me )?deve)/i,
    metric: null, unit: "BRL",
    desiredState: "recuperar valores em atraso",
    titleFor: (v) => v ? `Recuperar ${brl(v)} de inadimplência` : "Recuperar valores em atraso",
  },
  {
    id: "fill_schedule",
    test: /(lotar|preencher|encher).*(agenda|hor[aá]rio)|agenda (ociosa|vazia|com buraco)|mais (agendamento|hor[aá]rio)|hor[aá]rios? vag/i,
    metric: "appointments", unit: "count",
    desiredState: "preencher a agenda",
    titleFor: (v) => v ? `Preencher ${v} horários da agenda` : "Preencher a agenda",
  },
  {
    id: "reduce_stock",
    test: /(reduzir|girar|desovar|zerar).*estoque|estoque (parado|encalhad|parado h[aá])/i,
    metric: null, unit: null,
    desiredState: "reduzir estoque parado",
    titleFor: () => "Reduzir estoque parado",
  },
  {
    id: "response_time",
    test: /(tempo|demora).*(de )?resposta|responder.*(mais )?r[aá]pid|demora.*(pra|para) respond/i,
    metric: null, unit: null,
    desiredState: "reduzir o tempo de resposta",
    titleFor: () => "Reduzir o tempo médio de resposta",
  },
  {
    id: "grow_revenue",
    test: /(vender mais|aumentar.*(venda|faturamento|receita)|faturar mais|crescer.*(venda|receita)|mais faturamento|(bater|atingir).*(meta|faturamento|receita)|faturamento de r\$|r\$.*de faturamento)/i,
    metric: "revenue", unit: "BRL",
    desiredState: "aumentar a receita",
    titleFor: (v) => v ? `Atingir ${brl(v)} de faturamento` : "Aumentar a receita",
  },
];

export interface MissionProposal {
  isMission: boolean;
  intentId?: string;
  shape?: {
    title: string;
    desiredState: string;
    targetMetric: string | null;
    targetValue: number | null;
    targetUnit: "BRL" | "count" | null;
    source: "system_proposed";
    confidence: number;          // hipótese — é uma PROPOSTA, não uma ordem
  };
  basis: "hypothesis";
  note: string;
}

/** Extrai um valor-alvo do texto: R$ (com mil/k/milhão) ou contagem (N clientes/horários). */
function parseTarget(text: string, unit: "BRL" | "count" | null): number | null {
  if (unit === "BRL") {
    const m = text.match(/r\$\s?([\d.]+(?:,\d+)?)\s*(mil|k|milh[õo]es?|milh[aã]o|m)?/i);
    if (!m) return null;
    let n = Number(m[1].replace(/\./g, "").replace(",", "."));
    const suf = (m[2] || "").toLowerCase();
    if (/^(mil|k)$/.test(suf)) n *= 1_000;
    else if (/^(milh|m)/.test(suf)) n *= 1_000_000;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (unit === "count") {
    const m = text.match(/(\d+)\s*(clientes?|hor[aá]rios?|agendamentos?|atendimentos?|pessoas?|vagas?)/i);
    if (m) { const n = Number(m[1]); return Number.isFinite(n) && n > 0 ? n : null; }
  }
  return null;
}

export class MissionIntentService {
  /** Detecta a intenção e monta uma PROPOSTA de missão (nada é gravado aqui). */
  static detect(text: string): MissionProposal {
    const t = String(text || "").trim();
    if (!t) return { isMission: false, basis: "hypothesis", note: "Sem texto para interpretar." };
    for (const p of PATTERNS) {
      if (!p.test.test(t)) continue;
      const targetValue = parseTarget(t, p.unit);
      const metric = p.metric && BusinessGoalService.isKnownMetric(p.metric) ? p.metric : null;
      return {
        isMission: true,
        intentId: p.id,
        shape: {
          title: p.titleFor(targetValue),
          desiredState: p.desiredState,
          targetMetric: metric,
          targetValue,
          targetUnit: p.unit,
          source: "system_proposed",
          confidence: 0.6,
        },
        basis: "hypothesis",
        note: metric
          ? `Entendi como uma missão de ${BusinessGoalService.isKnownMetric(metric) ? "negócio" : ""} (${p.desiredState}). Posso montar essa missão?`
          : `Entendi como uma missão de ${p.desiredState}. Posso montar essa missão?`,
      };
    }
    return { isMission: false, basis: "hypothesis", note: "Não reconheci um objetivo de negócio claro nessa frase. Pode reformular?" };
  }

  /**
   * Propõe (e opcionalmente PERSISTE em shadow) a missão. `persist:false` (default) é PURO shadow —
   * nada é gravado. `persist:true` cria uma missão `draft`/`off`/`system_proposed` (RN-MOL-4: nunca
   * planeja nem executa; nunca cria decision_action). Retorna a proposta e, se persistido, a missão.
   */
  static propose(orgId: string, text: string, opts: { persist?: boolean; actor?: string } = {}): { proposal: MissionProposal; mission: Mission | null } {
    const proposal = this.detect(text);
    if (!proposal.isMission || !proposal.shape) return { proposal, mission: null };
    let mission: Mission | null = null;
    if (opts.persist) {
      mission = MissionService.create(orgId, {
        title: proposal.shape.title,
        desiredState: proposal.shape.desiredState,
        targetMetric: proposal.shape.targetMetric,
        targetValue: proposal.shape.targetValue,
        targetUnit: proposal.shape.targetUnit,
        source: "system_proposed",
        confidence: proposal.shape.confidence,
      }, opts.actor);
    }
    return { proposal, mission };
  }
}

export default MissionIntentService;
