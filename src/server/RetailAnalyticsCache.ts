/**
 * RetailAnalyticsCache — cache CURTO, em memória, das telas analíticas de varejo
 * (Resultado por loja / da rede / Mais vendidos) — PDR TOULON, Fatia 4C / PERF-005.
 *
 * Depois da otimização set-based (4B) as consultas ficaram baratas; este cache
 * evita recomputar a MESMA leitura repetidas vezes na janela de poucos minutos
 * em que o gestor abre/fecha as abas. TTL curto (5 min) — o dado é sempre
 * "quase agora"; e é INVALIDADO por organização assim que algo que muda o
 * número acontece: sync Alterdata, fechamento, custo, margem ou preço (RN §9).
 *
 * Decisões:
 *   - Chave por (organization_id, key) — isolamento multi-tenant é o prefixo.
 *   - `invalidate(orgId)` derruba TODAS as entradas da org (grosso e seguro:
 *     um custo salvo pode afetar Resultado E Mais vendidos — melhor recomputar).
 *   - Sem dependência de serviço nenhum (quem escreve chama `invalidate`) — não
 *     cria ciclo de import.
 *   - Limite de entradas (bound de memória) com descarte do mais antigo.
 *   - `now` injetável no get/set pra testar TTL sem esperar o relógio.
 *
 * NÃO é cache de dinheiro por usuário — o gating de papel (§73) continua na
 * rota; o cache guarda o MESMO objeto que a rota já devolveria pra owner/admin.
 */

type Entry = { value: any; expiresAt: number };

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min (PERF-005)
const MAX_ENTRIES = 500;              // bound de memória (todas as orgs somadas)

export class RetailAnalyticsCache {
  private static store = new Map<string, Entry>();

  private static k(orgId: string, key: string): string {
    return `${orgId}::${key}`;
  }

  /** Valor vivo ou `undefined` (expira/limpa por TTL). */
  static get(orgId: string, key: string, now: number = Date.now()): any | undefined {
    const full = this.k(orgId, key);
    const e = this.store.get(full);
    if (!e) return undefined;
    if (e.expiresAt <= now) { this.store.delete(full); return undefined; }
    return e.value;
  }

  /** Guarda com TTL curto; descarta o mais antigo se estourar o limite. */
  static set(
    orgId: string,
    key: string,
    value: any,
    opts: { ttlMs?: number; now?: number } = {}
  ): void {
    const now = opts.now ?? Date.now();
    const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
    const full = this.k(orgId, key);
    if (!this.store.has(full) && this.store.size >= MAX_ENTRIES) {
      // Map preserva ordem de inserção → o primeiro é o mais antigo.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(full, { value, expiresAt: now + Math.max(0, ttl) });
  }

  /** Derruba TODAS as entradas de uma organização. Retorna quantas caíram. */
  static invalidate(orgId: string): number {
    const prefix = `${orgId}::`;
    let n = 0;
    for (const full of Array.from(this.store.keys())) {
      if (full.startsWith(prefix)) { this.store.delete(full); n++; }
    }
    return n;
  }

  /** Só para teste — zera tudo. */
  static clearAll(): void { this.store.clear(); }

  /** Só para observabilidade/teste. */
  static size(): number { return this.store.size; }
}

export default RetailAnalyticsCache;
