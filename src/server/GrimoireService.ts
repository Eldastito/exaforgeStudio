/**
 * GrimoireService — carrega just-in-time a(s) rubrica(s) de copy roteada(s) por
 * (módulo, estágio) do grimoire (ADR-155 F1.2, padrão 4 grimoire /
 * progressive-disclosure de docs/patterns/agentic-pipeline-lessons.md).
 *
 * REGRA CENTRAL (progressive disclosure): NUNCA retorna o grimoire inteiro — só
 * a(s) rubrica(s) roteada(s) no INDEX pro par (module, stage), montada(s) como
 * bloco <rubrica> pro prompt do redator. É o análogo executável do "MUST read X
 * before Y" do img2threejs: o redator recebe a peça certa no momento certo, e
 * não o dump (economia de token = padrão 6).
 *
 * ISOLAMENTO: `orgId` é o 1º arg (convenção nº 1, tenant-first). A camada
 * por-org (`brand_voice_context`) entra na F1.3 — por ora a assinatura já é
 * tenant-first pra não quebrar contrato depois. Roteamento também isola por
 * MÓDULO: pedir (cobranca, compose) nunca traz a rubrica de outro módulo.
 *
 * FONTE: o conteúdo vem de ./grimoire/compiled.ts (gerado de docs/grimoire/
 * copy/** por scripts/build-grimoire.ts e embarcado no bundle — sem fs em
 * runtime). Rode `npm run grimoire:build` após editar o grimoire; o
 * test:grimoire-service confere que o compilado está em sync.
 */
import { GRIMOIRE_INDEX, GRIMOIRE_RUBRICS, type GrimoireRubric } from "./grimoire/compiled.js";

export type GrimoireStage = "intake" | "compose" | "guardrails" | "review" | "glossary";

export interface GrimoireLoad {
  found: boolean;
  module: string;
  stage: GrimoireStage;
  rubricPaths: string[];
  rubrics: GrimoireRubric[];
  /** Bloco(s) <rubrica> prontos pro prompt — SÓ o roteado (progressive disclosure). */
  prompt: string;
}

const MODULOS = GRIMOIRE_INDEX.modulos as unknown as Record<string, Record<string, readonly string[]>>;

export class GrimoireService {
  /** Estágios conhecidos (do INDEX). */
  static stages(): GrimoireStage[] {
    return [...(GRIMOIRE_INDEX.estagios as readonly string[])] as GrimoireStage[];
  }

  /** Módulos conhecidos (do INDEX). */
  static modules(): string[] {
    return Object.keys(MODULOS);
  }

  /** Rubricas roteadas pra (módulo, estágio) segundo o INDEX. Vazio se não houver. */
  static routes(module: string, stage: GrimoireStage): string[] {
    const byStage = MODULOS[module];
    return byStage && byStage[stage] ? [...byStage[stage]] : [];
  }

  /**
   * Carrega just-in-time SÓ a(s) rubrica(s) roteada(s) pro par (module, stage).
   * Módulo/estágio desconhecido → found=false, prompt vazio (graceful, sem throw).
   */
  static load(orgId: string, module: string, stage: GrimoireStage): GrimoireLoad {
    void orgId; // reservado p/ F1.3 (brand_voice_context por org)
    const rubricPaths = this.routes(module, stage);
    const rubrics = rubricPaths
      .map((p) => GRIMOIRE_RUBRICS[p])
      .filter((r): r is GrimoireRubric => Boolean(r));
    const prompt = rubrics.map((r) => this.render(r)).join("\n\n");
    return { found: rubrics.length > 0, module, stage, rubricPaths, rubrics, prompt };
  }

  /**
   * Carrega várias etapas de uma vez (ex.: [guardrails, intake, compose, review])
   * pra montar o prompt completo de composição — sempre só o roteado por etapa.
   */
  static loadStages(orgId: string, module: string, stages: GrimoireStage[]): GrimoireLoad[] {
    return stages.map((s) => this.load(orgId, module, s));
  }

  /** Concatena o prompt de várias etapas num bloco único pronto pra injetar. */
  static promptFor(orgId: string, module: string, stages: GrimoireStage[]): string {
    return this.loadStages(orgId, module, stages)
      .map((l) => l.prompt)
      .filter(Boolean)
      .join("\n\n");
  }

  private static render(r: GrimoireRubric): string {
    return `<rubrica id="${r.id}" estagio="${r.estagio}">\n${r.corpo}\n</rubrica>`;
  }
}
