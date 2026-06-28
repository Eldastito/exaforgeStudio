import db from "./db.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// Mesmo diretório de mídia servido em /media pelo server (volume persistente).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif",
};

/**
 * Cacheia a foto de perfil no PRÓPRIO domínio (/media), em vez de guardar a URL
 * do CDN do WhatsApp (pps.whatsapp.net) — que EXPIRA e bloqueia hotlink, fazendo
 * a imagem não carregar no navegador. Aceita tanto uma data URL (gateway devolveu
 * o binário) quanto uma URL http(s) (baixamos no servidor). Retorna o caminho
 * local "/media/<arquivo>" ou, em último caso, a URL original (best-effort).
 */
async function cacheAvatarImage(src: string): Promise<string> {
  try {
    let buf: Buffer; let mime: string;
    if (src.startsWith("data:")) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
      if (!m) return src;
      mime = m[1]; buf = Buffer.from(m[2], "base64");
    } else if (/^https?:\/\//.test(src)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(src, { signal: controller.signal });
        if (!res.ok) return src;
        mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!mime.startsWith("image/")) return src;
        buf = Buffer.from(await res.arrayBuffer());
      } finally { clearTimeout(timer); }
    } else {
      return src;
    }
    if (!buf.length || buf.length > 2 * 1024 * 1024) return src; // sanidade (≤2MB)
    const ext = EXT_BY_MIME[mime] || "jpg";
    const name = `avatar_${randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
    return `/media/${name}`;
  } catch {
    return src; // se o cache falhar, mantém a URL original (degrade gracioso)
  }
}

// Busca a foto de perfil do WhatsApp (Evolution / gateways compatíveis) de
// forma BEST-EFFORT, não bloqueante e com timeout rígido.
//
// O problema: cada gateway expõe a foto numa rota diferente (Evolution
// "clássico" usa /chat/fetchProfilePictureUrl; forks tipo whatsmeow/WuzAPI usam
// /user/avatar; etc.) e alguns travam se a foto não for pedida em "preview".
// Como não dá para saber a rota de antemão, tentamos uma lista de estratégias
// conhecidas, registramos nos logs o que cada uma retornou e MEMORIZAMOS a que
// funcionar (para as próximas chamadas irem direto na rota certa).

const inFlight = new Set<string>();
const lastTry = new Map<string, number>();
const RETRY_COOLDOWN_MS = Number(process.env.EVOLUTION_AVATAR_COOLDOWN_MS || 1000 * 60 * 60 * 6); // 6h
const TIMEOUT_MS = Number(process.env.EVOLUTION_AVATAR_TIMEOUT_MS || 8000);
const MAX_DATA_URL_BYTES = 250 * 1024; // 250KB — fallback quando o gateway devolve a imagem direto

type EvoConfig = { baseUrl: string; apiKey: string; instanceName: string };

type Strategy = {
  name: string;
  build: (ctx: { base: string; instance: string; number: string }) => { url: string; method: "GET" | "POST"; body?: any };
};

// Estratégias tentadas em ordem. `preview=true` evita o download da imagem
// cheia (que é o que costuma travar ~60s em alguns gateways).
function buildStrategies(): Strategy[] {
  const list: Strategy[] = [];

  // Override manual via env: EVOLUTION_AVATAR_PATH. Use {number} e/ou {instance}
  // como placeholders. Se tiver {number}, é tratado como GET; senão, POST.
  const customPath = process.env.EVOLUTION_AVATAR_PATH;
  if (customPath) {
    list.push({
      name: "custom(env)",
      build: ({ base, instance, number }) => {
        const path = customPath.replace("{instance}", instance).replace("{number}", number);
        const url = `${base}${path.startsWith("/") ? path : "/" + path}`;
        const method = customPath.includes("{number}") ? "GET" : "POST";
        return { url, method, body: method === "POST" ? { number, Phone: number, preview: true, Preview: true } : undefined };
      },
    });
  }

  // Evolution API clássico (v1/v2).
  list.push({
    name: "evolution:/chat/fetchProfilePictureUrl",
    build: ({ base, instance, number }) => ({
      url: `${base}/chat/fetchProfilePictureUrl/${instance}`,
      method: "POST",
      body: { number },
    }),
  });

  // whatsmeow / WuzAPI — POST com PascalCase e preview.
  list.push({
    name: "user/avatar:POST(Phone,Preview)",
    build: ({ base, number }) => ({ url: `${base}/user/avatar`, method: "POST", body: { Phone: number, Preview: true } }),
  });
  // forks com chaves minúsculas.
  list.push({
    name: "user/avatar:POST(number,preview)",
    build: ({ base, number }) => ({ url: `${base}/user/avatar`, method: "POST", body: { number, preview: true } }),
  });
  // variantes GET.
  list.push({
    name: "user/avatar:GET(phone)",
    build: ({ base, number }) => ({ url: `${base}/user/avatar?phone=${encodeURIComponent(number)}&preview=true`, method: "GET" }),
  });
  list.push({
    name: "user/avatar:GET(number)",
    build: ({ base, number }) => ({ url: `${base}/user/avatar?number=${encodeURIComponent(number)}&preview=true`, method: "GET" }),
  });

  return list;
}

let discovered: Strategy | null = null;
let globalProbeBackoffUntil = 0;
const PROBE_BACKOFF_MS = Number(process.env.EVOLUTION_AVATAR_PROBE_BACKOFF_MS || 1000 * 60 * 30); // 30min

/**
 * Dispara (sem await) a busca da foto de perfil do contato e, se obtiver,
 * persiste em contacts.profile_pic_url e emite `contact_avatar` para a sala
 * da organização (atualização ao vivo no card de atendimento).
 */
export function maybeFetchEvolutionAvatar(opts: {
  businessId: string;
  senderId: string;
  config: EvoConfig;
  io: any;
}): void {
  try {
    const { businessId, senderId, io } = opts;
    const baseUrl = (opts.config.baseUrl || process.env.EVOLUTION_BASE_URL || "https://evolutiongo.tesseractauto.com.br").replace(/\/$/, "");
    const apiKey = opts.config.apiKey || process.env.EVOLUTION_API_KEY || "";
    if (!baseUrl || !apiKey || !senderId || !businessId) return;

    const channel = db
      .prepare("SELECT id, organization_id, identifier FROM channels WHERE identifier = ? AND provider = 'evolution'")
      .get(businessId) as any;
    if (!channel) return;

    const contact = db
      .prepare("SELECT id, profile_pic_url FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?")
      .get(channel.organization_id, channel.id, senderId) as any;
    if (!contact || contact.profile_pic_url) return; // sem contato ou já tem foto

    const key = `${channel.id}:${senderId}`;
    if (inFlight.has(key)) return;
    if (Date.now() - (lastTry.get(key) || 0) < RETRY_COOLDOWN_MS) return;

    inFlight.add(key);
    lastTry.set(key, Date.now());

    void (async () => {
      try {
        const resolved = await resolveAvatarUrl(senderId, channel.identifier, baseUrl, apiKey);
        if (!resolved) return;
        // Cacheia no próprio domínio (/media) para o navegador sempre carregar —
        // URLs do CDN do WhatsApp expiram/bloqueiam hotlink.
        const url = await cacheAvatarImage(resolved);
        db.prepare("UPDATE contacts SET profile_pic_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(url, contact.id);
        if (io) io.to(`org:${channel.organization_id}`).emit("contact_avatar", { contactId: contact.id, avatar: url });
        console.log(`[Evolution Avatar] ✓ Foto de perfil atualizada para ${senderId} (${url.startsWith('/media') ? 'cache local' : 'url externa'})`);
      } catch (e: any) {
        console.warn(`[Evolution Avatar] Não foi possível obter a foto de ${senderId}: ${e?.message || e}`);
      } finally {
        inFlight.delete(key);
      }
    })();
  } catch {
    /* defensivo: nunca propaga erro para o webhook */
  }
}

// Tenta a estratégia memorizada; se não houver, faz a varredura (probe) das
// estratégias conhecidas, com backoff global para não martelar a cada mensagem.
async function resolveAvatarUrl(number: string, instance: string, base: string, apiKey: string): Promise<string | null> {
  if (discovered) {
    return tryStrategy(discovered, { base, instance, number }, apiKey); // mantém a memorizada mesmo se falhar pontualmente
  }

  if (Date.now() < globalProbeBackoffUntil) return null;

  const strategies = buildStrategies();
  console.log(`[Evolution Avatar] Descobrindo rota de avatar (${strategies.length} tentativas) em ${base} ...`);
  for (const strat of strategies) {
    const url = await tryStrategy(strat, { base, instance, number }, apiKey);
    if (url) {
      discovered = strat;
      console.log(`[Evolution Avatar] ✓ Rota descoberta: "${strat.name}". Usando-a a partir de agora.`);
      return url;
    }
  }
  globalProbeBackoffUntil = Date.now() + PROBE_BACKOFF_MS;
  console.warn(
    `[Evolution Avatar] Nenhuma rota conhecida retornou foto. Veja os logs acima para o que cada uma respondeu. ` +
      `Defina EVOLUTION_AVATAR_PATH se souber o caminho do seu gateway. Nova tentativa em ${Math.round(PROBE_BACKOFF_MS / 60000)}min.`,
  );
  return null;
}

async function tryStrategy(
  strat: Strategy,
  ctx: { base: string; instance: string; number: string },
  apiKey: string,
): Promise<string | null> {
  const { url, method, body } = strat.build(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        token: apiKey,
        Authorization: `Bearer ${apiKey}`,
        instance: ctx.instance,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const ct = res.headers.get("content-type") || "";

    // Alguns gateways devolvem a imagem direto (binário). Convertemos para data URL.
    if (res.ok && ct.startsWith("image/")) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && buf.length <= MAX_DATA_URL_BYTES) {
        console.log(`[Evolution Avatar] estratégia "${strat.name}": ${method} ${url} -> HTTP ${res.status} (${ct}, ${buf.length}B) [imagem]`);
        return `data:${ct};base64,${buf.toString("base64")}`;
      }
      console.log(`[Evolution Avatar] estratégia "${strat.name}": imagem grande demais (${buf.length}B), ignorada.`);
      return null;
    }

    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    console.log(`[Evolution Avatar] estratégia "${strat.name}": ${method} ${url} -> HTTP ${res.status} (${ct}) ${snippet}`);
    if (!res.ok) return null;

    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return extractUrl(data);
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? `timeout ${TIMEOUT_MS}ms` : e?.message || String(e);
    console.log(`[Evolution Avatar] estratégia "${strat.name}": ${method} ${url} -> ERRO (${reason})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Extrai uma URL http(s) de imagem de respostas em formatos variados.
function extractUrl(data: any): string | null {
  if (!data) return null;
  if (typeof data === "string") return /^https?:\/\//.test(data) ? data : null;

  const containers = [data, data.data, data.result, data.response].filter(Boolean);
  const keys = ["profilePictureUrl", "profilePicUrl", "profilePic", "URL", "url", "avatar", "avatarUrl", "imgUrl", "image"];
  for (const c of containers) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
    if (typeof c !== "object") continue;
    for (const k of keys) {
      const v = c[k];
      if (typeof v === "string" && /^https?:\/\//.test(v)) return v;
    }
  }
  return null;
}
