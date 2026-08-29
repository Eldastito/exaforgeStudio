/**
 * AlterdataReadinessService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 4, RF-10).
 *
 * Computa o GATE de go-live da integração Alterdata a partir dos artefatos
 * que os PRs 1-3 já produzem:
 *   - profile do env (credencial/token/rede/filial/tabela → AlterdataProfileService)
 *   - política por módulo (Guardian/Supply/Price/Sales required, CRM condicional,
 *     resto unsupported → AlterdataModulePolicy)
 *   - ledger das últimas runs por env (alterdata_sync_runs + resources)
 *   - cursor por env (isolado desde o PR 2)
 *
 * Bloqueadores (PRD §RF-10):
 *   - credencial ausente
 *   - token inválido/expirado
 *   - ambiente não confirmado (validation_status != 'validated')
 *   - Supply falhando (última run)
 *   - Price falhando
 *   - Sales falhando (só bloqueia em prod)
 *   - rede/filial/tabela ausentes
 *   - cursor misturado (idx v2 impede — checa como afirmação)
 *   - loja sem mapeamento (aparece via store_not_mapped no ledger)
 *   - backup ausente antes da 1ª produção (aviso p/ prod, não bloqueia até PR 8)
 *   - CRM ligado sem autorização LGPD
 *
 * Responsáveis:
 *   - "zapflow"   → bug ou config nossa (ZAPFLOW_CODE)
 *   - "alterdata" → serviço Alterdata falhando (ALTERDATA_AUTH/API)
 *   - "toulon"    → config do cliente (TOULON_CONFIGURATION/LGPD_APPROVAL)
 */
import db from "./db.js";
import { AlterdataProfileService, type AlterdataEnvironment } from "./AlterdataProfileService.js";
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import { resolvePolicyForVertical, ALL_ALTERDATA_MODULES, type AlterdataModule } from "./AlterdataModulePolicy.js";

export type ReadinessStatus = "ready" | "blocked" | "not_configured";
export type ReadinessResponsible = "zapflow" | "alterdata" | "toulon";
export type ReadinessSeverity = "blocker" | "warning" | "info";

export interface ReadinessBlocker {
  code: string;
  severity: ReadinessSeverity;
  responsible: ReadinessResponsible;
  message: string;
  action: string;
  module?: string;
  resource?: string;
  evidence?: string;
  lastRunId?: string;
}

export interface ReadinessResourceState {
  module: string;
  resource: string;
  filial: string;
  required: boolean;
  status: string;
  httpStatus: number | null;
  errorCode: string | null;
  imported: number;
  finishedAt: string | null;
}

export interface ReadinessResponse {
  organizationId: string;
  environment: AlterdataEnvironment;
  status: ReadinessStatus;
  configured: boolean;
  hasCredentials: boolean;
  hasToken: boolean;
  tokenExpiresAt: string | null;
  validationStatus: string;
  lastValidatedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  vertical: string | null;
  modules: Array<{
    module: string;
    policy: "required" | "conditional" | "optional" | "unsupported" | "disabled";
    lastStatus: string | null;
    lastRunAt: string | null;
    ok: boolean;
  }>;
  resources: ReadinessResourceState[];
  blockers: ReadinessBlocker[];
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    correlationId: string;
    requiredFailures: number;
    optionalFailures: number;
  } | null;
  computedAt: string;
}

