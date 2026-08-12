/**
 * ReputationProvider (ADR-162 / PRD 5 §7-§8, F1) — abstração provider-agnóstica
 * de PLATAFORMA DE REPUTAÇÃO (Reclame AQUI, Google Reviews, marketplaces, redes…).
 * A camada de Customer Recovery pede uma CAPACIDADE ("ler novos itens", "publicar
 * resposta"); o provider concreto é resolvido por registry + env — trocar de
 * plataforma amanhã não toca o domínio.
 *
 * F1 entrega SÓ o contrato + o `StubReputationProvider` DETERMINÍSTICO (sem rede),
 * pra tudo rodar offline em CI. O conector real (`ReclameAquiProvider`) é F2, e só
 * liga depois de confirmar as capacidades da conta (§6) — capacidade ausente
 * DEGRADA EXPLICITAMENTE (`manual_required`/`unavailable`), NUNCA simula (§6/§8).
 *
 * REGRA D4 (§8): o provider é APENAS TRANSPORTE. NÃO decide severidade, cliente,
 * política, reembolso, resposta nem impacto — isso pertence aos engines canônicos.
 * Por isso este arquivo NÃO importa db/serviço nenhum e NÃO mapeia item→sinal (o
 * mapeamento pro `ExternalSignalInput` é lógica de domínio da ingestão, F2). Os
 * campos do `ReputationItem` são um superset verbatim que espelha o contrato de
 * ingestão (externalId/content/author/rating/sentiment/url/publishedAt), pra F2
 * mapear sem tradução.
 *
 * §30/§71 (idempotência/replay): `publishReply` recebe `idempotencyKey` e nunca
 * publica a mesma resposta 2×. §70 (polling incremental): `listNewItems` usa
 * cursor/`since` e devolve `nextCursor` — nunca varre o histórico inteiro.
 */

/** Capacidades que um provider PODE oferecer (§6): a conta/plataforma pode não ter todas. */
export type ReputationProviderCapability =
  | "list"          // listar itens novos/atualizados (leitura incremental)
  | "getItem"       // buscar um item por id
  | "publishReply"  // publicar resposta pública
  | "getReplies"    // ler respostas/réplicas de um item
  | "getStatus";    // ler o status de um item

/** Status do item na plataforma de origem (verbatim/normalizado do provedor). */
export type ReputationItemStatus =
  | "new"                 // recém-detectado, sem tratativa
  | "open"                // aberto
  | "answered"            // empresa respondeu
  | "replied_by_consumer" // consumidor deu réplica
  | "resolved"            // resolvido na plataforma
  | "closed"              // encerrado
  | "unknown";

/** Um item de reputação (reclamação/review/menção) capturado da plataforma. */
export interface ReputationItem {
  /** Slug do sistema de origem (reclame_aqui|google_reviews|…) — par do externalId. */
  source: string;
  /** Id do item NO sistema de origem — chave do dedupe na ingestão (§9/§71). */
  externalId: string;
  /** Título, se a plataforma tiver. */
  title?: string | null;
  /** Texto verbatim do consumidor (dado NÃO confiável — RN-CRR-1; fica sob fence na ingestão). */
  content: string;
  /** Autor externo (consumidor) — será MASCARADO na ingestão (LGPD); não é usuário da org. */
  author?: string | null;
  /** Nota, se houver (ex.: 1..5). */
  rating?: number | null;
  /** Escala da nota (default 5 quando aplicável). */
  ratingScale?: number | null;
  /** Sentimento, se o provedor já calculou. */
  sentiment?: "negative" | "neutral" | "positive" | null;
  /** URL pública do item (proveniência navegável). */
  url?: string | null;
  /** Quando foi publicado na origem (ISO). */
  publishedAt?: string | null;
  /** Última atualização na origem (ISO) — âncora do cursor incremental (§70). */
  updatedAt?: string | null;
  /** Status na plataforma. */
  status?: ReputationItemStatus;
  /** Pistas verbatim pra identity resolution (F3) — nunca preenchidas pelo provider por inferência. */
  orderRef?: string | null;
  protocol?: string | null;
  locationRef?: string | null;
  /** Payload cru do provedor (proveniência); opaco pro domínio. */
  raw?: any;
}

