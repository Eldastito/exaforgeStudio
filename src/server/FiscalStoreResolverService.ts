/**
 * FiscalStoreResolverService — resolve a LOJA de um documento fiscal de entrada
 * a partir do CNPJ do destinatário (dest/CNPJ), ADR-200 Fase 2.
 *
 * Premissa confirmada (Toulon): CNPJ DISTINTO por loja. A resolução é
 * determinística: dest/CNPJ que casa com UMA única loja ativa → resolvido;
 * mais de uma → ambíguo (seleção humana); nenhuma → não encontrado. Nunca
 * escolhe loja por nome aproximado ou endereço. Isolado por organização.
 */
import db from "./db.js";

export type StoreResolution =
  | { status: "resolved"; storeId: string }
  | { status: "ambiguous"; candidateStoreIds: string[] }
  | { status: "not_found" }
  | { status: "no_cnpj" };

/** Normaliza um CNPJ para 14 dígitos; null se não tiver 14 dígitos. */
export function normalizeCnpj(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
}

export class FiscalStoreResolverService {
  /**
   * Resolve a loja pelo CNPJ do destinatário. Compara SEMPRE normalizado (o
   * cadastro pode ter CNPJ com máscara). Só considera lojas ativas.
   */
  static resolve(orgId: string, recipientCnpj: string | null | undefined): StoreResolution {
    const target = normalizeCnpj(recipientCnpj);
    if (!target) return { status: "no_cnpj" };

    const rows = db.prepare(
      `SELECT id, cnpj FROM retail_stores WHERE organization_id = ? AND active = 1 AND cnpj IS NOT NULL`
    ).all(orgId) as any[];

    const matches = rows.filter((r) => normalizeCnpj(r.cnpj) === target).map((r) => r.id as string);
    if (matches.length === 1) return { status: "resolved", storeId: matches[0] };
    if (matches.length > 1) return { status: "ambiguous", candidateStoreIds: matches };
    return { status: "not_found" };
  }
}

export default FiscalStoreResolverService;
