/**
 * ADR-160 F9 (Onda A) — porta I/O, fatia final: DEDUP de RAG.
 *
 * Havia DOIS stacks de embeddings no repo, cada um reimplementando a MESMA
 * matemática de busca (cosseno + ranqueamento top-K):
 *   - RAG canônico ORG-WIDE  (`knowledge_documents`/`knowledge_chunks`, geminiRAG)
 *   - Memória Fala Tu POR-USUÁRIO (`falatu_memory_embeddings`)
 *
 * Os dois STORES seguem SEPARADOS de propósito — o escopo é diferente (base de
 * conhecimento compartilhada da org vs memória pessoal de um usuário), e juntá-los
 * VAZARIA a captura pessoal de um operador pra toda a org (quebra de isolamento +
 * dado pessoal). O que NÃO precisa ser duplicado é a MATEMÁTICA: cosseno e top-K
 * agora vivem aqui, num primitivo único, e os dois stacks passam por ele.
 *
 * Ambos os stacks já compartilhavam o pipeline de embedding (`llm.embed`); esta
 * fatia fecha o último pedaço duplicado (a similaridade) sem tocar nos stores.
 */

/**
 * Similaridade de cosseno entre dois vetores densos. Contrato (preserva o
 * comportamento histórico das duas implementações que substitui):
 *   - dimensões divergentes ou vetor vazio → 0 (protege o sort de NaN e evita
 *     pontuar vetor corrompido);
 *   - norma zero em qualquer lado → 0 (evita divisão por zero → NaN).
 * Faz dot product e as duas normas numa passada só — o caminho crítico roda em
 * TODOS os embeddings do escopo a cada query (1536 dims por vetor).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Ranqueia `items` por similaridade de cosseno ao `queryVec` e devolve os top-K
 * (desc por score). `getVec` extrai o vetor de cada item — cada stack guarda o
 * embedding num formato próprio (JSON no knowledge_chunks, BLOB no Fala Tu), então
 * a desserialização fica no caller; o RANQUEAMENTO é um só. Sem threshold de score
 * (as duas buscas que isto substitui também não aplicavam) — quem quiser filtra
 * o resultado. `k` é usado verbatim (o caller decide piso, se houver).
 */
export function topKBySimilarity<T>(queryVec: number[], items: T[], getVec: (t: T) => number[], k: number): Array<{ item: T; score: number }> {
  const scored = items.map((item) => ({ item, score: cosineSimilarity(queryVec, getVec(item)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
