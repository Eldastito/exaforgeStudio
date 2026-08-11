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
import type { ContextPacket } from "./contextModel.js";

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

// PRD 3 F9 (§70) — PROPÓSITO → categoria SEMPRE redigida, mesmo pro dono `full`.
// Redação POR-PROPÓSITO restringe ALÉM do papel: um contexto montado p/ uma
// superfície voltada ao cliente nunca leva custo/margem/PII/fornecedor, ainda que
// quem monte seja o dono. É o "por propósito/skill/execução" do §70.
export const PURPOSE_FORBIDDEN: Record<string, RegExp> = {
  customer_facing: /(^|_)(custo|custos|margem|margens|lucro|lucros|salario|salarios|remunera\w*|comissao|comissoes|cpf|fornecedor|fornecedores|preco_de_custo)(_|$)/i,
};

// Restrições cujo VALOR revela informação sensível (margem/custo/salário/comissão).
// Detecta pelo vocabulário do kind (inglês: margin_floor…) OU do nome (pt) — não é
// o mesmo casamento de campo snake_case; por isso é uma regex própria.
const SENSITIVE_CONSTRAINT_RE = /(margin|margem|cost|custo|salary|salario|commission|comiss|profit|lucro)/i;

export interface ContextProjectionManifest {
  droppedDomains: string[];
  redactedPaths: string[];
}

/** Combina a regra de PAPEL (sensível quando sem `full`) com a de PROPÓSITO (§70). */
function activeRedactionRe(roleRedacts: boolean, purposeRe: RegExp | undefined): RegExp | null {
  const parts: string[] = [];
  if (roleRedacts) parts.push(SENSITIVE_FIELD_RE.source);
  if (purposeRe) parts.push(purposeRe.source);
  if (parts.length === 0) return null; // dono full + sem propósito restritivo → cru
  return new RegExp(parts.join("|"), "i");
}

export class ContextProjectionService {
  /**
   * Redige (recursivo) o valor de qualquer chave sensível — subtree inteira,
   * independente do tipo (um objeto `salarios:{...}` some por completo). Registra
   * os paths redigidos pro manifesto (explainability + audit).
   */
  private static redact(node: any, pathPrefix: string, out: string[]): any {
    return this.redactWith(node, pathPrefix, SENSITIVE_FIELD_RE, out);
  }

  /**
   * Redação recursiva PARAMETRIZADA por qual RegExp marca "sensível" (F9 — permite
   * combinar papel + propósito). Mesma semântica wholesale (a subtree de uma chave
   * sensível some inteira) + registro de path pro manifesto. Não muta o input.
   */
  private static redactWith(node: any, pathPrefix: string, re: RegExp, out: string[]): any {
    if (Array.isArray(node)) return node.map((v, i) => this.redactWith(v, `${pathPrefix}[${i}]`, re, out));
    if (node && typeof node === "object") {
      const res: any = {};
      for (const [k, v] of Object.entries(node)) {
        const p = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (re.test(k)) { res[k] = "[redigido]"; out.push(p); }
        else res[k] = this.redactWith(v, p, re, out);
      }
      return res;
    }
    return node;
  }

  /**
   * PRD 3 F9 (§68/§70) — projeta um `ContextPacket` (F3) pro que ESTE usuário +
   * ESTE propósito podem ver, ANTES de qualquer entrega a modelo. Redige (não muta
   * o input):
   *  - o OBJETO de cada fato (subtree sensível some); fato cujo PREDICATE é sensível
   *    tem o objeto redigido inteiro;
   *  - os ATRIBUTOS de cada entidade;
   *  - o VALOR de restrições cujo kind/name é sensível (ex.: margin_floor).
   * Regra de PAPEL: sem `full` em `financeiro` → redige campos sensíveis. Regra de
   * PROPÓSITO (§70): `opts.purpose` redige categorias sempre (mesmo pro dono). Dono
   * full + sem propósito restritivo → pacote CRU (0 regressão). Retorna o pacote
   * projetado + manifesto (o que foi redigido — explainability/audit).
   */
  static projectPacket(orgId: string, user: any, packet: ContextPacket, opts: { purpose?: string } = {}): { packet: ContextPacket; manifest: ContextProjectionManifest } {
    const redactedPaths: string[] = [];
    const droppedDomains: string[] = [];
    if (!packet || typeof packet !== "object") return { packet, manifest: { droppedDomains, redactedPaths } };

    const roleRedacts = PermissionService.levelFor(orgId, user, "financeiro") !== "full";
    const purposeRe = opts.purpose ? PURPOSE_FORBIDDEN[opts.purpose] : undefined;
    const re = activeRedactionRe(roleRedacts, purposeRe);
    if (!re) return { packet, manifest: { droppedDomains, redactedPaths } }; // cru

    const facts = (packet.facts || []).map((f, i) => {
      const path = `facts[${i}]`;
      if (re.test(String(f.predicate || ""))) { redactedPaths.push(`${path}.object`); return { ...f, object: "[redigido]" }; }
      return { ...f, object: this.redactWith(f.object, `${path}.object`, re, redactedPaths) };
    });
    const entities = (packet.entities || []).map((e, i) => ({
      ...e, attributes: this.redactWith(e.attributes, `entities[${i}].attributes`, re, redactedPaths),
    }));
    const constraints = (packet.constraints || []).map((c, i) => {
      if (SENSITIVE_CONSTRAINT_RE.test(String(c.kind || "")) || SENSITIVE_CONSTRAINT_RE.test(String(c.name || ""))) {
        redactedPaths.push(`constraints[${i}].value`);
        return { ...c, value: c.value != null ? null : c.value, text: c.text != null ? "[redigido]" : c.text };
      }
      return c;
    });
    return { packet: { ...packet, facts, entities, constraints }, manifest: { droppedDomains, redactedPaths } };
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
   * O usuário pode ver itens de um domínio de negócio? Reusado pela Smart Inbox
   * e pelas threads. Domínio sem malha sensível (operacional) → visível.
   */
  static canSeeDomain(orgId: string, user: any, domain: string | null | undefined): boolean {
    if (!domain) return true;
    const mod = DOMAIN_MODULE[domain];
    if (!mod) return true;
    return PermissionService.levelFor(orgId, user, mod) !== "none";
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