export class AlterdataReadinessService {
  /**
   * Computa a prontidão da org para o env dado. Fonte da verdade: profile do
   * env (PR 2), última run do ledger (PR 3), política por módulo (PR 1).
   */
  static compute(
    orgId: string,
    environment: AlterdataEnvironment,
    opts: { vertical?: string | null } = {},
  ): ReadinessResponse {
    const profile = AlterdataProfileService.publicProfileFor(orgId, environment);
    const policy = resolvePolicyForVertical(opts.vertical ?? "moda-varejo");
    const blockers: ReadinessBlocker[] = [];

    // 1) Configuração básica
    if (!profile.configured) {
      blockers.push({
        code: "PROFILE_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: `Perfil ${environment} não configurado.`,
        action: `Preencha rede, filial, base URL e credenciais em Integrações → Alterdata → ${environment}.`,
      });
    }
    if (!profile.hasCredentials) {
      blockers.push({
        code: "CREDENTIALS_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: "Credencial Guardian ausente.",
        action: "Informe client_id/client_secret (usuário de retaguarda com acesso total).",
      });
    }
    if (!profile.rede) {
      blockers.push({
        code: "REDE_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: "Rede não informada.",
        action: "Preencha o campo 'Rede' — sem ele nenhum módulo resolve URL.",
      });
    }
    if (!Array.isArray(profile.filiais) || profile.filiais.length === 0) {
      blockers.push({
        code: "FILIAIS_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: "Nenhuma filial cadastrada.",
        action: "Informe pelo menos uma filial (código da loja) — sem isso Saldo/DataCaixa não sincronizam.",
      });
    }
    if (!profile.priceTable) {
      blockers.push({
        code: "PRICE_TABLE_MISSING",
        severity: "blocker",
        responsible: "toulon",
        message: "Tabela de preço não informada.",
        action: "Informe o número da tabela de preço da rede — sem isso o módulo Price não sincroniza.",
      });
    }

    // 2) Token
    if (!profile.hasToken) {
      blockers.push({
        code: "TOKEN_MISSING",
        severity: "blocker",
        responsible: profile.hasCredentials ? "alterdata" : "toulon",
        message: "Token Guardian nunca foi emitido.",
        action: "Clique em 'Emitir token' na tela de Integrações (ou dispare um sync — o Guardian é chamado automaticamente).",
      });
    } else if (profile.tokenExpiresAt && new Date(profile.tokenExpiresAt).getTime() <= Date.now()) {
      blockers.push({
        code: "TOKEN_EXPIRED",
        severity: "blocker",
        responsible: "alterdata",
        message: `Token expirado em ${profile.tokenExpiresAt}.`,
        action: "O próximo sync renova o token automaticamente pelo Guardian. Se persistir, verifique a credencial.",
      });
    }

    // 3) Validação do ambiente
    if (environment === "prod" && profile.validationStatus !== "validated") {
      blockers.push({
        code: "PROD_NOT_VALIDATED",
        severity: "blocker",
        responsible: "toulon",
        message: "Ambiente de produção não validado.",
        action: "Rode 'Preparar produção' e depois 'Promover para produção' na tela de Integrações. Alguém precisa aprovar (LGPD).",
      });
    }

    // 4) LGPD do CRM
    if (AlterdataConnectorService.isPdvCustomerImport(orgId) && environment === "prod" && !profile.approvedBy) {
      blockers.push({
        code: "CRM_LGPD_UNAPPROVED",
        severity: "blocker",
        responsible: "toulon",
        message: "CRM (import de clientes) ligado em produção sem aprovação LGPD registrada.",
        action: "Aprove formalmente o import de dados pessoais antes de subir CRM em prod.",
      });
    }

    // 5) Última run do ledger + status por módulo
    const lastRunRow = db.prepare(
      `SELECT * FROM alterdata_sync_runs WHERE organization_id = ? AND environment = ?
       ORDER BY started_at DESC LIMIT 1`
    ).get(orgId, environment) as any;
    let lastRun: ReadinessResponse["lastRun"] = null;
    let resources: ReadinessResourceState[] = [];
    if (lastRunRow) {
      lastRun = {
        id: lastRunRow.id,
        status: lastRunRow.status,
        startedAt: lastRunRow.started_at,
        finishedAt: lastRunRow.finished_at,
        trigger: lastRunRow.trigger,
        correlationId: lastRunRow.correlation_id,
        requiredFailures: Number(lastRunRow.required_failures || 0),
        optionalFailures: Number(lastRunRow.optional_failures || 0),
      };
      const rrows = db.prepare(
        `SELECT * FROM alterdata_sync_run_resources WHERE run_id = ? ORDER BY started_at ASC`
      ).all(lastRunRow.id) as any[];
      resources = rrows.map(r => ({
        module: String(r.module),
        resource: String(r.resource),
        filial: String(r.filial || ""),
        required: !!r.required,
        status: String(r.status),
        httpStatus: r.http_status == null ? null : Number(r.http_status),
        errorCode: r.error_code || null,
        imported: Number(r.imported || 0),
        finishedAt: r.finished_at || null,
      }));
    }

    // Agrupa último status por módulo
    const modulesOut: ReadinessResponse["modules"] = [];
    for (const mod of ALL_ALTERDATA_MODULES) {
      const mkey = mod as AlterdataModule;
      const p = policy[mkey];
      const rs = resources.filter(r => r.module === mod);
      // Módulo OK se: nenhum required falhou E existe pelo menos um resource ok,
      // OU política é unsupported/disabled/skipped (não deve gerar blocker)
      const requiredFail = rs.some(r => r.required &&
        !["ready", "empty_but_valid", "skipped_by_policy"].includes(r.status));
      const anyOk = rs.some(r => ["ready", "empty_but_valid"].includes(r.status));
      const ok = !requiredFail && (p.policy === "unsupported" || p.policy === "disabled" || p.policy === "optional" || anyOk);
      modulesOut.push({
        module: mod,
        policy: p.policy,
        lastStatus: rs.length ? rs[rs.length - 1].status : null,
        lastRunAt: rs.length ? rs[rs.length - 1].finishedAt : null,
        ok,
      });

      // Blocker por módulo required em falha
      if (p.policy === "required" && requiredFail) {
        const fail = rs.find(r => r.required && !["ready", "empty_but_valid", "skipped_by_policy"].includes(r.status));
        blockers.push({
          code: `MODULE_${mod.toUpperCase()}_FAILING`,
          severity: "blocker",
          responsible: fail?.errorCode === "ZAPFLOW_CODE" ? "zapflow"
            : fail?.errorCode === "TOULON_CONFIGURATION" ? "toulon"
            : "alterdata",
          message: `Módulo ${mod} (required) falhou na última run: ${fail?.status} (${fail?.errorCode ?? "sem código"}).`,
          action: `Verifique o log do resource ${fail?.resource} e execute novamente após corrigir.`,
          module: mod,
          resource: fail?.resource,
          lastRunId: lastRun?.id,
        });
      }
    }

    // 6) Backup em produção — aviso (não bloqueador ainda; PR 8 formaliza)
    if (environment === "prod") {
      blockers.push({
        code: "BACKUP_ADVISORY",
        severity: "info",
        responsible: "toulon",
        message: "Faça um backup do banco antes da 1ª sincronização em produção.",
        action: "Rodar 'Backup completo' na área de Administração antes de promover.",
      });
    }

    // 7) Status geral
    let status: ReadinessStatus;
    if (!profile.configured) status = "not_configured";
    else if (blockers.some(b => b.severity === "blocker")) status = "blocked";
    else status = "ready";

    return {
      organizationId: orgId,
      environment,
      status,
      configured: !!profile.configured,
      hasCredentials: !!profile.hasCredentials,
      hasToken: !!profile.hasToken,
      tokenExpiresAt: profile.tokenExpiresAt ?? null,
      validationStatus: profile.validationStatus ?? "unvalidated",
      lastValidatedAt: profile.lastValidatedAt ?? null,
      approvedBy: profile.approvedBy ?? null,
      approvedAt: profile.approvedAt ?? null,
      vertical: opts.vertical ?? null,
      modules: modulesOut,
      resources,
      blockers,
      lastRun,
      computedAt: new Date().toISOString(),
    };
  }
}
