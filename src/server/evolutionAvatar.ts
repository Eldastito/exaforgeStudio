import db from "./db.js";

// Busca a foto de perfil do WhatsApp (Evolution) de forma BEST-EFFORT e não
// bloqueante. Historicamente o fetch da foto foi desativado porque o endpoint
// de avatar do Evolution GO podia travar (~60s), atrasando o atendimento.
// Aqui resolvemos isso com:
//   - chamada disparada e esquecida (fire-and-forget), nunca no caminho do webhook
//   - timeout rígido via AbortController (não trava nunca)
//   - só busca para contatos que ainda não têm foto
//   - cooldown por contato para não martelar o endpoint a cada mensagem

const inFlight = new Set<string>();
const lastTry = new Map<string, number>();
const RETRY_COOLDOWN_MS = Number(process.env.EVOLUTION_AVATAR_COOLDOWN_MS || 1000 * 60 * 60 * 6); // 6h
const TIMEOUT_MS = Number(process.env.EVOLUTION_AVATAR_TIMEOUT_MS || 6000);

type EvoConfig = { baseUrl: string; apiKey: string; instanceName: string };

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
    const baseUrl = (opts.config.baseUrl || process.env.EVOLUTION_BASE_URL || "").replace(/\/$/, "");
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
        const url = await fetchProfilePicture(senderId, channel.identifier, baseUrl, apiKey);
        if (!url) return;
        db.prepare("UPDATE contacts SET profile_pic_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(url, contact.id);
        if (io) io.to(`org:${channel.organization_id}`).emit("contact_avatar", { contactId: contact.id, avatar: url });
        console.log(`[Evolution Avatar] Foto de perfil atualizada para ${senderId}`);
      } catch (e: any) {
        // Timeout/erro é esperado em alguns ambientes; nunca deve afetar o atendimento.
        console.warn(`[Evolution Avatar] Não foi possível obter a foto de ${senderId}: ${e?.message || e}`);
      } finally {
        inFlight.delete(key);
      }
    })();
  } catch {
    /* defensivo: nunca propaga erro para o webhook */
  }
}

async function fetchProfilePicture(number: string, instance: string, baseUrl: string, apiKey: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Endpoint padrão da Evolution API. Personalizável via EVOLUTION_AVATAR_PATH
    // (use {instance} como placeholder se o endpoint precisar do nome da instância).
    const rawPath = process.env.EVOLUTION_AVATAR_PATH || `/chat/fetchProfilePictureUrl/${instance}`;
    const path = rawPath.replace("{instance}", instance);
    const endpoint = `${baseUrl}${path.startsWith("/") ? path : "/" + path}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        token: apiKey,
        Authorization: `Bearer ${apiKey}`,
        instance,
      },
      body: JSON.stringify({ number }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data: any = await res.json().catch(() => null);
    const url =
      data?.profilePictureUrl ||
      data?.profilePicUrl ||
      data?.profilePic ||
      data?.url ||
      data?.avatar ||
      (typeof data === "string" ? data : null);
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  } finally {
    clearTimeout(timer);
  }
}
