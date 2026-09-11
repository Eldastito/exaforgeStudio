import db from "./db.js";
import { randomUUID } from "node:crypto";

/**
 * OperationalDependencyService — IDO (Índice de Dependência Operacional), PRD 04 do roadmap
 * "Evolução de Marca". Transforma a DOR CENTRAL da marca (dependência operacional) num
 * DIAGNÓSTICO mensurável: o dono responde um questionário e recebe um placar 0-100 por
 * dimensão + recomendações + comparação temporal (antes → hoje → meta).
 *
 * DECISÃO DE DESIGN (Fase 0): ESPELHA a máquina de score do `SurvivalIndexService` (placar
 * ponderado 0-100 + faixa + confiança + snapshot histórico) — NÃO cria um 2º motor de score.
 * A diferença é só a ENTRADA: o SurvivalIndex deriva de dados operacionais; o IDO deriva das
 * RESPOSTAS do questionário. Domínio distinto (dependência × sobrevivência), reuso do padrão.
 *
 * POLARIDADE: o IDO é um índice de DEPENDÊNCIA — quanto MAIOR, PIOR (mais dependente). Cada
 * pergunta é uma afirmação de dependência (concordar = mais dependente); dimensões de
 * "maturidade/automação/visibilidade/continuidade" são redigidas como dependência (baixa
 * maturidade = alta dependência), pra a escala 0..4 → 0..100 ser uniforme.
 *
 * HONESTIDADE (não apresentar precisão falsa — §"Importante" do PRD): fórmula/pesos/versão
 * documentados aqui; `confidence` deriva da fração de peso respondido; sem resposta suficiente
 * o IDO é `null` (não inventa número). Isolado por org (convenção nº 1). Determinístico.
 */

export const IDO_MODEL_VERSION = 1;

interface Dimension { key: string; label: string; weight: number }
// Pesos somam 100 (fórmula documentada). Ordem não importa pro cálculo.
export const IDO_DIMENSIONS: Dimension[] = [
  { key: "owner", label: "Dependência do proprietário", weight: 20 },
  { key: "key_person", label: "Dependência de pessoa-chave", weight: 15 },
  { key: "manual_intervention", label: "Dependência de intervenção manual", weight: 13 },
  { key: "informal_knowledge", label: "Conhecimento informal (não registrado)", weight: 12 },
  { key: "process_maturity", label: "Maturidade de processos (baixa = dependente)", weight: 12 },
  { key: "memory", label: "Dependência da memória das pessoas", weight: 10 },
  { key: "automation", label: "Automação (baixa = dependente)", weight: 10 },
  { key: "visibility", label: "Visibilidade operacional (baixa = dependente)", weight: 5 },
  { key: "continuity", label: "Continuidade (pontos únicos de falha)", weight: 3 },
];

interface Question { id: string; dimension: string; text: string }
// Cada afirmação: concordar (escala alta) = MAIS dependente. Escala de resposta 0..4.
export const IDO_QUESTIONS: Question[] = [
  { id: "owner_1", dimension: "owner", text: "Se você se afastasse por 15 dias, várias operações teriam dificuldade de continuar normalmente." },
  { id: "owner_2", dimension: "owner", text: "Decisões do dia a dia geralmente precisam passar por você." },
  { id: "key_1", dimension: "key_person", text: "A ausência de algum funcionário específico comprometeria a operação." },
  { id: "key_2", dimension: "key_person", text: "Há tarefas críticas que só uma pessoa sabe fazer." },
  { id: "manual_1", dimension: "manual_intervention", text: "Muitas tarefas dependem de alguém lembrar de fazê-las manualmente." },
  { id: "manual_2", dimension: "manual_intervention", text: "Cobranças, retornos e follow-ups dependem de acompanhamento manual." },
  { id: "informal_1", dimension: "informal_knowledge", text: "Informações importantes existem só na cabeça das pessoas, sem registro." },
  { id: "process_1", dimension: "process_maturity", text: "Os processos da empresa são informais e não documentados." },
  { id: "process_2", dimension: "process_maturity", text: "Cada pessoa executa do seu jeito, sem um padrão definido." },
  { id: "memory_1", dimension: "memory", text: "A operação depende da memória das pessoas para nada passar batido." },
  { id: "automation_1", dimension: "automation", text: "Poucas tarefas repetitivas são automatizadas hoje." },
  { id: "visibility_1", dimension: "visibility", text: "É difícil saber em tempo real o que está acontecendo na operação." },
  { id: "continuity_1", dimension: "continuity", text: "Se um canal/sistema (ex.: WhatsApp) parasse, a operação pararia junto." },
];

