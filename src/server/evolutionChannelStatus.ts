/**
 * evolutionChannelStatus — resolução de canal Evolution por IDENTIFIER único
 * (F1.2c, achados A8/A9). Sem inventar organização.
 *
 * Os eventos de conexão do Evolution (connect legado + connection.update) antes
 * gravavam/atualizavam canal sob `organization_id = 'default_org'` — uma org
 * INVENTADA — ou confiavam no header `x-organization-id` (spoofável na rota
 * legada NÃO autenticada). Isso fere o isolamento multi-tenant (RF-02/INV-01).
 *
 * O nome da instância (`identifier`) é globalmente único na Evolution (não
 * repete entre orgs), então a resolução correta é pelo identifier — e o efeito é
 * só ATUALIZAR o status de um canal JÁ cadastrado. Persistir um canal NOVO é do
 * fluxo AUTENTICADO de provisionamento, nunca de um evento de webhook. Módulo
 * puro/DB (sem rede) para ser testável fora do server.ts (self-boot).
 */
import db from "./db.js";

/**
 * Marca o canal Evolution com este `identifier` no status dado (default
 * 'connected'). Retorna true se ACHOU e atualizou; false se não existe canal —
 * NUNCA cria um canal (nem sob default_org). Best-effort: erro de storage → false.
 */
export function markEvolutionChannelStatusByIdentifier(identifier: string, status: string = "connected"): boolean {
  const id = String(identifier || "").trim();
  if (!id) return false;
  try {
    const ch = db.prepare(`SELECT id FROM channels WHERE provider IN ('evolution','evolution_go') AND identifier = ?`).get(id) as any;
    if (!ch) return false;
    db.prepare(`UPDATE channels SET status = ? WHERE id = ?`).run(status, ch.id);
    return true;
  } catch { return false; }
}
