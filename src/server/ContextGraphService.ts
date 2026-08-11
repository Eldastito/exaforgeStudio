import db from "./db.js";
import {
  ContextEntity,
  ContextEntityType,
  ContextRelationship,
  ContextSource,
  freshnessOf,
} from "./contextModel.js";

/**
 * ContextGraphService — PRD 3 F2 (§8/§10/§12/§66): o CONTEXT GRAPH do Business
 * Context Engine. Faz TRAVESSIA READ-ONLY das relações que JÁ existem como FKs
 * no schema (tenant/unidade/usuário/cliente/produto/fornecedor/meta) e as devolve
 * como `ContextEntity[]` + `ContextRelationship[]` — os contratos estáveis da F1
 * (`contextModel`). É COMPOSIÇÃO pura sobre o que já está no banco: zero tabela
 * nova, zero coluna nova (a auditoria da Fase 0 mostrou que os FKs de escopo já
 * existem soltos — o que faltava era um contrato que os LESSE como grafo).
 *
 * Por que um grafo (e não só o snapshot por domínio): o Context Resolver (F3) e o
 * SkillOS (PRD 4) precisam navegar "quem se liga a quem" — o gerente DESTA loja,
 * os centros de custo DESTE departamento, o fornecedor DESTE produto — sem que
 * cada consumidor reimplemente os JOINs. Este serviço é a ÚNICA casa desses JOINs.
 *
 * GUARDRAILS (duros, testados):
 *   - RN-CG-1 ISOLAMENTO (§66/convenção nº1): `orgId` é sempre o 1º arg e TODA
 *     query filtra `organization_id`. Uma FK que aponta pra entidade de OUTRO
 *     tenant simplesmente não resolve sob este `orgId` → o nó/aresta é descartado.
 *     Não há travessia cross-tenant possível.
 *   - RN-CG-2 NÃO INVENTAR (§25): uma FK pendurada (aponta pra id inexistente/
 *     deletado) NÃO vira nó — a aresta é descartada. Ausência é ausência; o grafo
 *     nunca fabrica uma entidade pra "fechar" uma referência.
 *   - RN-CG-3 READ + DERIVE, nunca EXECUTE (AC-A02/§90): só SELECT. Determinístico,
 *     sem LLM, sem escrita, sem efeito colateral.
 *   - RN-CG-4 LIMITADO (§6 Progressive Disclosure): profundidade, nº de nós e
 *     leque (fan-out) por consulta são TODOS limitados — o grafo é mínimo e
 *     relevante à âncora, não o retrato inteiro da empresa. `truncated` avisa
 *     quando o orçamento cortou a expansão (sem cortar em silêncio).
 *   - RN-CG-5 DIREÇÃO CANÔNICA: toda relação aponta filho→pai (o lado que carrega
 *     a FK → o referenciado): `department child_of department`, `employee
 *     reports_to user`, `cost_center in_store store`. Descobrir a mesma aresta pelo
 *     lado reverso (expandir a loja e achar seus centros de custo) produz a MESMA
 *     relação (dedup por `from|type|to`), nunca uma duplicada invertida.
 */

// ── Vocabulário estável de tipos de relação (§12). Filho→pai. ──────────────────
export type ContextRelationType =
  | "belongs_to"          // X → organization (o tenant)
  | "child_of"            // department → department (hierarquia)
  | "managed_by"          // department/store → user (gestor)
  | "managed_by_contact"  // store → contact (gerente como contato)
  | "in_department"       // cost_center/inventory_location → department
  | "in_store"            // cost_center/inventory_location → store
  | "owned_by"            // cost_center → user (dono do orçamento)
  | "custodied_by"        // inventory_location → user (responsável)
  | "is_user"             // employee → user (vínculo de acesso)
  | "reports_to"          // employee → user (gestor)
  | "has_role"            // employee → employee_role
  | "supplied_by";        // product → supplier (contato fornecedor via pedido)

// Referência de nó no grafo: `type:id` (mesma convenção de `subject` da F1).
export type NodeRef = string;