const round1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export type IdoFaixa = "saudavel" | "moderado" | "alto" | "critico" | "indefinido";
const FAIXA_LABEL: Record<IdoFaixa, string> = {
  saudavel: "Baixa dependência", moderado: "Dependência moderada",
  alto: "Alta dependência", critico: "Dependência crítica", indefinido: "Indefinido",
};

// Recomendação advisória por dimensão (a IA/produto SUGERE; não executa). Determinística.
const RECOMMENDATION: Record<string, string> = {
  owner: "Reduza a dependência do dono: delegue decisões recorrentes e documente critérios.",
  key_person: "Reduza o risco de pessoa-chave: registre o conhecimento crítico e treine um backup.",
  manual_intervention: "Automatize lembretes e follow-ups para não depender de alguém lembrar.",
  informal_knowledge: "Registre o conhecimento informal em processos/base de conhecimento.",
  process_maturity: "Formalize e padronize os processos principais.",
  memory: "Tire a operação da memória: use tarefas, agenda e alertas.",
  automation: "Automatize tarefas repetitivas de maior volume.",
  visibility: "Ganhe visibilidade em tempo real (painel/indicadores).",
  continuity: "Reduza pontos únicos de falha (canais/sistemas) com alternativas.",
};

export interface IdoComponent { key: string; label: string; weight: number; score: number; answered: number; total: number; hasData: boolean }
export interface IdoResult {
  ido: number | null;                // 0-100 (dependência; maior = pior). null sem dado.
  faixa: IdoFaixa; faixaLabel: string;
  confidence: "alta" | "media" | "baixa";
  components: IdoComponent[];
  recommendations: { dimension: string; label: string; score: number; text: string }[];
  answeredCount: number; totalQuestions: number;
  modelVersion: number;
}

function faixaOf(ido: number | null): IdoFaixa {
  if (ido == null) return "indefinido";
  return ido >= 70 ? "critico" : ido >= 50 ? "alto" : ido >= 30 ? "moderado" : "saudavel";
}

export class OperationalDependencyService {
  /** Questionário (versionado) para a UI montar — dimensões + perguntas + escala. */
  static questionnaire() {
    return {
      modelVersion: IDO_MODEL_VERSION,
      scale: { min: 0, max: 4, labels: ["Discordo totalmente", "Discordo", "Neutro", "Concordo", "Concordo totalmente"] },
      dimensions: IDO_DIMENSIONS,
      questions: IDO_QUESTIONS,
    };
  }

  /**
   * Calcula o IDO a partir das respostas (map qid→0..4). PURO/determinístico (sem I/O).
   * Dimensão sem resposta → neutra (50) e `hasData:false` (não pesa na confiança). Sem
   * NENHUMA resposta → ido null (não inventa).
   */
  static compute(answers: Record<string, number>): IdoResult {
    const a = answers || {};
    const byDim: Record<string, number[]> = {};
    for (const q of IDO_QUESTIONS) {
      const raw: any = (a as any)[q.id];
      if (raw == null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 4) continue;
      (byDim[q.dimension] ||= []).push(clamp(n * 25)); // 0..4 → 0..100 (dependência)
    }
    const components: IdoComponent[] = IDO_DIMENSIONS.map((d) => {
      const vals = byDim[d.key] || [];
      const total = IDO_QUESTIONS.filter((q) => q.dimension === d.key).length;
      const hasData = vals.length > 0;
      const score = hasData ? round1(vals.reduce((s, v) => s + v, 0) / vals.length) : 50;
      return { key: d.key, label: d.label, weight: d.weight, score, answered: vals.length, total, hasData };
    });
    const answeredCount = components.reduce((s, c) => s + c.answered, 0);
    const totalWeight = IDO_DIMENSIONS.reduce((s, d) => s + d.weight, 0); // 100
    const dataWeight = components.filter((c) => c.hasData).reduce((s, c) => s + c.weight, 0);
    const ido = dataWeight === 0 ? null : round1(components.reduce((s, c) => s + (c.weight * c.score) / totalWeight, 0));
    const confidence = dataWeight >= 80 ? "alta" : dataWeight >= 50 ? "media" : "baixa";
    const faixa = faixaOf(ido);
    // Recomendações: dimensões COM dado, mais dependentes primeiro, só as que doem (>=50).
    const recommendations = components
      .filter((c) => c.hasData && c.score >= 50)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map((c) => ({ dimension: c.key, label: c.label, score: c.score, text: RECOMMENDATION[c.key] || "" }));
    return { ido, faixa, faixaLabel: FAIXA_LABEL[faixa], confidence, components, recommendations, answeredCount, totalQuestions: IDO_QUESTIONS.length, modelVersion: IDO_MODEL_VERSION };
  }

