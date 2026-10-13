/**
 * ManualPostResultService — resultado de publicação MANUAL (ADR-207 F13c, 2ª etapa).
 *
 * TikTok/LinkedIn/YouTube/X rodam em modo ASSISTIDO (`AssistedChannelProvider`): o sistema monta o pacote, a pessoa
 * posta à mão e, sem API, nada volta. Aqui a pessoa DIGITA o que viu — o link do post e, se quiser, as métricas — e isso
 * vira uma linha em `social_post_metrics` (a mesma que o Instagram/Facebook alimentam por API), marcada `source='manual'`.
 * Com `variantKey`, o post passa a contar no experimento criativo daquela variante (F6/F9), sem 2º motor de medição.
 *
 * Guardrails:
 *  - Número DIGITADO ≠ número medido: toda linha carrega `source='manual'` e a resposta diz isso. Não é verificado.
 *  - Métrica em branco = NULL, nunca 0 (RN-SI-12). `analytics_available` só liga se ao menos uma métrica foi informada.
 *  - Só canais assistidos: canal com API real (instagram/facebook) tem o analytics do provider — registrar à mão ali
 *    colidiria com a ingestão; recusa e aponta o caminho certo.
 *  - Link tem que ser https e do domínio do canal (evita colar link trocado); só o link é guardado, nunca é aberto/buscado.
 *  - Reenviar o mesmo link ATUALIZA o mesmo post (idempotente, UNIQUE org+canal+id); campo omitido preserva o valor.
 *  - NÃO cria decision_action, confirmação nem dinheiro: não finge que a publicação passou pela governança. O ciclo
 *    Outcome Assurance/Aprendizado segue exigindo publicação governada com API (limite dito na resposta).
 *  - Isolamento (convenção #1): `orgId` 1º arg; variante validada contra os experimentos DA org.
 */
import { createHash, randomUUID } from "crypto";
import db from "./db.js";
import { isAssistedChannel, type AssistedChannel } from "./AssistedChannelProvider.js";

const HOSTS: Record<AssistedChannel, string[]> = {
  tiktok: ["tiktok.com", "vm.tiktok.com"],
  linkedin: ["linkedin.com", "lnkd.in"],
  youtube: ["youtube.com", "youtu.be"],
  x: ["x.com", "twitter.com"],
};
export const MANUAL_METRICS = ["impressions", "reach", "likes", "comments", "shares", "saves", "clicks"] as const;
type Metric = typeof MANUAL_METRICS[number];
const MAX_METRIC = 10_000_000_000;

export interface ManualResultInput {
  channel: string; link: string; caption?: string | null; kind?: string | null;
  publishedAt?: string | null; variantKey?: string | null;
  metrics?: Partial<Record<Metric, number | string | null>>;
}
export interface ManualResult {
  postId: string; channel: string; link: string; created: boolean; source: "manual";
  variantKey: string | null; metricsInformed: Metric[]; analyticsAvailable: boolean;
  caveats: string[]; note: string;
}

export class ManualResultError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function hostOk(host: string, allowed: string[]): boolean {
  return allowed.some((h) => host === h || host.endsWith("." + h));
}

/** Normaliza o link (host minúsculo, sem fragmento/query — exceto `v` do YouTube) pra mesma publicação dar o mesmo id. */
export function normalizeLink(channel: AssistedChannel, raw: string): string {
  let u: URL;
  try { u = new URL(String(raw || "").trim()); } catch { throw new ManualResultError("bad_link", "Cole o link completo do post (começando com https://)."); }
  if (u.protocol !== "https:") throw new ManualResultError("bad_link", "O link precisa começar com https://.");
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!hostOk(host, HOSTS[channel])) throw new ManualResultError("wrong_host", `Esse link não é do ${channel === "x" ? "X" : channel}. Confira se colou o link certo.`);
  const keep = channel === "youtube" && u.pathname === "/watch" && u.searchParams.get("v") ? `?v=${u.searchParams.get("v")}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" && !keep) throw new ManualResultError("bad_link", "Esse é o endereço do site, não de um post. Cole o link do post.");
  return `https://${host}${path}${keep}`;
}

function metricValue(name: string, v: unknown): number | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_METRIC) {
    throw new ManualResultError("bad_metric", `"${name}" precisa ser um número inteiro, zero ou maior.`);
  }
  return n;
}

export class ManualPostResultService {
  static record(orgId: string, input: ManualResultInput): ManualResult {
    const channel = String(input?.channel || "").toLowerCase();
    if (!channel) throw new ManualResultError("bad_channel", "Informe o canal.");
    if (!isAssistedChannel(channel)) {
      throw new ManualResultError("not_assisted", "Esse canal tem API conectada: o resultado vem sozinho pela sincronização. Registro manual é só para TikTok, LinkedIn, YouTube e X.");
    }
    const link = normalizeLink(channel, input.link);
    const postId = "manual:" + createHash("sha256").update(link).digest("hex").slice(0, 24);

    const vals: Record<Metric, number | null> = {} as any;
    for (const m of MANUAL_METRICS) vals[m] = metricValue(m, input.metrics?.[m]);

