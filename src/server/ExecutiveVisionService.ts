import db from "./db.js";

/**
 * ExecutiveVisionService — ADR-190 F3 (CEO Operating Layer): a VISÃO estratégica do negócio.
 *
 * A visão é INTENÇÃO HUMANA (§12): o dono declara ONDE quer chegar + o horizonte + a prioridade
 * estratégica. A IA pode ajudar a estruturar depois (fatias seguintes), mas NUNCA a inventa — este
 * serviço só grava o que o dono escreveu. Persistência mínima em 3+2 colunas de `organization_settings`
 * (D6 — sem tabela nova); snapshots derivados NUNCA moram aqui. Vazia por padrão (0-regressão).
 *
 * Guardrails RN-CEO: composição (sem motor) · isolamento por org · nunca inventa (só grava o patch
 * passado; sem dado → campos null) · dinheiro/estratégia atrás do RBAC na rota (owner/admin).
 */

export interface BusinessVision {
  statement: string | null;      // "Ser a principal clínica veterinária premium da região"
  horizon: string | null;        // "36 meses"
  strategicPriority: string | null; // "crescimento sustentável" | commercial|operations|finance
  updatedAt: string | null;
  updatedBy: string | null;
  defined: boolean;              // há ao menos um campo preenchido?
}

export interface BusinessVisionPatch {
  statement?: string | null;
  horizon?: string | null;
  strategicPriority?: string | null;
}

const clip = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export class ExecutiveVisionService {
  /** Lê a visão do negócio. Sem dado → tudo null + defined:false (honesto, não inventa). */
  static get(orgId: string): BusinessVision {
    try {
      const r = db.prepare(`SELECT vision_statement AS s, vision_horizon AS h, strategic_priority AS p, vision_updated_at AS ua, vision_updated_by AS ub FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const statement = r?.s ?? null, horizon = r?.h ?? null, strategicPriority = r?.p ?? null;
      return {
        statement, horizon, strategicPriority,
        updatedAt: r?.ua ?? null, updatedBy: r?.ub ?? null,
        defined: !!(statement || horizon || strategicPriority),
      };
    } catch {
      return { statement: null, horizon: null, strategicPriority: null, updatedAt: null, updatedBy: null, defined: false };
    }
  }

  /**
   * Grava a visão (só os campos PASSADos — patch parcial). Intenção humana: `actor` é obrigatório
   * pra registrar quem definiu. Nunca inventa: campo ausente no patch NÃO é tocado; string vazia limpa.
   */
  static save(orgId: string, patch: BusinessVisionPatch, actor: string): BusinessVision {
    const sets: string[] = [];
    const args: any[] = [];
    if (patch.statement !== undefined) { sets.push("vision_statement = ?"); args.push(clip(patch.statement, 600)); }
    if (patch.horizon !== undefined) { sets.push("vision_horizon = ?"); args.push(clip(patch.horizon, 80)); }
    if (patch.strategicPriority !== undefined) { sets.push("strategic_priority = ?"); args.push(clip(patch.strategicPriority, 120)); }
    if (!sets.length) return this.get(orgId);
    sets.push("vision_updated_at = ?"); args.push(new Date().toISOString());
    sets.push("vision_updated_by = ?"); args.push(actor || null);
    db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...args, orgId);
    return this.get(orgId);
  }
}

export default ExecutiveVisionService;