/** Uma resposta/réplica num item (da empresa ou do consumidor). */
export interface ReputationReply {
  /** Id da resposta no sistema de origem. */
  externalId: string;
  /** Item ao qual pertence. */
  itemExternalId: string;
  /** Quem escreveu. */
  authorType: "company" | "consumer" | "moderator" | "unknown";
  /** Texto verbatim. */
  content: string;
  /** Quando (ISO). */
  publishedAt?: string | null;
}

/** Consulta de leitura incremental (§70): cursor/since, nunca histórico inteiro. */
export interface ReputationListQuery {
  /** Marca d'água: só itens atualizados DEPOIS disto (ISO). */
  since?: string | null;
  /** Cursor opaco de paginação (do `nextCursor` anterior). */
  cursor?: string | null;
  /** Teto de itens por página. */
  limit?: number;
}

export interface ReputationListResult {
  items: ReputationItem[];
  /** Próxima página; ausente/null = fim (§70). */
  nextCursor?: string | null;
}

/** Pedido de publicação de resposta pública. */
export interface ReputationReplyInput {
  itemExternalId: string;
  content: string;
  /** §30/§71: a MESMA resposta nunca publica 2× (idempotência de conector). */
  idempotencyKey: string;
}

/** Resultado da publicação — degradação explícita quando a capacidade falta (§6/§8). */
export interface ReputationPublishResult {
  status:
    | "published"        // publicada de verdade
    | "manual_required"  // provider não sabe publicar → publicação manual necessária (§6)
    | "duplicate"        // idempotencyKey já publicado — no-op seguro (§30)
    | "unavailable";     // provider/rede indisponível — caso preservado, tenta depois (§68)
  /** Id da resposta publicada, quando `published`. */
  externalReplyId?: string | null;
  /** Detalhe legível (motivo da degradação, etc.). */
  detail?: string;
}

/**
 * Contrato provider-agnóstico. Métodos podem ser sync ou async (o stub é sync;
 * conectores reais são async). O provider DECLARA `capabilities` — o domínio
 * consulta antes de agir e degrada explicitamente quando falta (§6).
 */
export interface ReputationProvider {
  name: string;
  capabilities: ReputationProviderCapability[];
  listNewItems(q: ReputationListQuery): Promise<ReputationListResult> | ReputationListResult;
  getItem(externalId: string): Promise<ReputationItem | null> | ReputationItem | null;
  publishReply(input: ReputationReplyInput): Promise<ReputationPublishResult> | ReputationPublishResult;
  getReplies(itemExternalId: string): Promise<ReputationReply[]> | ReputationReply[];
  getStatus(externalId: string): Promise<ReputationItemStatus> | ReputationItemStatus;
}

// ── Dataset determinístico do stub ─────────────────────────────────────────────
// Fixo (sem Date.now/random): exercita ingestão/dedupe/cursor/réplica/status em CI.
// Golden 1 (§89): pedido atrasado, dados confirmáveis, baixo valor. Golden 6: réplica
// após resposta. Datas ISO estáticas (a ordenação do cursor é por updatedAt).
const STUB_ITEMS: ReputationItem[] = [
  {
    source: "stub_reputation", externalId: "RA-1001",
    title: "Pedido não chegou",
    content: "Comprei há duas semanas e até agora nada chegou. Pedido #48391.",
    author: "Maria S.", rating: 1, ratingScale: 5, sentiment: "negative",
    url: "stub://reputation/RA-1001", publishedAt: "2026-08-05T10:00:00Z",
    updatedAt: "2026-08-05T10:00:00Z", status: "open", orderRef: "48391",
  },
  {
    source: "stub_reputation", externalId: "RA-1002",
    title: "Cobrança duplicada",
    content: "Fui cobrado duas vezes na fatura deste mês. Protocolo 77120.",
    author: "João P.", rating: 2, ratingScale: 5, sentiment: "negative",
    url: "stub://reputation/RA-1002", publishedAt: "2026-08-06T09:30:00Z",
    updatedAt: "2026-08-07T14:00:00Z", status: "answered", protocol: "77120",
  },
  {
    source: "stub_reputation", externalId: "RA-1003",
    title: "Atendimento demorado",
    content: "Demorou pra responder mas resolveram. Obrigado.",
    author: "Ana L.", rating: 4, ratingScale: 5, sentiment: "positive",
    url: "stub://reputation/RA-1003", publishedAt: "2026-08-08T16:00:00Z",
    updatedAt: "2026-08-08T16:00:00Z", status: "resolved",
  },
];

