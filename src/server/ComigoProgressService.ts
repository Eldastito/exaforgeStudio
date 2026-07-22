import db from "./db.js";

/**
 * ZappFlow Comigo — Progressão pedagógica (ADR-121 / ADR-088 D10).
 *
 * O app cresce com a pessoa: registrar venda → "quanto sobrou" → "quanto custa"
 * → "quanto cobrar" → metas/saúde. O estágio sai do próprio uso (zero input
 * extra, zero-token). Guia (soft), não bloqueia. Isolado por organization_id.
 */

export const STAGES = [
  { key: "vender", label: "Registrar venda", unlocks: "balcao", hint: "Faça sua primeira venda no Balcão — toque no produto e cobre." },
  { key: "quanto_sobrou", label: "Quanto sobrou", unlocks: "caderneta", hint: "Você já vende! Veja quanto sobrou no seu dia na Caderneta." },
  { key: "quanto_custa", label: "Quanto custa", unlocks: "precificacao", hint: "Monte a ficha de um item pra saber quanto ele custa de verdade." },
  { key: "quanto_cobrar", label: "Quanto cobrar", unlocks: "precificacao", hint: "Coloque os custos na ficha e veja o preço sugerido pra cobrir tudo." },
  { key: "metas", label: "Metas e saúde", unlocks: "saude", hint: "Acompanhe o termômetro: se você está ganhando ou perdendo." },
] as const;

export class ComigoProgressService {
  static status(orgId: string) {
    const sales = (db.prepare("SELECT COUNT(*) c FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done')").get(orgId) as any)?.c || 0;
    const recipesWithCost = (db.prepare(
      "SELECT COUNT(DISTINCT r.id) c FROM comigo_recipes r JOIN comigo_recipe_costs c ON c.recipe_id = r.id WHERE r.organization_id = ?"
    ).get(orgId) as any)?.c || 0;

    // Alcance de cada estágio (progressão consecutiva).
    const reachedFlags: Record<string, boolean> = {
      vender: true,
      quanto_sobrou: sales >= 1,
      quanto_custa: sales >= 3,
      quanto_cobrar: recipesWithCost >= 1,
      metas: recipesWithCost >= 1 && sales >= 10,
    };

    // Estágio atual = o mais avançado alcançado de forma CONSECUTIVA.
    let stageIndex = 0;
    for (let i = 0; i < STAGES.length; i++) {
      if (reachedFlags[STAGES[i].key]) stageIndex = i; else break;
    }
    const reached = STAGES.slice(0, stageIndex + 1).map((s) => s.key);
    const done = stageIndex === STAGES.length - 1;
    const nextDef = done ? null : STAGES[stageIndex + 1];

    // O que já está "revelado" (soft): tudo até o próximo passo, inclusive.
    const unlocked: Record<string, boolean> = { balcao: true, caderneta: false, precificacao: false, saude: false };
    for (let i = 0; i <= Math.min(stageIndex + 1, STAGES.length - 1); i++) {
      unlocked[STAGES[i].unlocks] = true;
    }

    return {
      stage: STAGES[stageIndex].key,
      stageIndex,
      totalStages: STAGES.length,
      reached,
      unlocked,
      signals: { sales, recipesWithCost },
      next: nextDef ? { key: nextDef.key, label: nextDef.label, hint: nextDef.hint } : null,
      done,
      doneMessage: done ? "Você virou gestor do seu negócio 🎓 Continue de olho na saúde." : null,
    };
  }
}

export default ComigoProgressService;