export interface ContextGraph {
  orgId: string;
  anchor: NodeRef;
  found: boolean;               // a âncora resolveu? (false → grafo vazio, não erro)
  entities: ContextEntity[];    // âncora primeiro, depois ordem de descoberta (BFS)
  relationships: ContextRelationship[];
  truncated: boolean;           // o orçamento (maxNodes/fan) cortou expansão
  stats: { nodes: number; edges: number; maxDepth: number };
}

export interface GraphOptions {
  maxDepth?: number;  // saltos a partir da âncora (default 2)
  maxNodes?: number;  // teto total de nós resolvidos (default 60)
  fanLimit?: number;  // teto de vizinhos por expansão reversa (default 25)
}

// Aresta interna (refs crus) antes de virar ContextRelationship.
interface RawEdge { from: NodeRef; type: ContextRelationType; to: NodeRef; }

// Confiança de um REGISTRO de banco: a existência da linha é um fato OBSERVADO do
// sistema de registro interno. Banda very_high, sem falsa perfeição (§27 — não 1.0).
const RECORD_CONFIDENCE = 0.95;

const GRAPH_SOURCE: ContextSource = { type: "INTERNAL_DB", service: "ContextGraphService" };

// ── Registro de entidades: tipo → tabela + colunas. Nomes de tabela/coluna são
//    CONSTANTES internas (nunca entrada do usuário) → sem risco de injeção. ──────
interface EntityMeta {
  table: string;
  type: ContextEntityType;
  nameCol: string;
  attrCols: string[];
  updatedCol: string | null;
  createdCol: string | null;
}

// contacts lastreia 3 papéis (cliente/fornecedor/contato) — o TIPO do nó reflete
// o papel em que a entidade foi referenciada (a aresta carrega a semântica).
const CONTACT_META = (type: ContextEntityType): EntityMeta => ({
  table: "contacts", type, nameCol: "name", attrCols: ["channel_id"], updatedCol: "updated_at", createdCol: "created_at",
});

function metaFor(type: string): EntityMeta | null {
  switch (type) {
    case "organization": return { table: "organization_settings", type, nameCol: "business_name", attrCols: ["status", "plan_id"], updatedCol: "updated_at", createdCol: "created_at" };
    case "department": return { table: "business_departments", type, nameCol: "name", attrCols: ["code", "active"], updatedCol: "updated_at", createdCol: "created_at" };
    case "cost_center": return { table: "cost_centers", type, nameCol: "name", attrCols: ["code", "active"], updatedCol: "updated_at", createdCol: "created_at" };
    case "store": return { table: "retail_stores", type, nameCol: "name", attrCols: ["code", "city", "active"], updatedCol: "updated_at", createdCol: "created_at" };
    case "inventory_location": return { table: "inventory_locations", type, nameCol: "name", attrCols: ["type", "active"], updatedCol: "updated_at", createdCol: "created_at" };
    case "employee": return { table: "employees", type, nameCol: "name", attrCols: ["status", "unit"], updatedCol: "updated_at", createdCol: "created_at" };
    case "user": return { table: "users", type, nameCol: "name", attrCols: ["role", "global_status"], updatedCol: "updated_at", createdCol: "created_at" };
    case "role": return { table: "employee_roles", type, nameCol: "name", attrCols: ["active"], updatedCol: null, createdCol: "created_at" };
    case "product": return { table: "products_services", type, nameCol: "name", attrCols: ["type", "active"], updatedCol: null, createdCol: "created_at" };
    case "goal": return { table: "business_goals", type, nameCol: "metric", attrCols: ["metric", "target_amount"], updatedCol: "updated_at", createdCol: "created_at" };
    case "customer": return CONTACT_META("customer");
    case "supplier": return CONTACT_META("supplier");
    case "contact": return CONTACT_META("contact");
    default: return null;
  }
}

const ref = (type: string, id: string | number): NodeRef => `${type}:${id}`;

function parseRef(r: NodeRef): { type: string; id: string } {
  const i = r.indexOf(":");
  if (i < 0) return { type: r, id: "" };
  return { type: r.slice(0, i), id: r.slice(i + 1) };
}

