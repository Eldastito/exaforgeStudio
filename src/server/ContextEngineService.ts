import db from "./db.js";
import { BusinessContextService } from "./BusinessContextService.js";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

/**
 * Context Engine (ADR-160 D3 / Onda A F3) — CONTRATO ÚNICO de contexto do negócio.
 *
 * PROBLEMA que resolve: até aqui o Diretor IA (`ExecutiveAdvisorService`) montava
 * o panorama concatenando DUAS representações do MESMO negócio, cada uma vinda de
 * um serviço diferente:
 *   1. a NARRATIVA (`BusinessContextService.build` → texto: métricas, RIC, funil,
 *      CRM, pedidos, estoque, campanhas, prospecção, agenda);
 *   2. o SNAPSHOT estruturado por domínio (`BusinessSnapshotV2Service` → JSON:
 *      finance/sales/inventory/procurement/retail_ops/tasks + prioridades),
 *      só quando a flag `diretor_snapshot_v2` está ligada.
 * O Advisor conhecia AMBOS os serviços e a ordem/rótulo da colagem. Isso é a
 * "concatenação de duas representações" que a ADR-160 D3 manda unificar.
 *
 * SOLUÇÃO (aditiva, reversível — PRD 0 §54, estender/não duplicar): esta camada
 * fina compõe narrativa + snapshot num contrato só. O snapshot vem pela leitura
 * DEFAULT cacheada da F2 (`BusinessSnapshotV2Service.read` → serve do Evidence
 * Layer quando ligado, senão computa fresco), então a convergência HERDA o cache
 * TTL'd sem custo extra. `render()` devolve EXATAMENTE o texto que o Advisor
 * produzia antes (narrativa + bloco V2), então repontar o Advisor é 0-regressão.
 *
 * GUARDRAILS:
 *   - RN-160-1 — isolamento: toda leitura filtra `organization_id` (nº 1).
 *   - RN-160-2 — derivar por query: zero tabela/coluna nova; só composição.
 *   - RN-160-4 — reversível: `BusinessContextService`/`BusinessSnapshotV2Service`
 *     seguem íntegros e com seus outros consumidores (Zapp orchestrator, rota
 *     `/api/business/snapshot`) inalterados. Esta é uma FACHADA, não um motor.
 */
export class ContextEngineService {
  /**
   * O contrato único: narrativa (texto determinístico) + snapshot (estruturado
   * por domínio, quando a flag do Diretor V2 está ligada) + proveniência.
   * `snapshot` é null quando a flag está desligada — comportamento idêntico ao
   * de hoje (o bloco V2 nem aparecia). `sources` distingue cache vs fresco pra
   * observabilidade (herdado do `_cache` da F2).
   */
  static build(orgId: string): {
    narrative: string;
    snapshot: any | null;
    snapshotEnabled: boolean;
    sources: string[];
    generatedAt: string;
    schemaVersion: number;
  } {
    const narrative = BusinessContextService.build(orgId);

    let snapshot: any = null;
    let snapshotEnabled = false;
    try {
      const s = db.prepare("SELECT diretor_snapshot_v2 FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (s && Number(s.diretor_snapshot_v2)) {
        snapshotEnabled = true;
        snapshot = BusinessSnapshotV2Service.read(orgId); // F2 — leitura cacheada quando o Evidence Layer está ligado
      }
    } catch { /* best-effort: sem snapshot, o Diretor ainda narra pela narrativa */ }

    const sources = ["business_context"];
    if (snapshotEnabled) sources.push(snapshot?._cache?.cacheHit ? "snapshot_v2_cache" : "snapshot_v2");

    return { narrative, snapshot, snapshotEnabled, sources, generatedAt: new Date().toISOString(), schemaVersion: 1 };
  }

  /**
   * Renderiza o contrato único como o TEXTO que o prompt do Diretor consome —
   * byte-a-byte equivalente à antiga colagem `base + snapshotBlockV2` do
   * `ExecutiveAdvisorService` (por isso o rótulo e as instruções do bloco V2
   * são preservados exatamente). É o único ponto que o Advisor precisa chamar
   * para obter narrativa + snapshot unificados.
   */
  /**
   * PRD 1 (segurança, P1) — variante FILTRADA POR PAPEL do contexto. Constrói o
   * canônico e projeta pro que ESTE usuário pode ver (§30/§31, CA13), ANTES de
   * qualquer entrega a modelo. A narrativa (texto org-wide, não role-safe) só vai
   * pra visão ampla; papel restrito recebe só o snapshot projetado + o manifesto
   * do que foi ocultado (explainability, §49). REUSA `ContextProjectionService`
   * (que reusa `PermissionService`) — nenhum RBAC novo. Owner = no-op (vê tudo).
   */
  static buildForUser(orgId: string, user: any): {
    narrative: string | null;
    narrativeOmitted: boolean;
    snapshot: any | null;
    snapshotEnabled: boolean;
    roleScoped: true;
    droppedDomains: string[];
    redactedPaths: string[];
    sources: string[];
    generatedAt: string;
    schemaVersion: number;
  } {
    const base = this.build(orgId);
    let snapshot = base.snapshot;
    let droppedDomains: string[] = [];
    let redactedPaths: string[] = [];
    if (base.snapshot) {
      const r = ContextProjectionService.projectSnapshot(orgId, user, base.snapshot);
      snapshot = r.snapshot;
      droppedDomains = r.manifest.droppedDomains;
      redactedPaths = r.manifest.redactedPaths;
    }
    // Fail-closed também com snapshot desligado: sem visão ampla, a narrativa
    // org-wide não é entregue (evita vazar finanças pelo texto livre).
    const narrativeSafe = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    return {
      narrative: narrativeSafe ? base.narrative : null,
      narrativeOmitted: !narrativeSafe,
      snapshot,
      snapshotEnabled: base.snapshotEnabled,
      roleScoped: true,
      droppedDomains,
      redactedPaths,
      sources: base.sources,
      generatedAt: base.generatedAt,
      schemaVersion: base.schemaVersion,
    };
  }

  static render(orgId: string): string {
    const ctx = this.build(orgId);
    let out = ctx.narrative;
    if (ctx.snapshotEnabled && ctx.snapshot) {
      const snap = ctx.snapshot;
      out += `\n\n=== PANORAMA EMPRESARIAL V2 (determinístico, por domínio) ===
Use EXATAMENTE estes números (finanças, vendas, estoque, compras, operação, tarefas). NUNCA invente valores; se um campo faltar ou vier available:false, diga explicitamente que o dado não está disponível.
DOMÍNIOS: ${JSON.stringify(snap.domains || {})}
PRIORIDADES: ${JSON.stringify(snap.topPriorities || [])}
QUALIDADE DOS DADOS: ${JSON.stringify(snap.dataQuality || {})}`;
    }
    return out;
  }
}
