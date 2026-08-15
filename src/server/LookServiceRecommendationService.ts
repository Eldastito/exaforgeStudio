/**
 * LookServiceRecommendationService (ADR-169 F9 / BEAUTY-009).
 *
 * O ELO COMERCIAL da Beauty AI: transforma a simulação (F6) em
 * agendamento potencial recomendando serviços do CATÁLOGO REAL do
 * tenant (`products_services` type='service' active=1). É a diferença
 * entre "brincou de mudar o cabelo" e "veja quais serviços do Studio
 * fazem exatamente esse visual".
 *
 * Regra fundante RN-BS-02: **IA NUNCA sugere serviço/preço fora do
 * catálogo do tenant.** Determinístico (0 LLM). Fontes de match:
 *
 *  (a) **`beauty_reference_looks.suggested_services_json`** (F5) — o
 *      salão cura manualmente quais serviços produzem cada visual;
 *      quando a simulação usa um `reference_look_id`, esses serviços
 *      têm PRIORIDADE (relevance='primary'). Validação: cada
 *      `service_id` do JSON precisa existir em `products_services`
 *      do MESMO tenant e estar ATIVO (senão é ignorado — RN-BS-11
 *      não infere serviço extinto).
 *
 *  (b) **Match por keyword no `name` do serviço** — cor pede
 *      coloração/tinta/mechas/balayage/luzes; corte pede corte/escova/
 *      finalização. Termos vêm de mapa fechado (nunca texto arbitrário
 *      da cliente). Serviços que batem viram relevance='matched'.
 *
 *  (c) **Fallback vazio quando catálogo não tem nada compatível** —
 *      retorna `insufficient_catalog` (com contagem total de serviços
 *      ativos, pra UI orientar o dono a cadastrar). NUNCA inventa
 *      nome/preço/descrição de serviço inexistente.
 *
 * Guardrails RN-BS:
 *  - RN-BS-02: matching filtra `type='service'` (products/reservations
 *    são ignorados) e `active=1` + `organization_id = orgId`.
 *  - RN-BS-07: isolamento cross-tenant duro; consulta/simulação/refLook
 *    de outra org → 404.
 *  - RN-BS-11: sem match → `insufficient_catalog`; sem simulation e
 *    sem consulta → recusa (não recomenda no vácuo).
 *  - Read-only: NUNCA escreve no banco. Cada chamada é uma query pura.
 */
import db from "./db.js";
import { BeautyVisualConsultationService } from "./BeautyVisualConsultationService.js";
import { BeautyHairSimulationService } from "./BeautyHairSimulationService.js";

// Vocabulário FIXO de keywords por tipo de simulação. Nunca aceita texto
// arbitrário — cada termo aqui é derivado do vocab do Simulador (F6) +
// termos comerciais do salão (coloração é uma palavra do domínio, não
// vem da cliente).
const KEYWORDS_COLOR = [
  "colora",          // coloração, colorar, colorista
  "cor de cabelo",
  "tintura", "tinta",
  "mecha", "mechas",
  "balayage",
  "luzes",           // "luzes" = mechas claras
  "morena iluminada",
  "ombre",
  "reflexo", "reflexos",
  "tonaliz",         // tonalização
  "descolora",       // descoloração
  "matiz", "matizador",
];
const KEYWORDS_CUT = [
  "corte", "cortar",
  "escova",           // escova é um FINAL, não um corte, mas normalmente
                      // vendido junto — o dono decide manter ou não
  "chapinha",
  "finaliza",         // finalização
  "penteado",
  "franja",
];

export const RECOMMENDATION_RELEVANCE = ["primary", "matched", "generic"] as const;
export type RecommendationRelevance = (typeof RECOMMENDATION_RELEVANCE)[number];

export interface ServiceRecommendation {
  serviceId: string;
  name: string;
  price: number | null;
  durationMinutes: number | null;
  category: string | null;
  relevance: RecommendationRelevance;
  matchReason: string;
}

export interface RecommendationResult {
  ok: true;
  simulationId: string | null;
  consultationId: string;
  referenceLookId: string | null;
  activeCatalogCount: number;
  recommendations: ServiceRecommendation[];
}
export interface RecommendationEmpty {
  ok: false;
  reason: "insufficient_catalog" | "not_found" | "sem_parametros";
  simulationId: string | null;
  consultationId: string | null;
  activeCatalogCount: number;
  message: string;
}

export class LookServiceRecommendationService {
  /** Vocab exposto pra UI (rota /vocabulary/recommendations). */
  static vocabulary() {
    return {
      relevance: RECOMMENDATION_RELEVANCE,
      keywords: { color: [...KEYWORDS_COLOR], cut: [...KEYWORDS_CUT] },
    };
  }

