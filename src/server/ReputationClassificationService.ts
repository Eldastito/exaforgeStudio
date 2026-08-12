/**
 * ReputationClassificationService (ADR-162 / PRD 5 §15-§18, F4) — CLASSIFICAÇÃO
 * determinística de uma reclamação já ingerida (business_signal domain='reputation'),
 * o passo que segue a identidade/contexto da F3 e alimenta a investigação da F5.
 *
 * Três entregas do §15-§18, todas SEM IA (regra de código → roda em CI, D5/§57-60):
 *   1. TAXONOMIA (§15-16): categoriza o texto por casamento de termos (token/substring,
 *      normalizado sem acento). Base transversal + extensão POR VERTICAL (§15 "extensível
 *      por vertical" — sem Reputation Engine por vertical: é só uma lista a mais mesclada
 *      à base). Score = nº de termos distintos casados; maior score vence; sem casar → `other`.
 *   2. SEVERIDADE (§17): LOW/MEDIUM/HIGH/CRITICAL. Deriva da nota/sentimento (reusa
 *      `ExternalSignalService.deriveSeverity`, sem reimplementar a matemática) e sobe um
 *      nível quando a categoria é financeira (dinheiro dói). Mapeada pra severidade do
 *      ledger (info/attention/risk/critical) pra o attention feed ranquear certo.
 *   3. HIGH-RISK GATES (§18, RN-CRR-4): acidente/saúde, fraude, vazamento/LGPD, jurídico/
 *      regulador, imprensa → CRITICAL + `escalate` + `improviseAllowed=false`. CONSERVADOR:
 *      QUALQUER indício de high-risk escala (não precisa ser a categoria dominante). A IA
 *      NUNCA improvisa nem responde autônomo num caso high-risk — o humano decide (§24 nº3).
 *
 * `classify()` é PURO e testável (sem DB). `classifySignal()` aplica sobre um sinal e
 * PERSISTE, de forma MONOTÔNICA, um UPGRADE de severidade — NUNCA rebaixa (um caso que já
 * foi escalado por outra via continua escalado; re-classificar é idempotente). A
 * classificação fica carimbada no `evidence_json` (proveniência/auditoria), sem tabela
 * nova (D1/§5). Isolado por org (RN-CRR-9).
 */
import db from "./db.js";
import { ExternalSignalService } from "./ExternalSignalService.js";

export type SeverityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Tier = "normal" | "high_risk";

export interface ReputationClassification {
  category: string;                 // slug da categoria dominante (headline)
  categoryLabel: string;            // rótulo PT-BR
  tier: Tier;                       // a categoria dominante é normal ou high_risk?
  severityLevel: SeverityLevel;     // vocabulário do PRD (§17)
  signalSeverity: string;           // vocabulário do ledger (info|attention|risk|critical)
  highRisk: boolean;                // §18 — qualquer indício de high-risk
  highRiskReasons: string[];        // categorias high-risk que dispararam (auditoria)
  escalate: boolean;                // = highRisk (RN-CRR-4)
  improviseAllowed: boolean;        // = !highRisk (IA não improvisa em high-risk)
  matchedTerms: string[];           // termos que casaram na categoria dominante
  factors: Array<{ category: string; tier: Tier; score: number; terms: string[] }>; // ScoreBreakdown (§49-50)
  basis: "deterministic";           // marca que NÃO houve IA — reprodutível em CI
}

interface CategoryDef { key: string; label: string; tier: Tier; terms: string[]; }

/**
 * TAXONOMIA BASE (transversal). High-risk primeiro (leitura/prioridade), mas o
 * casamento é por score, não por ordem. Termos em minúsculas SEM acento (o texto é
 * normalizado do mesmo jeito); prefixos casam flexões (ex.: "machuc" → machucou/
 * machucado). Termos conservadores em high-risk pra evitar falso-positivo (ex.:
 * "processo" sozinho é ambíguo — exige "processo judicial"/"processar"/"procon").
 */
