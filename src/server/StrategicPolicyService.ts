/**
 * ADR-206 F5.8 — STRATEGIC POLICY com pesos (ESTENDE `ImpactPrioritizationService` — sem motor novo, RN-F5-12).
 *
 * O dono diz o que importa MAIS agora ("este trimestre: caixa e cobrança primeiro, depois vendas"), em linguagem de dono, e a
 * priorização do que atacar passa a refletir isso. Antes só havia pesos fixos por domínio no código; a empresa não tinha como dizer
 * o que é estratégico para ela.
 *
 * Como funciona (determinístico, sem LLM):
 *  - 5 OBJETIVOS (lista fechada), cada um cobrindo domínios de sinais já existentes: caixa e cobrança · vendas e crescimento ·
 *    estoque e compras · atendimento e reputação · pessoas e operação.
 *  - Peso 0–100 por objetivo; 50 = normal (neutro). Objetivo não informado vale 50.
 *  - Efeito: um FATOR MULTIPLICATIVO limitado a ±25% no score do sinal (0,75 a 1,25). É uma inclinação, não um veto: nenhum sinal some,
 *    nenhum nível de impacto (L0–L4) muda, nada de aprovação/autonomia muda. Sem política (ou vencida) o fator é 1 → priorização
 *    idêntica à de antes (0-regressão).
 *  - Domínios de segurança, conformidade, jurídico, governança e plataforma NÃO entram em nenhum objetivo: nunca são rebaixados por
 *    peso de negócio (e o override crítico de segurança/compliance continua passando na frente).
 *  - PRIORIDADE TEMPORAL: a política pode ter validade (`validUntil`); vencida volta ao neutro sozinha (estágio derivado, sem job).
 *  - Versionada e APPEND-ONLY (mudar = nova versão; voltar a uma anterior = nova versão com os pesos dela); só PESSOA define; auditada.
 *  - `preview` mostra, ANTES de salvar, como o top-3 mudaria com os pesos propostos (nada é gravado).
 * Isolado por organização.
 */
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export interface PolicyObjective { key: string; label: string; hint: string; domains: string[] }

export const OBJECTIVES: PolicyObjective[] = [
  { key: "cash", label: "Caixa e cobrança", hint: "Entrar dinheiro, cobrar, não faltar caixa.", domains: ["finance", "collection", "recovery", "pnl_reconciliation", "pnl_cost"] },
  { key: "sales", label: "Vendas e crescimento", hint: "Vender mais, recuperar vendas, atrair clientes.", domains: ["sales", "sales_recovery", "retail_ops", "retail_floor", "retail", "retail_radar", "prospect", "churn", "content", "social", "referrals"] },
  { key: "stock", label: "Estoque e compras", hint: "Ter o produto certo, comprar melhor, produzir sem atraso.", domains: ["inventory", "procurement", "production"] },
  { key: "service", label: "Atendimento e reputação", hint: "Clientes bem atendidos, agenda cheia, boa fama.", domains: ["reputation", "clinic", "beauty", "education"] },
  { key: "operations", label: "Pessoas e operação", hint: "Equipe, tarefas e rotina funcionando.", domains: ["people", "operations", "ops", "tasks"] },
];
/** Domínios que NUNCA recebem peso de negócio (documentados e testados): risco, regra e plataforma não são rebaixáveis. */
export const PROTECTED_DOMAINS = ["security", "compliance", "legal", "governance", "platform", "runtime", "outcome_assurance"];
export const NEUTRAL_WEIGHT = 50;
export const POLICY_SPAN = 0.25;       // fator ∈ [1 − 0,25 ; 1 + 0,25]
const KEYS = new Set(OBJECTIVES.map((o) => o.key));
const SYSTEM_ACTOR = /^(rule|ai|runtime|system|scheduler|agent|autopilot|mission|playbook|process|cron|bot)([:_\-\s]|$)/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayISO = () => new Date().toISOString().slice(0, 10);

export type Weights = Record<string, number>;
export interface ActivePolicy { version: number; weights: Weights; validUntil: string | null; note: string | null; setBy: string; at: string; expired: boolean }