    let publishedAt: string | null = null;
    if (input.publishedAt != null && String(input.publishedAt).trim() !== "") {
      const s = String(input.publishedAt).trim();
      const t = Date.parse(s);
      // Só data+hora: data pura viraria meia-noite UTC e distorceria o "melhor horário".
      if (!/T\d{2}:\d{2}/.test(s) || !Number.isFinite(t)) throw new ManualResultError("bad_date", "Informe data e hora da publicação.");
      publishedAt = new Date(t).toISOString();
    }

    let variantKey: string | null = null;
    if (input.variantKey != null && String(input.variantKey).trim() !== "") {
      variantKey = String(input.variantKey).trim();
      const ok = db.prepare(`SELECT 1 FROM creative_experiment_variants WHERE organization_id = ? AND variant_key = ? LIMIT 1`).get(orgId, variantKey);
      if (!ok) throw new ManualResultError("bad_variant", "Essa variante não existe nos seus experimentos.");
    }
    const caption = input.caption == null ? null : String(input.caption).trim().slice(0, 2000) || null;
    const kind = input.kind == null ? null : String(input.kind).trim().slice(0, 30) || null;

    const existing = db.prepare(`SELECT id FROM social_post_metrics WHERE organization_id = ? AND channel = ? AND post_external_id = ?`).get(orgId, channel, postId) as any;
    if (existing) {
      // Campo omitido PRESERVA o que já estava (COALESCE) — completar métricas depois não apaga as de antes.
      db.prepare(
        `UPDATE social_post_metrics SET
           kind = COALESCE(?, kind), caption = COALESCE(?, caption), permalink = ?, published_at = COALESCE(?, published_at),
           variant_key = COALESCE(?, variant_key),
           impressions = COALESCE(?, impressions), reach = COALESCE(?, reach), likes = COALESCE(?, likes), comments = COALESCE(?, comments),
           shares = COALESCE(?, shares), saves = COALESCE(?, saves), clicks = COALESCE(?, clicks),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND organization_id = ?`,
      ).run(kind, caption, link, publishedAt, variantKey, vals.impressions, vals.reach, vals.likes, vals.comments, vals.shares, vals.saves, vals.clicks, existing.id, orgId);
    } else {
      db.prepare(
        `INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, kind, caption, permalink, published_at,
           impressions, reach, likes, comments, shares, saves, clicks, analytics_available, fetched_at, variant_key, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'manual')`,
      ).run(randomUUID(), orgId, channel, postId, kind, caption, link, publishedAt,
        vals.impressions, vals.reach, vals.likes, vals.comments, vals.shares, vals.saves, vals.clicks, variantKey);
    }
    // Liga só se HÁ ao menos uma métrica gravada (a de antes conta) — sem número nenhum, o post fica sem análise.
    const row = db.prepare(
      `SELECT impressions, reach, likes, comments, shares, saves, clicks, variant_key FROM social_post_metrics WHERE organization_id = ? AND channel = ? AND post_external_id = ?`,
    ).get(orgId, channel, postId) as any;
    const has = MANUAL_METRICS.some((m) => row[m] != null);
    db.prepare(`UPDATE social_post_metrics SET analytics_available = ?, fetched_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE fetched_at END WHERE organization_id = ? AND channel = ? AND post_external_id = ?`)
      .run(has ? 1 : 0, has ? 1 : 0, orgId, channel, postId);

    const caveats: string[] = [];
    if (!has) caveats.push("Nenhuma métrica informada: o post foi guardado, mas ainda não tem análise. Volte e complete quando tiver os números.");
    const eng = (row.likes || 0) + (row.comments || 0) + (row.shares || 0) + (row.saves || 0);
    if (row.impressions != null && eng > row.impressions) caveats.push("As interações somam mais que as visualizações — confira os números digitados.");
    if (has && row.impressions == null && row.variant_key) caveats.push("Sem visualizações o post não entra na comparação de variantes (a taxa precisa delas).");
    return {
      postId, channel, link, created: !existing, source: "manual", variantKey: row.variant_key ?? null,
      metricsInformed: MANUAL_METRICS.filter((m) => row[m] != null) as Metric[], analyticsAvailable: has, caveats,
      note: "Números digitados por você, não medidos pelo sistema. Valem para acompanhar e comparar variantes; não entram na garantia de resultado nem no aprendizado automático (isso exige publicar pelo canal conectado).",
    };
  }

  /** Posts registrados à mão (mais recentes primeiro) — só `source='manual'`, da org. */
  static list(orgId: string, opts: { channel?: string; limit?: number } = {}): any[] {
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
    const params: any[] = [orgId];
    let sql = `SELECT channel, post_external_id AS postId, permalink AS link, caption, kind, published_at AS publishedAt, variant_key AS variantKey,
                 impressions, reach, likes, comments, shares, saves, clicks, analytics_available AS analyticsAvailable, 'manual' AS source
               FROM social_post_metrics WHERE organization_id = ? AND source = 'manual'`;
    if (opts.channel) { sql += ` AND channel = ?`; params.push(String(opts.channel).toLowerCase()); }
    sql += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`; params.push(limit);
    return db.prepare(sql).all(...params) as any[];
  }
}

export default ManualPostResultService;