const STUB_REPLIES: Record<string, ReputationReply[]> = {
  // Golden 6 (§89): a empresa respondeu e o consumidor deu réplica (mesmo caso, §31).
  "RA-1002": [
    { externalId: "RA-1002-r1", itemExternalId: "RA-1002", authorType: "company",
      content: "Olá! Já identificamos a cobrança em duplicidade e estamos estornando.", publishedAt: "2026-08-07T13:00:00Z" },
    { externalId: "RA-1002-r2", itemExternalId: "RA-1002", authorType: "consumer",
      content: "Ainda não vi o estorno na fatura.", publishedAt: "2026-08-07T14:00:00Z" },
  ],
};

/**
 * StubReputationProvider — provider DETERMINÍSTICO em memória (sem rede, sem tenant,
 * sem PII real). Serve pra exercitar leitura incremental, réplica, status, idempotência
 * e a DEGRADAÇÃO explícita de publicação (§6) em CI. `opts.canPublish=false` simula uma
 * conta sem capacidade de publicar → `manual_required` (nunca finge que publicou).
 */
export class StubReputationProvider implements ReputationProvider {
  name = "stub";
  private published = new Set<string>(); // idempotencyKey já publicados (§30, in-memory)
  private canPublish: boolean;

  constructor(opts: { canPublish?: boolean } = {}) {
    this.canPublish = opts.canPublish !== false; // default: publica
  }

  get capabilities(): ReputationProviderCapability[] {
    const caps: ReputationProviderCapability[] = ["list", "getItem", "getReplies", "getStatus"];
    if (this.canPublish) caps.push("publishReply");
    return caps;
  }

  listNewItems(q: ReputationListQuery): ReputationListResult {
    const since = q.since || "";
    // Ordena por updatedAt asc (estável) e filtra > since (comparação lexicográfica ISO).
    const ordered = [...STUB_ITEMS]
      .filter((it) => (it.updatedAt || it.publishedAt || "") > since)
      .sort((a, b) => (a.updatedAt || "").localeCompare(b.updatedAt || ""));
    // Cursor = índice na lista ordenada (opaco pro chamador; determinístico).
    const start = q.cursor ? Math.max(0, parseInt(q.cursor, 10) || 0) : 0;
    const limit = q.limit && q.limit > 0 ? q.limit : 50;
    const page = ordered.slice(start, start + limit);
    const end = start + page.length;
    return { items: page, nextCursor: end < ordered.length ? String(end) : null };
  }

  getItem(externalId: string): ReputationItem | null {
    return STUB_ITEMS.find((it) => it.externalId === externalId) || null;
  }

  publishReply(input: ReputationReplyInput): ReputationPublishResult {
    if (!this.canPublish) {
      return { status: "manual_required", detail: "provider sem capacidade de publicar — publicação manual necessária" };
    }
    if (this.published.has(input.idempotencyKey)) {
      return { status: "duplicate", detail: "idempotencyKey já publicado" };
    }
    this.published.add(input.idempotencyKey);
    // Id determinístico derivado do par (item, idempotencyKey) — sem random.
    return { status: "published", externalReplyId: `stub-reply:${input.itemExternalId}:${input.idempotencyKey}` };
  }

  getReplies(itemExternalId: string): ReputationReply[] {
    return STUB_REPLIES[itemExternalId] || [];
  }

  getStatus(externalId: string): ReputationItemStatus {
    return this.getItem(externalId)?.status || "unknown";
  }
}

// Registry de PLATAFORMA (sem org): F1 só tem o stub; ReclameAquiProvider entra em F2.
const REGISTRY: Record<string, ReputationProvider> = {
  stub: new StubReputationProvider(),
};

/** Resolve o provider por nome → env `REPUTATION_PROVIDER` → 'stub' (default seguro). */
export function getReputationProvider(name?: string): ReputationProvider {
  const key = name || process.env.REPUTATION_PROVIDER || "stub";
  return REGISTRY[key] || REGISTRY.stub;
}

export default getReputationProvider;