  /**
   * Recomenda serviços baseado em UMA SIMULAÇÃO específica. Precedência:
   *   1. `suggested_services_json` do `beauty_reference_looks` (F5) —
   *      relevance='primary' (curadoria manual do salão).
   *   2. Match por keyword em `products_services.name` conforme
   *      `simulation_type` (color/cut/combined) — relevance='matched'.
   *   3. Sem match nenhum → `insufficient_catalog`.
   */
  static recommendForSimulation(
    orgId: string,
    simulationId: string,
  ): RecommendationResult | RecommendationEmpty {
    const sim = BeautyHairSimulationService.getSimulation(orgId, simulationId);
    if (!sim) return this.empty(orgId, "not_found", "Simulação não encontrada.", null, null);

    const params = sim.parameters || {};
    const color = params.color || null;
    const cut = params.cut || null;
    const referenceLookId = params.referenceLookId || sim.referenceLookId || null;

    // Se não há sinal comercial (nem cor/corte/refLook), não temos como
    // recomendar sem inventar. RN-BS-11.
    if (!color && !cut && !referenceLookId) {
      return this.empty(orgId, "sem_parametros",
        "Simulação sem parâmetros comerciais (cor/corte/reference_look).",
        simulationId, sim.consultationId);
    }

    return this.recommend(orgId, {
      consultationId: sim.consultationId,
      simulationId,
      referenceLookId,
      simulationType: sim.simulationType,
      color, cut,
    });
  }

  /**
   * Recomenda serviços baseado numa CONSULTA (usa goal/intensity da
   * consulta em vez de params específicos de uma simulação). Útil pra
   * uma vitrine rápida antes mesmo do cliente escolher uma simulação.
   * Precedência igual: reference_look_id (se a consulta escolheu um)
   * → keyword match por goal → fallback.
   */
  static recommendForConsultation(
    orgId: string,
    consultationId: string,
  ): RecommendationResult | RecommendationEmpty {
    const cons = BeautyVisualConsultationService.getConsultation(orgId, consultationId);
    if (!cons) return this.empty(orgId, "not_found", "Consulta não encontrada.", null, null);

    const goal = String(cons.goal || "").toLowerCase();
    // Deriva "categoria" do goal do cliente (livre → keyword grosseiro):
    // "cor"/"colora"/"mecha"/"balaya" → color
    // "corte"/"escova"/"franja"/"visual"/"estilo" → cut
    // "completo"/"transforma" → ambos (simulationType='combined')
    let simulationType: "color" | "cut" | "combined" | null = null;
    if (goal) {
      const isColor = /cor|colora|mecha|balaya|luzes|matiz/.test(goal);
      const isCut = /corte|escova|franja|visual|estilo|penteado/.test(goal);
      if (isColor && isCut) simulationType = "combined";
      else if (isColor) simulationType = "color";
      else if (isCut) simulationType = "cut";
      else if (/completo|transforma/.test(goal)) simulationType = "combined";
    }
    if (!simulationType) {
      return this.empty(orgId, "sem_parametros",
        "Consulta sem sinal comercial claro (goal não bateu com vocabulário).",
        null, consultationId);
    }
    return this.recommend(orgId, {
      consultationId,
      simulationId: null,
      referenceLookId: null,       // consulta não amarra reference_look diretamente
      simulationType,
      color: null,
      cut: null,
    });
  }