  /** Registra um assessment (snapshot append-only) e devolve o resultado. */
  static submit(orgId: string, answers: Record<string, number>, actor?: string): IdoResult & { id: string; createdAt: string } {
    const r = this.compute(answers);
    const id = randomUUID();
    db.prepare(`INSERT INTO operational_dependency_assessments
      (id, organization_id, ido_score, faixa, confidence, model_version, answers_json, components_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, orgId, r.ido, r.faixa, r.confidence, r.modelVersion, JSON.stringify(answers || {}), JSON.stringify(r.components), actor || null,
    );
    const row = db.prepare("SELECT created_at FROM operational_dependency_assessments WHERE id = ?").get(id) as any;
    return { ...r, id, createdAt: row?.created_at || new Date().toISOString() };
  }

  private static parseRow(row: any): any {
    if (!row) return null;
    let components: any[] = []; let answers: any = {};
    try { components = JSON.parse(row.components_json); } catch { /* noop */ }
    try { answers = JSON.parse(row.answers_json); } catch { /* noop */ }
    const faixa = (row.faixa || "indefinido") as IdoFaixa;
    return {
      id: row.id, ido: row.ido_score == null ? null : round1(row.ido_score), faixa, faixaLabel: FAIXA_LABEL[faixa] || faixa,
      confidence: row.confidence, modelVersion: row.model_version, components, answers,
      createdBy: row.created_by ?? null, createdAt: row.created_at,
    };
  }

  /** Assessment mais recente da org (ou null). Ordena por rowid (inserção) — created_at pode
   *  empatar no mesmo segundo e o id (uuid) não é monotônico. */
  static latest(orgId: string): any {
    return this.parseRow(db.prepare("SELECT * FROM operational_dependency_assessments WHERE organization_id = ? ORDER BY rowid DESC LIMIT 1").get(orgId));
  }

  /** Histórico (mais novo primeiro) — metadados leves pro gráfico de tendência. */
  static history(orgId: string, limit = 12): { id: string; ido: number | null; faixa: string; createdAt: string }[] {
    const rows = db.prepare("SELECT id, ido_score, faixa, created_at FROM operational_dependency_assessments WHERE organization_id = ? ORDER BY rowid DESC LIMIT ?").all(orgId, Math.max(1, Math.min(100, limit))) as any[];
    return rows.map((r) => ({ id: r.id, ido: r.ido_score == null ? null : round1(r.ido_score), faixa: r.faixa, createdAt: r.created_at }));
  }

  /** Meta de IDO definida pelo dono (opt-in). null = não definida (não inventa alvo). */
  static getTarget(orgId: string): number | null {
    const row = db.prepare("SELECT operational_dependency_target AS t FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return row?.t == null ? null : Number(row.t);
  }
  static setTarget(orgId: string, target: number | null): { target: number | null } {
    if (target == null) db.prepare("UPDATE organization_settings SET operational_dependency_target = NULL WHERE organization_id = ?").run(orgId);
    else {
      const n = Number(target);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Meta deve ser um número de 0 a 100.");
      db.prepare("UPDATE organization_settings SET operational_dependency_target = ? WHERE organization_id = ?").run(Math.round(n), orgId);
    }
    return { target: this.getTarget(orgId) };
  }

  /**
   * Comparação temporal (§"Evolução"): ANTES (1º assessment) → HOJE (último) → META.
   * `delta` = quanto a dependência caiu (positivo = melhorou, pois IDO menor é melhor).
   */
  static comparison(orgId: string): { before: number | null; current: number | null; target: number | null; delta: number | null; assessments: number } {
    const first = db.prepare("SELECT ido_score FROM operational_dependency_assessments WHERE organization_id = ? AND ido_score IS NOT NULL ORDER BY rowid ASC LIMIT 1").get(orgId) as any;
    const last = db.prepare("SELECT ido_score FROM operational_dependency_assessments WHERE organization_id = ? AND ido_score IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(orgId) as any;
    const count = (db.prepare("SELECT COUNT(*) AS c FROM operational_dependency_assessments WHERE organization_id = ?").get(orgId) as any)?.c || 0;
    const before = first?.ido_score == null ? null : round1(first.ido_score);
    const current = last?.ido_score == null ? null : round1(last.ido_score);
    const delta = before != null && current != null ? round1(before - current) : null; // >0 = dependência caiu
    return { before, current, target: this.getTarget(orgId), delta, assessments: Number(count) };
  }

  /** Visão consolidada pra tela: último placar + comparação + meta + histórico. */
  static overview(orgId: string): any {
    return { latest: this.latest(orgId), comparison: this.comparison(orgId), history: this.history(orgId) };
  }
}

export default OperationalDependencyService;