const BASE_TAXONOMY: CategoryDef[] = [
  // ── HIGH-RISK (§18) — escala CRITICAL, IA não improvisa ──
  { key: "safety_health", label: "Segurança / Saúde", tier: "high_risk", terms: [
    "acidente", "machuc", "ferid", "lesao", "intoxica", "envenen", "passei mal", "passou mal", "passar mal",
    "hospital", "pronto-socorro", "pronto socorro", "queimadura", "queimad", "contamina", "reacao alergica", "alergi grave" ] },
  { key: "fraud", label: "Fraude / Golpe", tier: "high_risk", terms: [
    "fraude", "golpe", "estelionato", "clonaram", "clonagem", "cartao clonad", "roubaram meu", "me roubaram",
    "nao autorizei", "nao reconheco a compra", "nao reconheco essa compra", "compra nao autorizada" ] },
  { key: "data_privacy", label: "Privacidade / LGPD", tier: "high_risk", terms: [
    "vazaram meus dados", "vazamento de dados", "vazamento", "lgpd", "dados pessoais", "meus dados foram",
    "expuseram meus dados", "expuseram meus", "violacao de privacidade", "privacidade dos meus dados" ] },
  { key: "legal_regulatory", label: "Jurídico / Regulador", tier: "high_risk", terms: [
    "processo judicial", "processar", "vou processar", "advogad", "acao judicial", "justica", "procon",
    "ministerio publico", "notificacao extrajudicial", "juizado", "orgao de defesa", "defesa do consumidor" ] },
  { key: "press_media", label: "Imprensa / Mídia", tier: "high_risk", terms: [
    "imprensa", "jornal", "reportagem", "televisao", "vou a midia", "vou expor na midia", "vou na globo" ] },
  // ── NORMAL — categorias de negócio ──
  { key: "refund_billing", label: "Reembolso / Cobrança", tier: "normal", terms: [
    "reembolso", "estorno", "estornar", "estornad", "cobranca", "cobrado", "cobraram", "cobranca indevida",
    "debito", "debitad", "duplicad", "meu dinheiro", "valor errado", "valor cobrado", "tarifa", "nao recebi o valor", "nao devolveram" ] },
  { key: "delivery", label: "Entrega / Logística", tier: "normal", terms: [
    "entrega", "entregar", "nao chegou", "nao recebi o produto", "nao recebi o pedido", "atraso", "atrasad",
    "extraviad", "extravio", "correios", "transportadora", "prazo de entrega", "rastreio", "sumiu o pedido" ] },
  { key: "product_defect", label: "Produto com Defeito", tier: "normal", terms: [
    "defeito", "com defeito", "quebrad", "nao funciona", "parou de funcionar", "danificad", "avariad",
    "veio errad", "produto errad", "veio quebrad", "veio com defeito" ] },
  { key: "service_quality", label: "Qualidade do Atendimento", tier: "normal", terms: [
    "atendimento", "mal atendid", "atendente", "grosseir", "mal educad", "descaso", "ninguem responde",
    "nao respondem", "nao retornam", "fui ignorad", "pessimo atendimento", "demora no atendimento", "despreparad" ] },
  { key: "misinformation", label: "Propaganda Enganosa", tier: "normal", terms: [
    "propaganda enganosa", "enganos", "prometeram", "prometid", "nao era o combinado", "me enganaram",
    "induzir", "informacao falsa", "falsa promessa" ] },
  { key: "access_account", label: "Acesso / Conta", tier: "normal", terms: [
    "nao consigo acessar", "nao consigo logar", "login", "minha senha", "conta bloqueada", "conta bloquead",
    "quero cancelar", "cancelamento", "desbloquear", "nao consigo cancelar" ] },
];

/**
 * EXTENSÃO POR VERTICAL (§15). Só uma lista a mais mesclada à base — não é motor por
 * vertical. Chave = `organization_settings.vertical` (verticals.ts). Verticais sem
 * entrada usam só a base (fallback seguro).
 */
