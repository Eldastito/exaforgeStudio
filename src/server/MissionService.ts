import { randomUUID } from "crypto";
import db from "./db.js";
import { BusinessGoalService } from "./BusinessGoalService.js";

/**
 * MissionService — ADR-189 F1 (Mission OS): o MISSION CONTRACT.
 *
 * Uma MISSÃO é uma INICIATIVA de negócio limitada — estado final desejado + prazo +
 * critério de sucesso (PRD §6/§7) — distinta de tarefa/campanha/processo. A auditoria
 * F0 decidira estender `business_goals`; o schema REAL corrige isso (D1 do ADR-189):
 * `business_goals` é SINGLETON por métrica (UNIQUE(org,metric)) e não comporta várias
 * missões concorrentes. Então a Missão é uma ENTIDADE FINA PRÓPRIA (`missions`) que
 * COMPÕE o registro de métricas do `BusinessGoal` pra medir — NÃO é uma linha de goal,
 * e NÃO duplica o Goal (Goal = alvo permanente por métrica; Missão = iniciativa bounded).
 *
 * F1 entrega SÓ o contrato + CRUD governado. Nada de planejamento/execução/UX (fatias
 * seguintes). Aditivo, opt-in por `organization_settings.mission_layer_enabled` (default 0).
 *
 * Guardrails RN-MOL (testados):
 *   - RN-MOL-1 composição, não duplicação: reusa `BusinessGoalService.isKnownMetric`.
 *   - RN-MOL-2 Missão = entidade própria (não é linha de goal).
 *   - RN-MOL-4 shadow-first (D6): missão NASCE `off`; NUNCA aceita `autopilot` (nem no create
 *     nem no setAutonomy) — autonomia plena exige evidência (fatia F11), não é declarável aqui.
 *   - RN-MOL: isolamento por org (toda query filtra organization_id); nunca inventa (target_metric
 *     desconhecida → erro; sem alvo → qualitativa honesta); histórico preservado (cancel = status,
 *     nunca DELETE, convenção nº 9).
 */