export class ContextGraphService {
  /**
   * Resolve UM nó (`type:id`) numa `ContextEntity` (F1) — ou null se não existir
   * NESTE tenant (RN-CG-1) ou o tipo for desconhecido. `organization` só resolve
   * pra si mesma (id == orgId): um tenant não enxerga outro pela raiz.
   */
  static resolveEntity(orgId: string, r: NodeRef): ContextEntity | null {
    const { type, id } = parseRef(r);
    const meta = metaFor(type);
    if (!meta || !id) return null;
    // A raiz do tenant é `organization_settings` (keyed por organization_id); só
    // resolve a PRÓPRIA org (isolamento — id estranho vira null, nunca vaza).
    if (type === "organization" && id !== orgId) return null;

    const cols = new Set<string>([meta.nameCol, ...meta.attrCols]);
    if (meta.updatedCol) cols.add(meta.updatedCol);
    if (meta.createdCol) cols.add(meta.createdCol);
    const colList = [...cols].map((c) => `"${c}"`).join(", ");

    let row: any;
    try {
      if (type === "organization") {
        row = db.prepare(`SELECT ${colList} FROM ${meta.table} WHERE organization_id = ?`).get(orgId);
      } else {
        row = db.prepare(`SELECT ${colList} FROM ${meta.table} WHERE id = ? AND organization_id = ?`).get(id, orgId);
      }
    } catch {
      return null; // schema divergente/coluna ausente: best-effort, não derruba o grafo
    }
    if (!row) return null;

    const attributes: Record<string, unknown> = {};
    for (const c of meta.attrCols) attributes[c] = row[c] ?? null;

    const updatedAt = meta.updatedCol ? (row[meta.updatedCol] ?? null) : null;
    const createdAt = meta.createdCol ? (row[meta.createdCol] ?? null) : null;
    const observedAt = updatedAt || createdAt || null;

    return {
      id,
      tenantId: orgId,
      type: meta.type,
      name: row[meta.nameCol] ?? null,
      attributes,
      source: { ...GRAPH_SOURCE, reference: id },
      confidence: RECORD_CONFIDENCE,
      freshness: freshnessOf({ observedAt }),
      createdAt,
      updatedAt,
    };
  }

  /**
   * Vizinhança de 1 salto a partir de `anchor` (atalho de `build` com maxDepth=1).
   */
  static neighbors(orgId: string, anchor: NodeRef, opts: GraphOptions = {}): ContextGraph {
    return this.build(orgId, anchor, { ...opts, maxDepth: 1 });
  }

