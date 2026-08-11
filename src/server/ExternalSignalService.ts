/**
 * ExternalSignalService — PRD 2 F10 (§48-51, §10C, CA2): a origem EXTERNA da
 * percepção. Completa o trio Humana (F9) · Digital (detectores) · EXTERNA.
 *
 * Escopo desta fatia: SÓ O CONTRATO DE INGESTÃO (o "molde", §50). Os conectores
 * concretos (Reclame AQUI, agregadores de review, provedores de inteligência de
 * mercado) são PRDs próprios (Customer Recovery & Reputation Engine) — aqui só a
 * fronteira provider-agnóstica por onde qualquer um deles entrega um sinal externo
 * JÁ NORMALIZADO, virando cidadão de 1ª classe do attention feed.
 *
 * A MARCA da origem externa é PROVENIÊNCIA + CONFIANÇA (distinta do acúmulo da F9):
 *   - PROVENIÊNCIA OBRIGATÓRIA (§49): todo sinal externo carrega `source` (o
 *     sistema de origem: reclame_aqui, google_reviews, market_intel…) e
 *     `externalId` (o id do item lá). Sem os dois não há como rastrear, deduplicar
 *     nem confiar — ingestão sem proveniência é RECUSADA. O dedupe é por
 *     `(source, externalId)`: reingerir o MESMO item externo ATUALIZA a linha
 *     (idempotência de conector, §7.1), nunca duplica.
 *   - NÃO PROMOVE A FATO NÃO VERIFICADO (§13, CA3): uma reclamação/menção externa
 *     é `estimate` por padrão (afirmação de terceiro, não medição desta org).
 *     `hypothesis` é aceito. `fact` SÓ quando o conector marca `verifiable:true`
 *     (o item é um registro externo objetivo — ex.: um review que existe e foi
 *     lido). Sem `verifiable`, `fact` é REBAIXADO a `estimate` — o Radar não
 *     confunde "alguém disse" com "é verdade".
 *
 * O que este service NUNCA faz:
 *   - Não chama provider/rede (é só o RECEBEDOR do payload já capturado — o
 *     conector é quem busca; §50/§84 mantêm o custo de rede fora daqui);
 *   - Não inventa conteúdo (texto/rating/autor são verbatim do provedor);
 *   - Não executa ação — só registra a percepção no ledger canônico; roteamento/
 *     decisão seguem o caminho comum (attention → router → policy).
 *
 * Sem ledger/alerta novo (CA1/§5): publica via `BusinessSignalService.publish`;
 * a proveniência mora no `evidence_json` do próprio sinal. Opt-in
 * (`radar_external_signals_enabled`), isolado por org.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { maskIdentifier } from "./auditLog.js";

export interface ExternalSignalInput {
  /** Sistema de origem (slug estável): reclame_aqui|google_reviews|market_intel… */
  source: string;
  /** Id do item NO sistema de origem — par do `source`, chave do dedupe. */
  externalId: string;
  /** Domínio de negócio afetado (sales|reputation|retail_ops|clinic|…). */
  domain: string;
  /** Conteúdo externo verbatim (o texto do review/reclamação/menção). */
  content: string;
  /** Tipo do sinal; default 'external_signal'. */
  signalType?: string;
  /** O "sobre o quê": product|store|brand|contact|topic (opcional). */
  subjectType?: string | null;
  subjectId?: string | null;
  /** Severidade explícita (info|attention|risk|critical); se omitida, derivada. */
  severity?: string | null;
  /** `estimate` (default) | `hypothesis`. `fact` só com `verifiable:true` (§13). */
  basis?: "fact" | "estimate" | "hypothesis";
  /** O conector garante que é um registro externo OBJETIVO (destrava `fact`). */
  verifiable?: boolean;
  /** URL pública do item (proveniência navegável). */
  url?: string | null;
  /** Quando o item foi publicado na origem (ISO). */
  publishedAt?: string | null;
  /** Autor externo (será MASCARADO no evidence — LGPD; não é usuário da org). */
  author?: string | null;
  /** Sentimento normalizado, se o conector calculou: negative|neutral|positive. */
  sentiment?: "negative" | "neutral" | "positive" | null;
  /** Nota, se houver (ex.: 1..5). Usada pra derivar severidade. */
  rating?: number | null;
  /** Escala da nota (default 5) — pra normalizar `rating` em severidade. */
  ratingScale?: number | null;
  /** TTL opcional (ISO) — itens externos envelhecem. */
  expiresAt?: string | null;
  /** Fio da espinha única (ADR-158); omitido enraíza a própria cadeia. */
  correlationId?: string | null;
}

const SEVERITIES = new Set(["info", "attention", "risk", "critical"]);
const BASES = new Set(["fact", "estimate", "hypothesis"]);