export const MISSION_STATUSES = [
  "draft", "planning", "ready", "running", "at_risk",
  "waiting_approval", "blocked", "achieved", "failed", "cancelled",
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_AUTONOMY = ["off", "shadow", "suggest", "approval", "autopilot"] as const;
export type MissionAutonomy = (typeof MISSION_AUTONOMY)[number];

export const MISSION_SOURCES = ["user", "system_proposed", "system_generated"] as const;
export type MissionSource = (typeof MISSION_SOURCES)[number];

// §8 — tradução dos estados pra linguagem simples (a UI nunca mostra o código cru).
const HUMAN_STATUS: Record<MissionStatus, string> = {
  draft: "Rascunho",
  planning: "Planejando",
  ready: "Pronta pra começar",
  running: "Em andamento",
  at_risk: "⚠️ Em risco",
  waiting_approval: "Aguardando você",
  blocked: "Bloqueada",
  achieved: "Concluída",
  failed: "Não atingida",
  cancelled: "Cancelada",
};

export interface Mission {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  desiredState: string | null;
  baselineState: string | null;
  targetMetric: string | null;
  targetValue: number | null;
  targetUnit: string | null;
  deadline: string | null;
  owner: string | null;
  autonomyLevel: MissionAutonomy;
  source: MissionSource;
  status: MissionStatus;
  humanStatus: string;
  confidence: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionInput {
  title: string;
  description?: string | null;
  desiredState?: string | null;
  baselineState?: string | null;
  targetMetric?: string | null;
  targetValue?: number | null;
  targetUnit?: string | null;
  deadline?: string | null;
  owner?: string | null;
  autonomyLevel?: string | null;
  source?: string | null;
  confidence?: number | null;
}

function clampConfidence(c: unknown): number | null {
  if (c == null || c === "") return null;
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export class MissionService {
  /** Flag opt-in do Mission Layer (0-regressão: desligada por padrão). */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT mission_layer_enabled AS e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return !!r && Number(r.e) === 1;
    } catch { return false; }
  }

  /** Liga/desliga o Mission Layer pra org (decisão do dono — habilitação do piloto). Reversível,
   *  aditivo, 0-regressão: desligar NUNCA apaga missões (histórico preservado, convenção nº 9),
   *  só some da navegação/superfícies. Idempotente. */
  static setEnabled(orgId: string, enabled: boolean, _actor?: string): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET mission_layer_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled: this.isEnabled(orgId) };
  }

  /** Estado de habilitação + postura proativa (pro painel de configuração/piloto). Read-only. */
  static settings(orgId: string): { enabled: boolean; proactiveMode: string; missionCount: number } {
    let proactiveMode = "off"; let missionCount = 0;
    try { const r = db.prepare(`SELECT mission_proactive_mode AS m FROM organization_settings WHERE organization_id = ?`).get(orgId) as any; if (r?.m) proactiveMode = String(r.m); } catch { /* coluna pode não existir em legado */ }
    try { missionCount = Number((db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id = ?`).get(orgId) as any).n); } catch { /* noop */ }
    return { enabled: this.isEnabled(orgId), proactiveMode, missionCount };
  }

  static humanStatus(status: string): string {
    return HUMAN_STATUS[(status as MissionStatus)] || status;
  }

  private static row(r: any): Mission {
    return {
      id: r.id,
      organizationId: r.organization_id,
      title: r.title,
      description: r.description ?? null,
      desiredState: r.desired_state ?? null,
      baselineState: r.baseline_state ?? null,
      targetMetric: r.target_metric ?? null,
      targetValue: r.target_value != null ? Number(r.target_value) : null,
      targetUnit: r.target_unit ?? null,
      deadline: r.deadline ?? null,
      owner: r.owner ?? null,
      autonomyLevel: (r.autonomy_level || "off") as MissionAutonomy,
      source: (r.source || "user") as MissionSource,
      status: (r.mission_status || "draft") as MissionStatus,
      humanStatus: this.humanStatus(r.mission_status || "draft"),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  static create(orgId: string, input: MissionInput, actor?: string): Mission {
    const title = String(input?.title || "").trim();
    if (!title) throw new Error("Missão exige um título.");

    // Métrica conhecida OU null (missão qualitativa). Nunca inventa métrica (RN-MOL-1).
    const targetMetric = input.targetMetric ? String(input.targetMetric) : null;
    if (targetMetric && !BusinessGoalService.isKnownMetric(targetMetric)) {
      throw new Error(`Métrica desconhecida: ${targetMetric}.`);
    }

    // Autonomia: enum válido; NASCE off; autopilot proibido no nascimento (RN-MOL-4/D6).
    let autonomy: MissionAutonomy = "off";
    if (input.autonomyLevel != null && input.autonomyLevel !== "") {
      const a = String(input.autonomyLevel);
      if (!MISSION_AUTONOMY.includes(a as MissionAutonomy)) throw new Error(`Nível de autonomia inválido: ${a}.`);
      if (a === "autopilot") throw new Error("Uma missão não pode nascer em autopilot — a autonomia plena exige evidência (shadow-first).");
      autonomy = a as MissionAutonomy;
    }

    const source = ((): MissionSource => {
      const s = input.source ? String(input.source) : "user";
      if (!MISSION_SOURCES.includes(s as MissionSource)) throw new Error(`Origem inválida: ${s}.`);
      return s as MissionSource;
    })();

    const id = randomUUID();
    db.prepare(`
      INSERT INTO missions (id, organization_id, title, description, desired_state, baseline_state,
        target_metric, target_value, target_unit, deadline, owner, autonomy_level, source,
        mission_status, confidence, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(
      id, orgId, title, input.description ?? null, input.desiredState ?? null, input.baselineState ?? null,
      targetMetric, input.targetValue != null ? Number(input.targetValue) : null, input.targetUnit ?? null,
      input.deadline ?? null, input.owner ?? null, autonomy, source, clampConfidence(input.confidence), actor ?? null,
    );
    return this.get(orgId, id)!;
  }

  static get(orgId: string, id: string): Mission | null {
    const r = db.prepare(`SELECT * FROM missions WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    return r ? this.row(r) : null;
  }

  static list(orgId: string, opts: { status?: string } = {}): Mission[] {
    let sql = `SELECT * FROM missions WHERE organization_id = ?`;
    const args: any[] = [orgId];
    if (opts.status) { sql += ` AND mission_status = ?`; args.push(String(opts.status)); }
    sql += ` ORDER BY (mission_status IN ('achieved','failed','cancelled')) ASC, updated_at DESC`;
    return (db.prepare(sql).all(...args) as any[]).map((r) => this.row(r));
  }

  /** Patch parcial dos campos mutáveis do contrato. Não muda status (use setStatus). */
  static update(orgId: string, id: string, patch: Partial<MissionInput>, _actor?: string): Mission {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Missão não encontrada.");
    const sets: string[] = [];
    const args: any[] = [];
    const put = (col: string, val: any) => { sets.push(`${col} = ?`); args.push(val); };

    if (patch.title !== undefined) { const t = String(patch.title || "").trim(); if (!t) throw new Error("Título não pode ficar vazio."); put("title", t); }
    if (patch.description !== undefined) put("description", patch.description ?? null);
    if (patch.desiredState !== undefined) put("desired_state", patch.desiredState ?? null);
    if (patch.baselineState !== undefined) put("baseline_state", patch.baselineState ?? null);
    if (patch.targetMetric !== undefined) {
      const m = patch.targetMetric ? String(patch.targetMetric) : null;
      if (m && !BusinessGoalService.isKnownMetric(m)) throw new Error(`Métrica desconhecida: ${m}.`);
      put("target_metric", m);
    }
    if (patch.targetValue !== undefined) put("target_value", patch.targetValue != null ? Number(patch.targetValue) : null);
    if (patch.targetUnit !== undefined) put("target_unit", patch.targetUnit ?? null);
    if (patch.deadline !== undefined) put("deadline", patch.deadline ?? null);
    if (patch.owner !== undefined) put("owner", patch.owner ?? null);
    if (patch.confidence !== undefined) put("confidence", clampConfidence(patch.confidence));

    if (!sets.length) return cur;
    put("updated_at", new Date().toISOString());
    db.prepare(`UPDATE missions SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`).run(...args, orgId, id);
    return this.get(orgId, id)!;
  }

  static setStatus(orgId: string, id: string, status: string, _actor?: string): Mission {
    if (!MISSION_STATUSES.includes(status as MissionStatus)) throw new Error(`Status inválido: ${status}.`);
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Missão não encontrada.");
    db.prepare(`UPDATE missions SET mission_status = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(status, new Date().toISOString(), orgId, id);
    return this.get(orgId, id)!;
  }

  /** Ajusta a autonomia. autopilot NUNCA é declarável aqui (RN-MOL-4/D6 — shadow-first). */
  static setAutonomy(orgId: string, id: string, level: string, _actor?: string): Mission {
    if (!MISSION_AUTONOMY.includes(level as MissionAutonomy)) throw new Error(`Nível de autonomia inválido: ${level}.`);
    if (level === "autopilot") throw new Error("Autopilot não pode ser declarado manualmente — exige evidência (shadow-first).");
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Missão não encontrada.");
    db.prepare(`UPDATE missions SET autonomy_level = ?, updated_at = ? WHERE organization_id = ? AND id = ?`)
      .run(level, new Date().toISOString(), orgId, id);
    return this.get(orgId, id)!;
  }

  /** Cancela (status = cancelled). NUNCA deleta — preserva histórico (convenção nº 9). */
  static cancel(orgId: string, id: string, actor?: string): Mission {
    return this.setStatus(orgId, id, "cancelled", actor);
  }
}

export default MissionService;