  /** Núcleo de recomendação — read-only, determinístico. */
  private static recommend(
    orgId: string,
    input: {
      consultationId: string;
      simulationId: string | null;
      referenceLookId: string | null;
      simulationType: "color" | "cut" | "combined";
      color: string | null;
      cut: string | null;
    },
  ): RecommendationResult | RecommendationEmpty {
    const activeCatalogCount = (db.prepare(
      `SELECT COUNT(*) c FROM products_services WHERE organization_id = ? AND type = 'service' AND active = 1`,
    ).get(orgId) as any).c as number;

    // (a) reference_look_id → suggested_services_json
    const primaryIds: string[] = [];
    let refName: string | null = null;
    if (input.referenceLookId) {
      const refLook = db.prepare(
        `SELECT id, name, suggested_services_json FROM beauty_reference_looks
          WHERE organization_id = ? AND id = ? AND active = 1`,
      ).get(orgId, input.referenceLookId) as any;
      if (refLook) {
        refName = refLook.name;
        try {
          const arr = JSON.parse(refLook.suggested_services_json || "[]");
          if (Array.isArray(arr)) for (const id of arr) if (typeof id === "string" && id) primaryIds.push(id);
        } catch { /* JSON quebrado: ignora silenciosamente — nunca inventa */ }
      }
    }

    const seen = new Set<string>();
    const out: ServiceRecommendation[] = [];

    // Materializa os primários VALIDANDO cada id contra o catálogo real
    // (RN-BS-02 — nunca sugere serviço que não existe/está inativo/é de
    // outra org).
    if (primaryIds.length) {
      const services = db.prepare(
        `SELECT id, name, price, duration_minutes, category
           FROM products_services
          WHERE organization_id = ?
            AND type = 'service'
            AND active = 1
            AND id IN (${primaryIds.map(() => "?").join(",")})`,
      ).all(orgId, ...primaryIds) as any[];
      // Reordena pra preservar a ordem do JSON (curadoria do dono)
      const byId = new Map(services.map((s) => [s.id, s]));
      for (const id of primaryIds) {
        const s = byId.get(id);
        if (!s) continue; // id do JSON não bate no catálogo — ignora (nunca inventa)
        out.push({
          serviceId: s.id,
          name: s.name,
          price: s.price != null ? Number(s.price) : null,
          durationMinutes: s.duration_minutes != null ? Number(s.duration_minutes) : null,
          category: s.category || null,
          relevance: "primary",
          matchReason: refName
            ? `Curado pelo salão como parte do visual "${refName}"`
            : "Curado pelo salão como parte do visual de referência",
        });
        seen.add(s.id);
      }
    }

    // (b) Match por keyword — só busca se ainda estamos abaixo de
    // uma quantidade útil (limite 6 no total). Isso evita ruído
    // quando o dono já curou tudo.
    const LIMIT = 6;
    if (out.length < LIMIT) {
      const keywords = new Set<string>();
      if (input.simulationType === "color" || input.simulationType === "combined") {
        for (const k of KEYWORDS_COLOR) keywords.add(k);
      }
      if (input.simulationType === "cut" || input.simulationType === "combined") {
        for (const k of KEYWORDS_CUT) keywords.add(k);
      }
      if (keywords.size) {
        // LIKE OR chain — SQLite handled OK pra dezenas de termos.
        const whereClauses = [...keywords].map(() => "LOWER(name) LIKE ?").join(" OR ");
        const likeArgs = [...keywords].map((k) => `%${k}%`);
        const services = db.prepare(
          `SELECT id, name, price, duration_minutes, category
             FROM products_services
            WHERE organization_id = ?
              AND type = 'service'
              AND active = 1
              AND (${whereClauses})
            ORDER BY name ASC
            LIMIT ?`,
        ).all(orgId, ...likeArgs, LIMIT * 2) as any[];  // *2 pra depois dedupe

        for (const s of services) {
          if (seen.has(s.id)) continue;
          if (out.length >= LIMIT) break;
          // Encontra QUAL keyword bateu (pra `matchReason` clara)
          const lc = String(s.name || "").toLowerCase();
          const hit = [...keywords].find((k) => lc.includes(k)) || "keyword";
          const catLabel = input.simulationType === "combined" ? "mudança visual"
                          : input.simulationType === "color" ? "cor" : "corte/estilo";
          out.push({
            serviceId: s.id,
            name: s.name,
            price: s.price != null ? Number(s.price) : null,
            durationMinutes: s.duration_minutes != null ? Number(s.duration_minutes) : null,
            category: s.category || null,
            relevance: "matched",
            matchReason: `Nome do serviço menciona "${hit}" — bate com ${catLabel}`,
          });
          seen.add(s.id);
        }
      }
    }

    if (!out.length) {
      return this.empty(orgId, "insufficient_catalog",
        activeCatalogCount === 0
          ? "Catálogo vazio — cadastre serviços para receber recomendações."
          : "Nenhum serviço no catálogo bate com esta simulação. O salão pode cadastrar serviços marcados como coloração/corte/mechas ou curar via 'beauty_reference_looks'.",
        input.simulationId, input.consultationId);
    }

    return {
      ok: true,
      simulationId: input.simulationId,
      consultationId: input.consultationId,
      referenceLookId: input.referenceLookId,
      activeCatalogCount,
      recommendations: out,
    };
  }

  private static empty(
    orgId: string,
    reason: RecommendationEmpty["reason"],
    message: string,
    simulationId: string | null,
    consultationId: string | null,
  ): RecommendationEmpty {
    const activeCatalogCount = (db.prepare(
      `SELECT COUNT(*) c FROM products_services WHERE organization_id = ? AND type = 'service' AND active = 1`,
    ).get(orgId) as any).c as number;
    return { ok: false, reason, simulationId, consultationId, activeCatalogCount, message };
  }
}
