/**
 * LegacyReductionService — PRD 6 / ADR-163 F12 (§107/§112): redução de legado.
 *
 * A REGRA que define esta fatia (RN-UX-5/§112): NÃO se remove tela sem a
 * telemetria PROVAR substituição. Então F12 aqui é a MÁQUINA DE DECISÃO, não o
 * delete: lê `ux_telemetry_events` (F10), compara a adoção da superfície NOVA com
 * o uso da entrada LEGADA (segundo o mapa de IA da F1) e emite uma RECOMENDAÇÃO
 * de aposentadoria — ADVISÓRIA. Nada é deletado aqui (não existe método de
 * remoção): a retirada real é um passo humano/PR separado, depois do sinal verde.
 *
 * Default conservador: na dúvida, MANTÉM. Sem dados suficientes → `insufficient_data`
 * (keep). Só recomenda `ready_to_retire` quando a nova superfície tem adoção real E
 * a legada virou resíduo (share ≤ 10%). Espelha o padrão da F6 (observa→recomenda→
 * humano decide); inferência/telemetria nunca AGE sozinha (RN-UX-3/RN-UX-5).
 *
 * Role-gated (gestor); isolado por org; derivado por query (RN-004).
 */
import db from "./db.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

// Mapa de substituição (da IA da F1): entrada legada → superfície nova que a cobre.
const REPLACEMENTS: Array<{ legacy: string; replacement: string; label: string }> = [
  { legacy: "insights", replacement: "hoje", label: "Insights → Hoje" },
  { legacy: "saude", replacement: "hoje", label: "Central de Saúde → Hoje" },
  { legacy: "escuta", replacement: "hoje", label: "Escuta Ativa → Hoje" },
  { legacy: "dashboard", replacement: "resultados", label: "Dashboard → Resultados" },
  { legacy: "diretor", replacement: "resultados", label: "Diretor IA → Resultados" },
  { legacy: "tarefas", replacement: "executando", label: "Tarefas → Executando" },
  // ADR-189 F9 (§25) — "Executando" pode sair do 1º nível QUANDO a telemetria provar que "Missões"
  // o substitui (adoção real da nova × resíduo da legada). Advisório; nunca remove sozinho (§112).
  { legacy: "executando", replacement: "missoes", label: "Executando → Missões" },
];

// Limiares de substituição (determinísticos; conservadores por §112).
const MIN_NEW_VIEWS = 10;   // adoção mínima da nova superfície pra sequer avaliar
const MIN_NEW_USERS = 2;    // por >1 pessoa (1 usuário não prova adoção)
const MAX_LEGACY_SHARE = 0.1; // legado só é "resíduo" com ≤10% das aberturas do par

export type RetirementStatus = "ready_to_retire" | "keep" | "insufficient_data";
export interface RetirementCandidate {
  legacy: string; replacement: string; label: string;
  status: RetirementStatus;
  evidence: { newViews: number; newUsers: number; legacyViews: number; legacyShare: number; windowDays: number };
  rationale: string;
  advisory: true;   // SEMPRE — este service jamais remove; só recomenda.
}

export class LegacyReductionService {
  /**
   * Recomendações de aposentadoria de legado, guiadas pela telemetria. ADVISÓRIO:
   * nada é removido. `restricted` pra não-gestor. Sem dados → tudo `keep`.
   */
  static candidates(orgId: string, user: any, opts: { sinceDays?: number } = {}): {
    windowDays: number; candidates: RetirementCandidate[]; note: string; generatedAt: string;
  } | { restricted: true } {
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) return { restricted: true };
    return this.compute(orgId, opts);
  }

  /**
   * Só os candidatos `ready_to_retire` — variante de SISTEMA (sem role-gate), pro
   * Scheduler surfacer proativamente (F16). Continua ADVISÓRIO: só reporta, não remove.
   */
  static readyForOrg(orgId: string, opts: { sinceDays?: number } = {}): RetirementCandidate[] {
    return this.compute(orgId, opts).candidates.filter((c) => c.status === "ready_to_retire");
  }

  /** Cálculo puro (compartilhado por `candidates` e `readyForOrg`). */
  private static compute(orgId: string, opts: { sinceDays?: number } = {}): {
    windowDays: number; candidates: RetirementCandidate[]; note: string; generatedAt: string;
  } {
    const days = Math.max(1, Math.min(365, Number(opts.sinceDays) || 30));

    // Agrega views + usuários distintos por superfície na janela.
    const rows = db.prepare(
      `SELECT surface, COUNT(*) views, COUNT(DISTINCT user_id) users
         FROM ux_telemetry_events
        WHERE organization_id = ? AND event_type = 'view_opened'
          AND surface IS NOT NULL AND datetime(created_at) >= datetime('now', ?)
        GROUP BY surface`
    ).all(orgId, `-${days} day`) as any[];
    const agg = new Map<string, { views: number; users: number }>();
    for (const r of rows) agg.set(r.surface, { views: Number(r.views) || 0, users: Number(r.users) || 0 });

    const candidates: RetirementCandidate[] = [];
    for (const pair of REPLACEMENTS) {
      const neu = agg.get(pair.replacement) || { views: 0, users: 0 };
      const legacy = agg.get(pair.legacy) || { views: 0, users: 0 };
      const total = neu.views + legacy.views;
      const legacyShare = total > 0 ? Math.round((legacy.views / total) * 100) / 100 : 0;

      let status: RetirementStatus;
      let rationale: string;
      if (neu.views < MIN_NEW_VIEWS || neu.users < MIN_NEW_USERS) {
        status = "insufficient_data";
        rationale = `Adoção da nova superfície ainda insuficiente (${neu.views} aberturas / ${neu.users} usuários). Mantém o legado até haver dados (§112).`;
      } else if (legacyShare <= MAX_LEGACY_SHARE) {
        status = "ready_to_retire";
        rationale = `"${pair.replacement}" adotada (${neu.views} aberturas / ${neu.users} usuários) e o legado virou resíduo (${Math.round(legacyShare * 100)}% das aberturas). Seguro recomendar aposentadoria — decisão humana.`;
      } else {
        status = "keep";
        rationale = `Legado ainda em uso real (${Math.round(legacyShare * 100)}% das aberturas do par). Mantém.`;
      }
      candidates.push({
        legacy: pair.legacy, replacement: pair.replacement, label: pair.label,
        status,
        evidence: { newViews: neu.views, newUsers: neu.users, legacyViews: legacy.views, legacyShare, windowDays: days },
        rationale, advisory: true,
      });
    }

    return {
      windowDays: days,
      candidates,
      note: "Advisório: nenhuma tela é removida por este serviço. A retirada é uma decisão humana registrada em PR separado, só após o sinal verde (RN-UX-5/§112).",
      generatedAt: new Date().toISOString(),
    };
  }
}

export default LegacyReductionService;