const VERTICAL_TAXONOMY: Record<string, CategoryDef[]> = {
  food: [
    { key: "food_quality", label: "Qualidade da Comida", tier: "normal", terms: [
      "comida fria", "chegou fria", "mal passad", "cru", "sem sabor", "sem tempero", "porcao pequena", "veio pouca" ] },
    { key: "wrong_order", label: "Pedido Errado", tier: "normal", terms: [
      "pedido errado", "veio trocado", "item errado", "faltou item", "faltou um item", "veio sem", "esqueceram o" ] },
  ],
};

const LEVEL_TO_SIGNAL: Record<SeverityLevel, string> = { LOW: "info", MEDIUM: "attention", HIGH: "risk", CRITICAL: "critical" };
const LEVEL_ORDER: SeverityLevel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
// Rank do vocabulário do ledger (menor = mais severo) — igual ao attention feed (F1).
const SIGNAL_RANK: Record<string, number> = { critical: 0, risk: 1, attention: 2, info: 3 };
// Categorias financeiras: dinheiro em jogo sobe um nível de severidade (nunca a CRITICAL).
const FINANCIAL = new Set(["refund_billing"]);

/** Normaliza: minúsculas + remove acento — casa "saúde"↔"saude" e texto sem acento. */
function norm(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export class ReputationClassificationService {
  /**
   * CLASSIFICAÇÃO PURA (sem DB): recebe o texto + nota/sentimento + vertical opcional,
   * devolve categoria/severidade/high-risk. Determinística e testável.
   */
  static classify(input: {
    content?: string | null;
    rating?: number | null;
    ratingScale?: number | null;
    sentiment?: string | null;
    vertical?: string | null;
  }): ReputationClassification {
    const text = norm(input.content || "");
    const taxonomy = this.taxonomyFor(input.vertical);

    // Score de cada categoria: nº de termos distintos que aparecem no texto.
    const factors: Array<{ category: string; tier: Tier; score: number; terms: string[] }> = [];
    for (const cat of taxonomy) {
      const hit = cat.terms.filter((t) => text.includes(norm(t)));
      if (hit.length > 0) factors.push({ category: cat.key, tier: cat.tier, score: hit.length, terms: hit });
    }
    factors.sort((a, b) => b.score - a.score);

    const highRiskFactors = factors.filter((f) => f.tier === "high_risk");
    const highRisk = highRiskFactors.length > 0;

    // Headline: em high-risk, a categoria dominante é a high-risk de maior score
    // (§18 conservador — o risco é a manchete). Senão, a normal de maior score.
    const headline = highRisk ? highRiskFactors[0] : (factors.find((f) => f.tier === "normal") || null);
    const catDef = headline ? taxonomy.find((c) => c.key === headline.category)! : null;

    const severityLevel = this.deriveLevel(input, headline?.category ?? null, highRisk);

    return {
      category: catDef ? catDef.key : "other",
      categoryLabel: catDef ? catDef.label : "Outro / Não classificado",
      tier: catDef ? catDef.tier : "normal",
      severityLevel,
      signalSeverity: LEVEL_TO_SIGNAL[severityLevel],
      highRisk,
      highRiskReasons: highRiskFactors.map((f) => f.category),
      escalate: highRisk,
      improviseAllowed: !highRisk,
      matchedTerms: headline ? headline.terms.slice(0, 8) : [],
      factors: factors.slice(0, 6),
      basis: "deterministic",
    };
  }

  /** Taxonomia efetiva pra uma vertical: base + extensão da vertical (§15). */
  private static taxonomyFor(vertical?: string | null): CategoryDef[] {
    const ext = vertical ? VERTICAL_TAXONOMY[String(vertical)] : undefined;
    return ext && ext.length ? [...BASE_TAXONOMY, ...ext] : BASE_TAXONOMY;
  }

  /**
   * Severidade LOW/MEDIUM/HIGH/CRITICAL (§17). High-risk → CRITICAL sempre (§18).
   * Senão parte da nota/sentimento (reusa a derivação da ingestão) e sobe um nível se
   * a categoria é financeira. Nunca alcança CRITICAL fora do gate de high-risk.
   */
  private static deriveLevel(
    input: { rating?: number | null; ratingScale?: number | null; sentiment?: string | null },
    category: string | null,
    highRisk: boolean
  ): SeverityLevel {
    if (highRisk) return "CRITICAL";
    // info→LOW, attention→MEDIUM, risk→HIGH (deriveSeverity nunca devolve critical).
    const base = ExternalSignalService.deriveSeverity(input);
    let level: SeverityLevel = base === "risk" ? "HIGH" : base === "attention" ? "MEDIUM" : "LOW";
    if (category && FINANCIAL.has(category) && level !== "HIGH") {
      level = LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(level) + 1, 2)]; // cap em HIGH (índice 2)
    }
    return level;
  }

  /** Vertical da org (organization_settings.vertical); null se não definida. */
  static orgVertical(orgId: string): string | null {
    const r = db.prepare(`SELECT vertical FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return r && r.vertical ? String(r.vertical) : null;
  }

  /**
   * Classifica um sinal de reputação existente e PERSISTE o resultado:
   *   - carimba a classificação no `evidence_json` (auditoria/observabilidade);
   *   - UPGRADE monotônico da severidade do sinal — sobe se a classificação for mais
   *     severa que a atual (high-risk → critical), NUNCA rebaixa (RN: quem já foi
   *     escalado por outra via continua). Assim o attention feed (F1) ranqueia certo.
   * Isolado por org. Idempotente. Não age (F4 é percepção/classificação, não resposta).
   */
  static classifySignal(orgId: string, signalId: string, opts: { vertical?: string | null } = {}): {
    signalId: string;
    classification: ReputationClassification;
    severityUpgraded: boolean;
    from: string;
    to: string;
  } | null {
    const row = db.prepare(
      `SELECT id, severity, evidence_json FROM business_signals
       WHERE organization_id = ? AND id = ? AND domain = 'reputation'`
    ).get(orgId, signalId) as any;
    if (!row) return null;

    let evidence: any = {};
    try { evidence = JSON.parse(row.evidence_json || "{}"); } catch { evidence = {}; }
    const content = String(evidence.content || evidence.summary || "");
    const vertical = opts.vertical !== undefined ? opts.vertical : this.orgVertical(orgId);

    const classification = this.classify({
      content,
      rating: evidence.rating ?? null,
      ratingScale: evidence.ratingScale ?? null,
      sentiment: evidence.sentiment ?? null,
      vertical,
    });

    const current = String(row.severity || "attention");
    const target = classification.signalSeverity;
    const upgraded = (SIGNAL_RANK[target] ?? 2) < (SIGNAL_RANK[current] ?? 2); // menor rank = mais severo

    // Carimba a classificação sempre; troca a severidade só no upgrade.
    const merged = {
      ...evidence,
      classification: {
        category: classification.category,
        tier: classification.tier,
        severityLevel: classification.severityLevel,
        highRisk: classification.highRisk,
        highRiskReasons: classification.highRiskReasons,
        classifiedAt: new Date().toISOString(),
        ...(upgraded ? { severityUpgradedFrom: current } : {}),
      },
    };

    if (upgraded) {
      db.prepare(`UPDATE business_signals SET severity = ?, evidence_json = ? WHERE organization_id = ? AND id = ?`)
        .run(target, JSON.stringify(merged), orgId, signalId);
    } else {
      db.prepare(`UPDATE business_signals SET evidence_json = ? WHERE organization_id = ? AND id = ?`)
        .run(JSON.stringify(merged), orgId, signalId);
    }

    return { signalId, classification, severityUpgraded: upgraded, from: current, to: upgraded ? target : current };
  }
}

export default ReputationClassificationService;
