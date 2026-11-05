/**
 * P4 (docs/retail/ANALISE-CODIGOS-VENDEDOR-SEM-NOME.md) — fechamento manual por SELEÇÃO da equipe.
 *
 * O ranking da folha era digitado por nome todo dia ("Marcus", "Marcus V.", "MARCUS VINICIUS") e o nome só
 * virava matrícula quando batia com UMA pessoa (resolveMatriculaByName). Grafia diferente = "pessoa" à parte e
 * a venda somava em dobro com o PDV. Agora o gerente ESCOLHE o vendedor numa lista: a equipe da loja no dia
 * (lotação vigente, inclusive cobertura) e, para quem veio cobrir sem lotação, as demais pessoas da rede.
 * Digitar continua possível como "outro", mas fica MARCADO (não vira pessoa, não é escondido).
 *
 * Regras:
 *  - `team(orgId, storeId, date)`: só leitura; lista nome + matrícula (sem dinheiro). Tudo por organization_id.
 *  - `validMatricula`: a matrícula escolhida precisa ser de uma pessoa ATIVA da org (principal ou apelido de
 *    matrícula) — o cliente não inventa vínculo.
 */
import db from "./db.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";

export type TeamPerson = { sellerId: string; matricula: string; name: string; stores: string[] };

export class RetailClosingTeamService {
  static team(orgId: string, storeId: string, date?: string): { storeId: string; date: string | null; team: TeamPerson[]; others: TeamPerson[] } {
    const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : undefined;
    const storeNames = new Map<string, string[]>();
    for (const r of db.prepare(
      `SELECT a.seller_id, s.name FROM retail_seller_store_assignments a
         JOIN retail_stores s ON s.organization_id = a.organization_id AND s.id = a.store_id
        WHERE a.organization_id = ? AND a.active = 1 ORDER BY s.name`
    ).all(orgId) as any[]) { if (!storeNames.has(r.seller_id)) storeNames.set(r.seller_id, []); storeNames.get(r.seller_id)!.push(r.name); }
    const roster = RetailSellerIdentityService.rosterOn(orgId, storeId, d).filter((p) => String(p.name || "").trim());
    const inTeam = new Set(roster.map((p) => p.id));
    const team = roster.map((p) => ({ sellerId: p.id, matricula: String(p.matricula), name: String(p.name), stores: storeNames.get(p.id) || [] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const others = (db.prepare(
      `SELECT id, matricula, name FROM retail_sellers
        WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL AND name IS NOT NULL AND TRIM(name) <> '' ORDER BY name`
    ).all(orgId) as any[]).filter((r) => !inTeam.has(r.id)).map((r) => ({ sellerId: r.id, matricula: String(r.matricula), name: String(r.name), stores: storeNames.get(r.id) || [] }));
    return { storeId, date: d || null, team, others };
  }

  /** A matrícula escolhida é de uma pessoa ATIVA desta org (principal ou apelido)? Devolve a pessoa (nome cadastrado). */
  static validMatricula(orgId: string, matricula: unknown): { matricula: string; name: string } | null {
    const m = String(matricula ?? "").trim();
    if (!m) return null;
    const own = db.prepare(`SELECT matricula, name FROM retail_sellers WHERE organization_id = ? AND matricula = ? AND active = 1 AND merged_into_seller_id IS NULL`).get(orgId, m) as any;
    if (own) return { matricula: String(own.matricula), name: String(own.name || "") };
    const alias = db.prepare(
      `SELECT s.matricula, s.name FROM retail_seller_aliases a JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.kind IN ('matricula','cai_usuario') AND a.alias = ? AND s.active = 1 AND s.merged_into_seller_id IS NULL LIMIT 1`
    ).get(orgId, m) as any;
    return alias ? { matricula: m, name: String(alias.name || "") } : null;
  }
}

export default RetailClosingTeamService;