export class ExternalSignalService {
  static enabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(radar_external_signals_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }

  /**
   * Deriva severidade quando o conector não a informa: usa nota (rating) e/ou
   * sentimento. Nota <= 40% da escala OU sentimento negativo → risk; nota mediana
   * OU neutro → attention; nota alta OU positivo → info. Sem sinal de nenhum dos
   * dois → attention (default conservador: externo desconhecido merece um olhar).
   */
  static deriveSeverity(input: { rating?: number | null; ratingScale?: number | null; sentiment?: string | null }): string {
    const { rating, sentiment } = input;
    const scale = Number(input.ratingScale) > 0 ? Number(input.ratingScale) : 5;
    if (rating != null && Number.isFinite(Number(rating))) {
      const frac = Number(rating) / scale;
      if (frac <= 0.4) return "risk";
      if (frac >= 0.8) return "info";
      return "attention";
    }
    if (sentiment === "negative") return "risk";
    if (sentiment === "positive") return "info";
    if (sentiment === "neutral") return "attention";
    return "attention";
  }

  /**
   * Confiança-base de um sinal externo. Afirmação de terceiro não é certeza:
   * verificável → 0.7 (registro objetivo lido); senão 0.5 (afirmação plausível).
   * Nunca 1 — o Radar guarda que a fonte é externa, não interna (§13).
   */
  static baseConfidence(verifiable: boolean): number {
    return verifiable ? 0.7 : 0.5;
  }

  /**
   * Ingere (ou atualiza) um sinal externo. Idempotente por `(source, externalId)`.
   * Retorna o id do sinal e a decisão de basis (útil pra observabilidade do molde).
   * Isolado por org; opt-in (checa flag). Não chama rede.
   */
  static ingest(orgId: string, input: ExternalSignalInput): {
    ok: boolean;
    reason?: string;
    signalId?: string;
    deduped?: boolean;
    basis?: string;
    severity?: string;
  } {
    if (!this.enabled(orgId)) return { ok: false, reason: "disabled" };
    const source = String(input?.source || "").trim();
    const externalId = String(input?.externalId || "").trim();
    const domain = String(input?.domain || "").trim();
    const content = String(input?.content || "").trim();
    // Proveniência é dura: sem source+externalId não há rastro/dedupe/confiança (§49).
    if (!source) return { ok: false, reason: "missing_source" };
    if (!externalId) return { ok: false, reason: "missing_external_id" };
    if (!domain) return { ok: false, reason: "missing_domain" };
    if (!content) return { ok: false, reason: "empty_content" };

    // basis: fact SÓ com verifiable; caso contrário rebaixa pra estimate (§13).
    const verifiable = !!input.verifiable;
    let basis = BASES.has(String(input.basis || "")) ? String(input.basis) : "estimate";
    if (basis === "fact" && !verifiable) basis = "estimate";

    const severity = SEVERITIES.has(String(input.severity || ""))
      ? String(input.severity)
      : this.deriveSeverity({ rating: input.rating, ratingScale: input.ratingScale, sentiment: input.sentiment });

    const signalType = String(input.signalType || "external_signal");
    const dedupeKey = `external:${source}:${externalId}`;

    const pub = BusinessSignalService.publish(orgId, {
      domain,
      signalType,
      severity,
      basis,
      confidence: this.baseConfidence(verifiable),
      occurredAt: input.publishedAt || null,
      sourceService: "ExternalSignalService",
      // A proveniência do PROVEDOR vira o par source_entity_* do ledger.
      sourceEntityType: source,
      sourceEntityId: externalId,
      subjectType: input.subjectType || null,
      subjectId: input.subjectId || null,
      expiresAt: input.expiresAt || null,
      evidence: {
        summary: content.slice(0, 200),
        origin: "external",
        source,
        externalId,
        url: input.url || null,
        publishedAt: input.publishedAt || null,
        // Autor externo mascarado — não é usuário da org e não deve vazar PII no
        // ledger (LGPD, convenção #6). Guarda só o suficiente pra desambiguar.
        author: maskIdentifier(input.author),
        sentiment: input.sentiment || null,
        rating: input.rating != null ? Number(input.rating) : null,
        ratingScale: input.rating != null ? (Number(input.ratingScale) > 0 ? Number(input.ratingScale) : 5) : null,
        verifiable,
        content: content.slice(0, 500),
      },
      premises: {
        note: verifiable
          ? "Registro externo verificável — fato do MUNDO externo, não medição interna."
          : "Afirmação externa de terceiro — não verificada; tratada como estimativa, nunca fato (§13).",
      },
      dedupeKey,
      correlationId: input.correlationId || null,
    });

    return { ok: true, signalId: pub.id, deduped: pub.deduped, basis, severity };
  }
}

export default ExternalSignalService;
