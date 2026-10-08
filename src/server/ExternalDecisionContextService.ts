import db from "./db.js";
import { ResearchBrokerService } from "./ResearchBrokerService.js";
import { VerticalIntelligenceService } from "./VerticalIntelligenceService.js";
import { ScenarioEngine } from "./ScenarioEngine.js";

/**
 * ExternalDecisionContextService — ADR-205 F4.9: contexto EXTERNO (mercado/nicho) ao lado de uma decisão estratégica — cenário, compra, contratação, investimento, plano, fornecedor.
 *
 * É CONSUMO, não pesquisa (RN-F4-11 / RN-EI-4): lê o que o admin master já publicou no pool compartilhado e anonimizado (ADR-156/157) via `ResearchBrokerService`, que respeita o opt-in da
 * empresa e a validade, e NUNCA chama o provedor. Só o cache por-org (L2) que o próprio broker já grava pode ser escrito. Este serviço não grava mais nada e não cria sinal, ação ou tarefa.
 *
 * Regras (RN-F4):
 *  - FONTE E DATA sempre (RN-F4-7): cada item mostra de onde vem (`sources` com tier A/B/C), quando foi coletado (`collectedAt`) e até quando vale (`validUntil`). Síntese do modelo (`model_knowledge`)
 *    NÃO é fonte viva: sem recuperação real e sem data de coleta, é rotulada "síntese do modelo" — mesmo que a entrada se declare `live`, sem fonte A/B datada ela não vira "fonte viva".
 *  - Contexto NÃO mexe em número (`affectsCalculations:false`): nada aqui roda ou altera cenário, plano ou comparação. Ele só aponta QUAIS premissas editáveis o dono pode querer revisitar
 *    (as do `ScenarioEngine`, reaproveitadas, não duplicadas) — e em forma de PERGUNTA, nunca de conclusão (RN-F4-8: correlação ≠ causa).
 *  - Texto externo é DADO NÃO CONFIÁVEL: vem de pesquisa/LLM/colagem manual; é limpo (sem controle), truncado e marcado `untrusted:true`. Quem o reutilizar num prompt trata como não confiável.
 *  - Taxonomia fechada: o tópico vem de uma lista por tipo de decisão (ou de tópicos livres saneados) — nunca de dado do tenant (RN-156-2).
 *  - Sem nicho cadastrado, sem opt-in ou sem entrada fresca → vazio e honesto, com o motivo (nunca inventa). Confiança só `baixa`/`media`: só com fonte VIVA datada chega a `media`.
 *  - NÃO existe benchmark entre empresas aqui: exigiria amostra mínima e anonimização cross-tenant (RN-F4-9) — fora desta fatia, e dito.
 */
export const DECISION_KINDS = ["purchase", "sales_change", "hire", "capital", "plan", "supplier"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
const TOPICS: Record<DecisionKind, string[]> = {
  purchase: ["demanda e sazonalidade", "preço e prazo de fornecedores", "tendências de coleção"],
  sales_change: ["demanda e sazonalidade", "concorrência e promoções"],
  hire: ["mercado de trabalho e custo de pessoal"],
  capital: ["custo de ponto comercial e expansão", "crédito e juros para varejo"],
  plan: ["demanda e sazonalidade", "calendário comercial"],
  supplier: ["preço e prazo de fornecedores"],
};
const QUESTIONS: Record<DecisionKind, string[]> = {
  purchase: ["A demanda e a sazonalidade descritas mudam a velocidade de venda que você supõe para essa coleção?", "O que se diz de preço e prazo de fornecedores muda o valor ou o prazo de pagamento que você planejou?"],
  sales_change: ["O cenário de demanda e de concorrência descrito é compatível com a variação de vendas que você está simulando?"],
  hire: ["O custo de pessoal descrito no mercado muda o custo mensal que você usou na simulação?"],
  capital: ["O que se diz do custo de ponto e de crédito muda o desembolso ou o retorno que você informou para cada alternativa?"],
  plan: ["O calendário comercial e a sazonalidade descritos mudam a meta ou os eventos que você colocou no plano?"],
  supplier: ["O movimento de preço e prazo no mercado dá base para pedir ajuste ao fornecedor, ou o reajuste dele acompanha o mercado?"],
};
const MAX_TOPICS = 5, STALE_DAYS = 60;
const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const clean = (v: unknown, max: number): string | null => { const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); return s || null; };
const SAFE_TOPIC = /^[\p{L}\p{N} ,./-]{3,80}$/u;
const TIERS = ["A", "B", "C"];

function verticalOf(orgId: string): string | null {
  const r = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
  const v = r?.vertical ? String(r.vertical).trim() : "";
  return v || null;
}
const daysSince = (iso?: string | null) => { if (!iso) return null; const t = Date.parse(String(iso).includes("T") ? String(iso) : String(iso).replace(" ", "T") + "Z"); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400e3)) : null; };

export class ExternalDecisionContextService {
  static topicsFor(kind: DecisionKind): string[] { return [...TOPICS[kind]]; }

