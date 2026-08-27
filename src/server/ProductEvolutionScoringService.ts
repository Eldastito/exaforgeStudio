/**
 * ProductEvolutionScoringService — ADR-193 F3.
 *
 * Score 0–100 determinístico por item do Product Evolution Ledger. Base
 * é o §6 do PRD-PEL-01, que define 9 dimensões com pesos totalizando 100:
 *
 *   arch (10) + backend (20) + ui (10) + tests (15) + security (10) +
 *   observability (10) + rollout (10) + ops (5) + validation (10) = 100
 *
 * O score é secundário ao estado: a UI mostra o estado como coisa primária
 * (badge grande) e o score como número pequeno. Escrito assim em
 * `docs/product-evolution/CONVENCOES.md §4` — impedir que score vire métrica
 * de vaidade. É por isso que existe também `notes[]`: se o score bate um
 * cap por estado ou por dimensão faltante, o motivo é explícito.
 *
 * Determinístico e sem LLM (RN-PEL-6 de reconciliação). Mesmo input →
 * mesmo output. Sem cache, sem side-effect — chamar N vezes é seguro.
 *
 * Regras hard (PRD §6):
 *   - Sem runtime real → cap 49 (só arch + tests + docs, nada de PRODUCTION)
 *   - Só PRD/ADR → cap 20 (só sources, zero evidência de código)
 *   - Só UI sem backend real → cap 30
 *   - Stub/dados simulados reduzem a dimensão runtime (aplicado quando
 *     description contém "stub" ou metadata.stub=true)
 *   - PRODUCTION sem evidência de validação → não passa dos 79 (cap parcial)
 */
import db from "./db.js";
import { ProductEvolutionLedgerService, Item, Evidence, Status } from "./ProductEvolutionLedgerService.js";

// Pesos por dimensão (soma = 100). Vindos do §6 do PRD.
export const DIMENSION_WEIGHTS = {
  arch: 10,
  backend: 20,
  ui: 10,
  tests: 15,
  security: 10,
  observability: 10,
  rollout: 10,
  ops: 5,
  validation: 10,
} as const;
export type Dimension = keyof typeof DIMENSION_WEIGHTS;

// Cada evidência verificada contribui para 1..N dimensões. Um evidence_type
// mapeia para um conjunto explícito — sem overlap ambíguo. Security aparece
// como aspecto transversal em code/tests/pr/runbook: código passa por review
// (PR), tests cobrem RBAC/isolamento, runbook documenta procedimentos de
// segurança. Se um tenant de segurança falhar, é isso que precisa mudar aqui.
const EVIDENCE_TO_DIMENSIONS: Record<string, Dimension[]> = {
  code:                ["backend", "security"],       // review de PR inclui security
  migration:           ["backend"],
  route:               ["backend"],
  ui:                  ["ui"],
  test:                ["tests", "security"],         // testes cobrem RBAC/isolamento
  test_run:            ["tests", "observability"],    // passar em CI é sinal operacional
  pr:                  ["arch", "security"],          // PR mergeado é evidência de arch + security review
  commit:              [],                            // commit avulso não conta
  rollout:             ["rollout"],
  production_check:    ["validation", "observability"],
  runbook:             ["ops", "security"],           // runbook documenta procedimentos de segurança
  metric:              ["observability", "validation"],
  customer_validation: ["validation"],
};

export interface DimensionScore {
  dimension: Dimension;
  weight: number;         // teto absoluto (do DIMENSION_WEIGHTS)
  raw_hits: number;       // # evidências verificadas contribuindo
  earned: number;         // 0..weight
  saturated: boolean;     // true se raw_hits ≥ 2 (evidência convergente)
}

export interface ScoreResult {
  evolution_key: string;
  status: Status;
  total: number;                    // 0..100 arredondado
  raw_total: number;                // pré-cap, arredondado
  cap_applied: number | null;       // teto aplicado ou null
  cap_reason: string | null;        // por que o cap
  dimensions: DimensionScore[];
  notes: string[];                  // observações explicando o cálculo
  computed_at: string;              // ISO
}

export class ProductEvolutionScoringService {

  /**
   * Calcula o score de 1 item. Retorna null se o item não existe (a rota
   * converte em 404).
   */
  static computeScore(evolution_key: string): ScoreResult | null {
    const item = ProductEvolutionLedgerService.getItem(evolution_key);
    if (!item) return null;
    const evidence = ProductEvolutionLedgerService.listEvidence(evolution_key);
    return this.computeFrom(item, evidence);
  }

