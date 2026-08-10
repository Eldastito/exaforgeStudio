/**
 * ContextProjectionService — PRD 1 (Fala Tu), fatia de SEGURANÇA (P1).
 *
 * "Minimum necessary context" (§31) + "RBAC não pode ser burlado via linguagem
 * natural" (§30, CA13): o contexto canônico do ZapFlow (`BusinessSnapshotV2` via
 * `ContextEngineService`) é **org+período, NÃO filtrado por papel**. Sem esta
 * camada, um vendedor perguntando "como vão as vendas?" receberia — e a LLM
 * receberia — TAMBÉM o domínio financeiro. Isto projeta o contexto pro que
 * ESTE usuário pode ver, ANTES de qualquer entrega a modelo.
 *
 * Princípios:
 *  - REUSA `PermissionService` (não duplica RBAC — convenção nº 1 / CA15).
 *  - **Fail-closed:** domínio sem mapeamento de módulo, ou módulo sem leitura,
 *    é DESCARTADO (não vaza por omissão).
 *  - **Redação de campo:** dentro de um domínio incluído, campos sensíveis por
 *    nome (custo/margem/lucro/salário/comissão/documento pessoal) são redigidos
 *    quando o viewer NÃO tem `full` no módulo — acesso parcial vê o agregado,
 *    não o número sensível. Owner = `full` em tudo → vê cru.
 *  - **Determinístico** (zero IA): roda em CI, é auditável e explicável (§49).
 */
import { PermissionService } from "./PermissionService.js";

// Domínio do snapshot → módulo RBAC. Fail-closed: o que não está aqui é descartado.
export const DOMAIN_MODULE: Record<string, string> = {
  finance: "financeiro",
  sales: "vendas",
  inventory: "catalogo",
  procurement: "compras",
  retail_ops: "loja",
  tasks: "execucao",
};

// Campos sensíveis por NOME de chave (redigidos p/ quem não tem `full` no módulo).
// Conservador e explícito — não adivinha por valor, só por rótulo do campo.
const SENSITIVE_FIELD_RE = /(^|_)(custo|custos|margem|margens|lucro|lucros|salario|salarios|remunera\w*|comissao|comissoes|cpf)(_|$)/i;

export interface ContextProjectionManifest {
  droppedDomains: string[];
  redactedPaths: string[];
}

export class ContextProjectionService {
  /**
   * Redige (recursivo) o valor de qualquer chave sensível — subtree inteira,
   * independente do tipo (um objeto `salarios:{...}` some por completo). Registra
   * os paths redigidos pro manifesto (explainability + audit).
   */
  private static redact(node: any, pathPrefix: string, out: string[]): any {
    if (Array.isArray(node)) return node.map((v, i) => this.redact(v, `${pathPrefix}[${i}]`, out));
    if (node && typeof node === "object") {
      const res: any = {};
      for (const [k, v] of Object.entries(node)) {
        const p = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (SENSITIVE_FIELD_RE.test(k)) { res[k] = "[redigido]"; out.push(p); }
        else res[k] = this.redact(v, p, out);
      }
      return res;
    }
    return node;
  }

  /**
   * true se o usuário enxerga TODOS os domínios de negócio mapeados (nenhum
   * módulo `none`). Usado pra decidir se a NARRATIVA (texto org-wide, não
   * role-safe) pode ser entregue: só pra visão ampla; papel restrito recebe
   * apenas o snapshot projetado. Funciona mesmo com o snapshot desligado.
   */
  static hasFullBusinessVisibility(orgId: string, user: any): boolean {
    return Object.values(DOMAIN_MODULE).every((mod) => PermissionService.levelFor(orgId, user, mod) !== "none");
  }

  /**
   * Projeta o snapshot canônico pro escopo do usuário. Retorna a cópia projetada
   * + manifesto (o que caiu e o que foi redigido). Não muta o input.
   */
  static projectSnapshot(orgId: string, user: any, snapshot: any): { snapshot: any; manifest: ContextProjectionManifest } {
    const droppedDomains: string[] = [];
    const redactedPaths: string[] = [];
    if (!snapshot || typeof snapshot !== "object") {
      return { snapshot, manifest: { droppedDomains, redactedPaths } };
    }
    const domains = (snapshot.domains && typeof snapshot.domains === "object") ? snapshot.domains : {};
    const projectedDomains: any = {};
    for (const [domain, data] of Object.entries(domains)) {
      const mod = DOMAIN_MODULE[domain];
      const level = mod ? PermissionService.levelFor(orgId, user, mod) : "none";
      if (level === "none") { droppedDomains.push(domain); continue; } // fail-closed
      projectedDomains[domain] = level === "full" ? data : this.redact(data, `domains.${domain}`, redactedPaths);
    }
    // topPriorities: remove as de domínio descartado (não sugerir o que o usuário
    // nem pode ver). Prioridade sem `domain` é preservada (não é de domínio gated).
    const topPriorities = Array.isArray(snapshot.topPriorities)
      ? snapshot.topPriorities.filter((p: any) => !p?.domain || !droppedDomains.includes(p.domain))
      : snapshot.topPriorities;
    const projected = { ...snapshot, domains: projectedDomains, topPriorities };
    return { snapshot: projected, manifest: { droppedDomains, redactedPaths } };
  }
}