/** Fator multiplicativo de um peso (50 → 1; 100 → 1,25; 0 → 0,75). */
export function factorOf(weight: number): number {
  const w = Math.max(0, Math.min(100, Number(weight)));
  return Math.round((1 + POLICY_SPAN * ((w - NEUTRAL_WEIGHT) / NEUTRAL_WEIGHT)) * 10000) / 10000;
}

export class StrategicPolicyService {
  /** Valida e normaliza os pesos. Só objetivos conhecidos, inteiros 0–100. */
  static validate(raw: unknown, opts: { allowEmpty?: boolean } = {}): { ok: boolean; error?: string; weights?: Weights } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Informe os pesos por objetivo." };
    const out: Weights = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!KEYS.has(k)) return { ok: false, error: `Objetivo desconhecido: ${String(k).slice(0, 40)}` };
      const n = Number(v);
      if (v === null || v === "" || !Number.isInteger(n) || n < 0 || n > 100) return { ok: false, error: `O peso de "${k}" deve ser um inteiro de 0 a 100.` };
      out[k] = n;
    }
    if (!Object.keys(out).length && !opts.allowEmpty) return { ok: false, error: "Informe pelo menos um objetivo." };
    return { ok: true, weights: out };
  }

  /** Política em vigor: a versão mais nova; vencida vira `expired` (e o fator volta a 1). null se nunca houve. */
  static active(orgId: string): ActivePolicy | null {
    const r = db.prepare("SELECT version, weights_json, valid_until, note, set_by, created_at FROM strategic_policy_versions WHERE organization_id = ? ORDER BY version DESC LIMIT 1").get(orgId) as any;
    if (!r) return null;
    let weights: Weights = {}; try { weights = JSON.parse(r.weights_json || "{}"); } catch { weights = {}; }
    const expired = !!r.valid_until && String(r.valid_until) < todayISO();
    return { version: Number(r.version), weights, validUntil: r.valid_until || null, note: r.note || null, setBy: r.set_by, at: r.created_at, expired };
  }

  /** Mapa domínio → { fator, objetivo, peso } da política VIGENTE (ou da proposta, no preview). Vazio = neutro. */
  static factors(orgId: string, override?: Weights | null): Map<string, { factor: number; objective: string; weight: number }> {
    const map = new Map<string, { factor: number; objective: string; weight: number }>();
    let weights: Weights | null = override ?? null;
    if (!weights) { const a = this.active(orgId); if (a && !a.expired) weights = a.weights; }
    if (!weights) return map;
    for (const o of OBJECTIVES) {
      const w = weights[o.key];
      if (w === undefined || w === NEUTRAL_WEIGHT) continue;
      for (const d of o.domains) if (!PROTECTED_DOMAINS.includes(d)) map.set(d, { factor: factorOf(w), objective: o.key, weight: w });
    }
    return map;
  }

  /** Define uma NOVA versão da política (append-only). Só PESSOA. `weights` vazio só pelo `reset`. */
  static set(orgId: string, input: { weights: unknown; validUntil?: unknown; note?: unknown }, actor: string | null | undefined): { ok: boolean; error?: string; version?: number; policy?: ActivePolicy | null } {
    const by = String(actor || "").trim();
    if (!by) return { ok: false, error: "Definir a política exige uma pessoa identificada." };
    if (SYSTEM_ACTOR.test(by)) return { ok: false, error: "Só uma pessoa define a política estratégica da empresa." };
    const v = this.validate(input.weights);
    if (!v.ok) return v;
    return this.write(orgId, v.weights!, input.validUntil, input.note, by, "STRATEGIC_POLICY_SET");
  }

  /** Volta ao neutro (nova versão sem pesos). Só PESSOA; o histórico fica. */
  static reset(orgId: string, actor: string | null | undefined, note?: unknown): { ok: boolean; error?: string; version?: number } {
    const by = String(actor || "").trim();
    if (!by) return { ok: false, error: "Voltar ao normal exige uma pessoa identificada." };
    if (SYSTEM_ACTOR.test(by)) return { ok: false, error: "Só uma pessoa altera a política estratégica da empresa." };
    return this.write(orgId, {}, null, note, by, "STRATEGIC_POLICY_RESET");
  }

  private static write(orgId: string, weights: Weights, validUntilRaw: unknown, noteRaw: unknown, by: string, event: string) {
    let validUntil: string | null = null;
    if (validUntilRaw !== undefined && validUntilRaw !== null && validUntilRaw !== "") {
      const s = String(validUntilRaw);
      if (!DATE.test(s) || Number.isNaN(Date.parse(s))) return { ok: false as const, error: "A validade deve ser uma data AAAA-MM-DD." };
      if (s < todayISO()) return { ok: false as const, error: "A validade não pode estar no passado." };
      validUntil = s;
    }
    const note = noteRaw ? String(noteRaw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 300) || null : null;
    const exists = db.prepare("SELECT 1 FROM organization_settings WHERE organization_id = ?").get(orgId);
    if (!exists) return { ok: false as const, error: "Empresa não encontrada." };
    let version = 0;
    db.transaction(() => {
      const last = db.prepare("SELECT MAX(version) v FROM strategic_policy_versions WHERE organization_id = ?").get(orgId) as any;
      version = Number(last?.v || 0) + 1;
      db.prepare("INSERT INTO strategic_policy_versions (id, organization_id, version, weights_json, valid_until, note, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(`${orgId}:${version}`, orgId, version, JSON.stringify(weights), validUntil, note, by);
    })();
    try { logAuthEvent(orgId, by, orgId, event, { version, weights, validUntil }); } catch { /* best-effort */ }
    return { ok: true as const, version, policy: this.active(orgId) };
  }

  /** Histórico (mais novo primeiro). */
  static history(orgId: string, limit = 20) {
    return (db.prepare("SELECT version, weights_json, valid_until, note, set_by, created_at FROM strategic_policy_versions WHERE organization_id = ? ORDER BY version DESC LIMIT ?").all(orgId, Math.max(1, Math.min(100, Number(limit) || 20))) as any[])
      .map((r) => { let w: Weights = {}; try { w = JSON.parse(r.weights_json || "{}"); } catch { /* linha torta */ } return { version: Number(r.version), weights: w, validUntil: r.valid_until || null, note: r.note || null, setBy: r.set_by, at: r.created_at }; });
  }

  /** Visão do dono: objetivos com o peso vigente e o efeito (fator), a política e o que ela NÃO faz. */
  static explain(orgId: string) {
    const a = this.active(orgId);
    const live = a && !a.expired ? a.weights : {};
    return {
      neutralWeight: NEUTRAL_WEIGHT, effectRange: { min: 1 - POLICY_SPAN, max: 1 + POLICY_SPAN },
      active: a, inEffect: !!a && !a.expired && Object.keys(a.weights).length > 0,
      objectives: OBJECTIVES.map((o) => { const w = live[o.key] ?? NEUTRAL_WEIGHT; return { key: o.key, label: o.label, hint: o.hint, weight: w, factor: factorOf(w), domains: o.domains }; }),
      protectedDomains: PROTECTED_DOMAINS,
      note: "A política inclina a ordem do que atacar em até 25%: não esconde nenhum aviso, não muda o nível de impacto nem quem precisa aprovar. Segurança, conformidade, jurídico e governança nunca são rebaixados.",
    };
  }

  /** Antes de salvar: como o top mudaria com os pesos propostos. Nada é gravado. */
  static async preview(orgId: string, rawWeights: unknown, topN = 5) {
    const v = this.validate(rawWeights);
    if (!v.ok) return v;
    const { ImpactPrioritizationService } = await import("./ImpactPrioritizationService.js");
    const take = (p: any) => (p.global || []).map((x: any) => ({ signalId: x.signalId, domain: x.domain, signalType: x.signalType, score: x.score, rank: x.rank }));
    const cur = ImpactPrioritizationService.prioritize(orgId, { globalLimit: topN });
    const next = ImpactPrioritizationService.prioritize(orgId, { globalLimit: topN, policyWeights: v.weights } as any);
    const before = take(cur), after = take(next);
    return { ok: true, weights: v.weights, before, after, changed: JSON.stringify(before.map((x: any) => x.signalId)) !== JSON.stringify(after.map((x: any) => x.signalId)), saved: false };
  }
}

export default StrategicPolicyService;