  static forDecision(orgId: string, input: { kind: string; topics?: string[]; region?: string; timeframe?: string }) {
    const kind = String(input?.kind || "") as DecisionKind;
    if (!(DECISION_KINDS as readonly string[]).includes(kind)) throw bad("invalid_kind", `Tipo de decisão inválido (${DECISION_KINDS.join(", ")}).`);
    let topics = TOPICS[kind];
    if (Array.isArray(input?.topics) && input.topics.length) {
      const custom = input.topics.map((t) => String(t ?? "").trim()).filter(Boolean);
      if (custom.length > MAX_TOPICS) throw bad("too_many_topics", `No máximo ${MAX_TOPICS} tópicos.`);
      if (custom.some((t) => !SAFE_TOPIC.test(t))) throw bad("invalid_topic", "Tópico inválido: use de 3 a 80 caracteres, só letras, números e pontuação simples.");
      topics = [...new Set(custom)];
    }
    const region = clean(input?.region, 60) ?? undefined, timeframe = clean(input?.timeframe, 40) ?? undefined;
    const vertical = verticalOf(orgId);
    const brokerEnabled = ResearchBrokerService.isEnabled(orgId);
    const caveats: string[] = [
      "Contexto de mercado é informação para PERGUNTAR, não para concluir: não prova que a sua operação vai se comportar assim.",
      "Nada aqui altera cenário, plano ou comparação — os números continuam sendo os que você informou e os que o sistema mediu.",
      "Texto vindo de pesquisa externa é dado não confiável: confira a fonte antes de agir.",
      "Não há comparação com outras empresas: isso exigiria amostra mínima e anonimização entre empresas, que não existem nesta etapa.",
    ];

    const base = { type: "external_context" as const, isForecast: false, executes: false, affectsCalculations: false as const, kind, vertical, brokerEnabled };
    if (!vertical) return { ...base, items: [], confidence: { level: "baixa" as const, reasons: ["Sem nicho cadastrado na empresa."] }, assumptionsToRevisit: [], questions: [], caveats: [...caveats, "A empresa não tem nicho (vertical) cadastrado, então não há como buscar contexto de mercado."] };

    const items = topics.map((topic) => {
      const res: any = ResearchBrokerService.resolve(orgId, { vertical, topic, region, timeframe });
      if (!res?.available) return { topic, available: false as const, reason: String(res?.reason || "unavailable") };
      const vi: any = VerticalIntelligenceService.getFresh(vertical, topic, region, timeframe);
      const content = vi?.content || {};
      const evidence = (Array.isArray(content.sourceEvidence) ? content.sourceEvidence : []) as any[];
      let sources = evidence.map((e) => ({ title: clean(e?.title, 160), url: clean(e?.url, 300), publisher: clean(e?.publisher, 120), tier: TIERS.includes(String(e?.tier)) ? String(e.tier) : "C", retrievedAt: clean(e?.retrievedAt, 40) }));
      if (!sources.length && Array.isArray(vi?.sources)) sources = vi.sources.map((s: any) => ({ title: clean(s, 160), url: null, publisher: null, tier: "C", retrievedAt: null }));
      const liveSourced = content.evidenceMode === "live" && sources.some((s) => (s.tier === "A" || s.tier === "B") && !!s.retrievedAt);
      const collectedAt = clean(content.retrievedAt, 40) || sources.map((s) => s.retrievedAt).filter(Boolean).sort().slice(-1)[0] || null;
      const age = daysSince(vi?.generated_at);
      return {
        topic, available: true as const,
        evidenceMode: liveSourced ? "live" : "model_knowledge", label: liveSourced ? "fonte_viva" : "sintese_do_modelo",
        summary: clean(content.summary ?? res.contextualization?.summary, 600),
        drivers: (Array.isArray(content.drivers) ? content.drivers : []).slice(0, 5).map((d: any) => clean(d, 160)).filter(Boolean) as string[],
        sources, collectedAt: liveSourced ? collectedAt : null, generatedAt: vi?.generated_at ?? null, validUntil: vi?.valid_until ?? res.contextualization?.validUntil ?? null,
        ageDays: age, stale: age != null && age > STALE_DAYS, confidence: typeof vi?.confidence === "number" ? vi.confidence : null,
        trend: res.trend ?? null, untrusted: true as const,
      };
    });

    const avail = items.filter((i: any) => i.available) as any[];
    if (!brokerEnabled) caveats.push("A inteligência externa está desligada para esta empresa (opt-in): nenhum contexto é carregado.");
    else if (!avail.length) caveats.push("Não há pesquisa fresca publicada para este nicho nos tópicos pedidos — o contexto vem do admin master; o sistema não pesquisa sozinho.");
    if (avail.length && avail.every((i) => i.label === "sintese_do_modelo")) caveats.push("Tudo aqui é síntese do modelo, sem fonte viva datada: serve como hipótese de trabalho, não como evidência.");
    if (avail.some((i) => i.stale)) caveats.push(`Há contexto com mais de ${STALE_DAYS} dias — pode estar defasado.`);

    const anyLive = avail.some((i) => i.label === "fonte_viva");
    const spec = (ScenarioEngine.kinds() as any[]).find((k) => k.kind === kind);
    return {
      ...base, items,
      confidence: { level: anyLive ? ("media" as const) : ("baixa" as const), reasons: anyLive ? ["Há ao menos uma fonte viva datada (tier A/B) — ainda sem validação com a sua operação."] : ["Sem fonte viva datada: só síntese do modelo ou nada disponível."] },
      assumptionsToRevisit: spec && avail.length ? spec.inputs.map((i: any) => ({ key: i.key, label: i.label })) : [],
      questions: avail.length ? QUESTIONS[kind] : [],
      caveats,
    };
  }
}
export default ExternalDecisionContextService;