  /**
   * Constrói o subgrafo de contexto a partir de `anchor`, em largura (BFS),
   * limitado por profundidade/nós/leque (RN-CG-4). Só nós que RESOLVEM entram
   * (RN-CG-2) e só arestas com AMBOS os extremos resolvidos são reportadas — o
   * grafo nunca referencia um nó fantasma.
   */
  static build(orgId: string, anchor: NodeRef, opts: GraphOptions = {}): ContextGraph {
    const maxDepth = Math.max(0, opts.maxDepth ?? 2);
    const maxNodes = Math.max(1, opts.maxNodes ?? 60);
    const fanLimit = Math.max(1, opts.fanLimit ?? 25);

    const anchorEnt = this.resolveEntity(orgId, anchor);
    if (!anchorEnt) {
      return { orgId, anchor, found: false, entities: [], relationships: [], truncated: false, stats: { nodes: 0, edges: 0, maxDepth } };
    }

    const entities = new Map<NodeRef, ContextEntity>([[anchor, anchorEnt]]);
    const edges = new Map<string, RawEdge>();
    const queue: Array<{ ref: NodeRef; depth: number }> = [{ ref: anchor, depth: 0 }];
    let truncated = false;

    while (queue.length) {
      const { ref: cur, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      const isAnchor = cur === anchor;
      for (const e of this.edgesOf(orgId, cur, isAnchor, fanLimit)) {
        const neighbor = e.from === cur ? e.to : e.from;
        if (!entities.has(neighbor)) {
          if (entities.size >= maxNodes) { truncated = true; continue; }
          const ent = this.resolveEntity(orgId, neighbor);
          if (!ent) continue; // FK pendurada / cross-tenant → descarta nó E aresta (RN-CG-1/2)
          entities.set(neighbor, ent);
          queue.push({ ref: neighbor, depth: depth + 1 });
        }
        // ambos os extremos resolvidos → aresta legítima (dedup por chave canônica)
        if (entities.has(e.from) && entities.has(e.to)) {
          edges.set(`${e.from}|${e.type}|${e.to}`, e);
        }
      }
    }

    // Entidades na ordem de descoberta (âncora primeiro); relações ordenadas p/ determinismo.
    const orderedEntities = [...entities.values()];
    const relationships: ContextRelationship[] = [...edges.keys()].sort().map((k) => {
      const e = edges.get(k)!;
      return { from: e.from, type: e.type, to: e.to, confidence: RECORD_CONFIDENCE, source: GRAPH_SOURCE };
    });

    return {
      orgId,
      anchor,
      found: true,
      entities: orderedEntities,
      relationships,
      truncated,
      stats: { nodes: orderedEntities.length, edges: relationships.length, maxDepth },
    };
  }

  /**
   * Arestas de UM nó: FKs pra frente (o registro referencia outra entidade) +
   * `belongs_to` a org + expansões REVERSAS limitadas (quem aponta pra mim) — pra
   * o grafo ser navegável no sentido útil (loja→seus centros de custo). A raiz da
   * org só enumera sua estrutura quando é a ÂNCORA (senão vira folha — evita que
   * ancorar num cliente puxe a empresa inteira; §6 mínimo-e-relevante).
   */
  private static edgesOf(orgId: string, r: NodeRef, isAnchor: boolean, fanLimit: number): RawEdge[] {
    const { type, id } = parseRef(r);
    const out: RawEdge[] = [];
    const orgRef = ref("organization", orgId);
    const rel = (from: NodeRef, t: ContextRelationType, to: NodeRef) => out.push({ from, type: t, to });
    // Query auxiliar: ids de uma coluna, filtrada por org, ordenada e limitada.
    const ids = (sql: string, ...params: any[]): string[] => {
      try { return (db.prepare(sql).all(...params, fanLimit) as any[]).map((x) => String(x.id)); }
      catch { return []; }
    };
    const one = (sql: string, ...params: any[]): any => {
      try { return db.prepare(sql).get(...params); } catch { return null; }
    };

    // Toda entidade (menos a própria org) pertence ao tenant.
    if (type !== "organization") rel(r, "belongs_to", orgRef);

    switch (type) {
      case "organization": {
        // Só a âncora enumera a ESTRUTURA da org (departamentos/lojas/metas).
        if (!isAnchor) break;
        for (const d of ids(`SELECT id FROM business_departments WHERE organization_id = ? ORDER BY id LIMIT ?`, orgId))
          rel(ref("department", d), "belongs_to", orgRef);
        for (const s of ids(`SELECT id FROM retail_stores WHERE organization_id = ? ORDER BY id LIMIT ?`, orgId))
          rel(ref("store", s), "belongs_to", orgRef);
        for (const g of ids(`SELECT id FROM business_goals WHERE organization_id = ? ORDER BY id LIMIT ?`, orgId))
          rel(ref("goal", g), "belongs_to", orgRef);
        break;
      }
      case "department": {
        const row = one(`SELECT parent_department_id, manager_user_id FROM business_departments WHERE id = ? AND organization_id = ?`, id, orgId);
        if (row?.parent_department_id) rel(r, "child_of", ref("department", row.parent_department_id));
        if (row?.manager_user_id) rel(r, "managed_by", ref("user", row.manager_user_id));
        // reverso (bounded): filhos, centros de custo, locais de estoque neste depto
        for (const c of ids(`SELECT id FROM business_departments WHERE organization_id = ? AND parent_department_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("department", c), "child_of", r);
        for (const c of ids(`SELECT id FROM cost_centers WHERE organization_id = ? AND department_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("cost_center", c), "in_department", r);
        for (const l of ids(`SELECT id FROM inventory_locations WHERE organization_id = ? AND department_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("inventory_location", l), "in_department", r);
        break;
      }
      case "cost_center": {
        const row = one(`SELECT department_id, store_id, budget_owner_user_id FROM cost_centers WHERE id = ? AND organization_id = ?`, id, orgId);
        if (row?.department_id) rel(r, "in_department", ref("department", row.department_id));
        if (row?.store_id) rel(r, "in_store", ref("store", row.store_id));
        if (row?.budget_owner_user_id) rel(r, "owned_by", ref("user", row.budget_owner_user_id));
        break;
      }
      case "store": {
        const row = one(`SELECT manager_user_id, manager_contact_id FROM retail_stores WHERE id = ? AND organization_id = ?`, id, orgId);
        if (row?.manager_user_id) rel(r, "managed_by", ref("user", row.manager_user_id));
        if (row?.manager_contact_id) rel(r, "managed_by_contact", ref("contact", row.manager_contact_id));
        for (const c of ids(`SELECT id FROM cost_centers WHERE organization_id = ? AND store_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("cost_center", c), "in_store", r);
        for (const l of ids(`SELECT id FROM inventory_locations WHERE organization_id = ? AND store_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("inventory_location", l), "in_store", r);
        break;
      }
      case "inventory_location": {
        const row = one(`SELECT store_id, department_id, responsible_user_id FROM inventory_locations WHERE id = ? AND organization_id = ?`, id, orgId);
        if (row?.store_id) rel(r, "in_store", ref("store", row.store_id));
        if (row?.department_id) rel(r, "in_department", ref("department", row.department_id));
        if (row?.responsible_user_id) rel(r, "custodied_by", ref("user", row.responsible_user_id));
        break;
      }
      case "employee": {
        const row = one(`SELECT user_id, manager_user_id, role_id FROM employees WHERE id = ? AND organization_id = ?`, id, orgId);
        if (row?.user_id) rel(r, "is_user", ref("user", row.user_id));
        if (row?.manager_user_id) rel(r, "reports_to", ref("user", row.manager_user_id));
        if (row?.role_id) rel(r, "has_role", ref("role", row.role_id));
        break;
      }
      case "user": {
        // reverso (bounded): quem se liga a este usuário.
        for (const e of ids(`SELECT id FROM employees WHERE organization_id = ? AND user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("employee", e), "is_user", r);
        for (const e of ids(`SELECT id FROM employees WHERE organization_id = ? AND manager_user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("employee", e), "reports_to", r);
        for (const d of ids(`SELECT id FROM business_departments WHERE organization_id = ? AND manager_user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("department", d), "managed_by", r);
        for (const s of ids(`SELECT id FROM retail_stores WHERE organization_id = ? AND manager_user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("store", s), "managed_by", r);
        for (const c of ids(`SELECT id FROM cost_centers WHERE organization_id = ? AND budget_owner_user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("cost_center", c), "owned_by", r);
        for (const l of ids(`SELECT id FROM inventory_locations WHERE organization_id = ? AND responsible_user_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("inventory_location", l), "custodied_by", r);
        break;
      }
      case "role": {
        for (const e of ids(`SELECT id FROM employees WHERE organization_id = ? AND role_id = ? ORDER BY id LIMIT ?`, orgId, id))
          rel(ref("employee", e), "has_role", r);
        break;
      }
      case "product": {
        // fornecedores DESTE produto (via itens de pedido → pedido).
        const rows = (() => {
          try {
            return db.prepare(
              `SELECT DISTINCT po.supplier_contact_id AS id FROM purchase_orders po
                 JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
                WHERE po.organization_id = ? AND poi.product_service_id = ?
                  AND po.supplier_contact_id IS NOT NULL ORDER BY po.supplier_contact_id LIMIT ?`
            ).all(orgId, id, fanLimit) as any[];
          } catch { return []; }
        })();
        for (const x of rows) rel(r, "supplied_by", ref("supplier", String(x.id)));
        break;
      }
      case "supplier": {
        // produtos que ESTE fornecedor forneceu.
        const rows = (() => {
          try {
            return db.prepare(
              `SELECT DISTINCT poi.product_service_id AS id FROM purchase_order_items poi
                 JOIN purchase_orders po ON po.id = poi.purchase_order_id
                WHERE po.organization_id = ? AND po.supplier_contact_id = ? ORDER BY poi.product_service_id LIMIT ?`
            ).all(orgId, id, fanLimit) as any[];
          } catch { return []; }
        })();
        for (const x of rows) rel(ref("product", String(x.id)), "supplied_by", r);
        break;
      }
      // customer/contact/goal: só `belongs_to` a org (sem FK de entidade pra frente).
      default:
        break;
    }
    return out;
  }
}