  /** Score derivado sem re-fetch — usado por listAllScores para eficiência. */
  static computeFrom(item: Item, evidence: Evidence[]): ScoreResult {
    const verified = evidence.filter(e => e.verified === 1);
    const notes: string[] = [];

    // 1) Conta hits por dimensão
    const hits: Record<Dimension, number> = {
      arch: 0, backend: 0, ui: 0, tests: 0, security: 0,
      observability: 0, rollout: 0, ops: 0, validation: 0,
    };
    for (const e of verified) {
      const dims = EVIDENCE_TO_DIMENSIONS[e.evidence_type] || [];
      // Stub reduz peso — se a evidência descreve stub/simulado, sinaliza mas ainda conta 1x
      // (não zera; a nota explica).
      const isStub = /\b(stub|mock|simulad[oa]|fake)\b/i.test(e.description || "");
      if (isStub && dims.includes("backend")) {
        notes.push(`evidência ${e.id.slice(0, 8)} marcada como stub — reduz peso de backend`);
      }
      for (const d of dims) {
        hits[d] += isStub && d === "backend" ? 0.5 : 1;
      }
    }

    // 2) Calcula earned por dimensão. Modelo simples:
    //    - 0 hits: 0 pontos
    //    - 1 hit: 60% do peso
    //    - ≥2 hits: 100% do peso (evidência convergente = saturação)
    const dimensions: DimensionScore[] = [];
    let rawTotal = 0;
    for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS) as [Dimension, number][]) {
      const h = hits[dim];
      let earned = 0;
      if (h >= 2) earned = weight;
      else if (h >= 1) earned = Math.round(weight * 0.6);
      else if (h > 0) earned = Math.round(weight * 0.3); // meio stub → 30%
      dimensions.push({ dimension: dim, weight, raw_hits: h, earned, saturated: h >= 2 });
      rawTotal += earned;
    }

    // 3) Aplica caps (§6 do PRD). Ordem importa — pega o menor cap aplicável.
    const totalHits = Object.values(hits).reduce((a, b) => a + b, 0);
    const uiHits = hits.ui;
    const runtimeHits = hits.backend; // "runtime real" = code + migration + route
    const testsHits = hits.tests;
    const validationHits = hits.validation;
    const isTerminal = item.status === "REJECTED" || item.status === "SUPERSEDED";

    let cap: number | null = null;
    let capReason: string | null = null;

    if (isTerminal) {
      // Terminal: score espelha o estado, sem cap especial. Passa direto.
    } else if (totalHits === 0) {
      cap = 20;
      capReason = "sem evidência verificada — só doc/PRD conta como máximo 20";
    } else if (runtimeHits === 0 && uiHits > 0) {
      cap = 30;
      capReason = "só UI sem backend real (falta code/route/migration) — cap 30";
    } else if (runtimeHits === 0 && (item.status === "IMPLEMENTING" || item.status === "CODED")) {
      cap = 49;
      capReason = `status ${item.status} sem evidência de runtime real (code/route/migration) — cap 49`;
    } else if (testsHits === 0 && (item.status === "TESTED" || item.status === "PILOT" || item.status === "PRODUCTION" || item.status === "VALIDATED")) {
      cap = 49;
      capReason = `status ${item.status} sem evidência de teste verificada — cap 49`;
    } else if (validationHits === 0 && (item.status === "PRODUCTION" || item.status === "VALIDATED")) {
      cap = 79;
      capReason = `status ${item.status} sem evidência de validação (metric/production_check/customer_validation) — cap 79`;
    }

    let total = rawTotal;
    if (cap !== null) {
      // Sempre registra o cap aplicável na nota, mesmo se total ainda não bateu
      // (transparência: quem lê a nota entende o teto que o cálculo carrega).
      notes.push(`cap ${cap} aplicado: ${capReason}`);
      if (total > cap) total = cap;
    }

    // 4) Notas explicativas adicionais
    if (item.blocked_reason) {
      notes.push(`item bloqueado: ${item.blocked_reason}`);
    }
    if (item.status === "SUPERSEDED" && item.superseded_by) {
      notes.push(`substituído por ${item.superseded_by}`);
    }

    return {
      evolution_key: item.evolution_key,
      status: item.status as Status,
      total,
      raw_total: rawTotal,
      cap_applied: cap,
      cap_reason: capReason,
      dimensions,
      notes,
      computed_at: new Date().toISOString(),
    };
  }

  /**
   * Score de todos os items do ledger. Usado pelo dashboard/UI e por relatórios
   * agregados. Batch-fetch de evidência via JOIN pra evitar N+1.
   */
  static listAllScores(): ScoreResult[] {
    const items = db.prepare("SELECT * FROM product_evolution_items WHERE archived_at IS NULL ORDER BY evolution_key").all() as Item[];
    const allEvidence = db.prepare("SELECT * FROM product_evolution_evidence").all() as Evidence[];
    // Agrupa por item_id em memória
    const byItem = new Map<string, Evidence[]>();
    for (const e of allEvidence) {
      if (!byItem.has(e.item_id)) byItem.set(e.item_id, []);
      byItem.get(e.item_id)!.push(e);
    }
    return items.map(item => this.computeFrom(item, byItem.get(item.id) || []));
  }
}

export default ProductEvolutionScoringService;
