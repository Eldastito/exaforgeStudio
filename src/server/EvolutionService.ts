/**
 * ADR-154 Fatia 4.1 — EvolutionService.
 *
 * Extração dos ~180 linhas inline em `server.ts:618-798` (endpoint
 * `/api/evolution/instance/connect`) num serviço reutilizável. Necessário
 * porque a Fase 4 do ADR-154 cria instância Evolution DEDICADA por org Solo
 * (nome derivado do orgId, não o env compartilhado) — sem service isolado
 * teria que duplicar todo o ping-pong com a Evolution API.
 *
 * Não é substituto do endpoint legado (ele segue existindo pra fluxo do
 * dashboard admin manual); é o caminho novo, tipado, sem `req/res` acoplado.
 *
 * Convenção do repo: `static` methods, best-effort (nunca throw pro caller
 * exceto por erro de config — instância dedicada precisa de env válido, sem
 * ela o caminho Solo não faz sentido; falha de rede vira `error` no retorno).
 */
import { randomUUID } from "crypto";

// Compat: fetch nativo Node 18+; o teste stub'a `globalThis.fetch`.
type FetchResult = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; headers?: any };

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  webhookUrl: string;
}

export interface CreateInstanceResult {
  ok: boolean;
  instanceName: string;
  token?: string; // token específico da instância (se Evolution retornou)
  instanceId?: string; // id interno da instância no Evolution GO (F4.1f — usado no forcereconnect)
  qrBase64?: string; // QR já veio no create (Evolution API)
  alreadyExists?: boolean;
  error?: string;
}

export interface ConnectAndQrResult {
  ok: boolean;
  qrBase64?: string;
  state?: string; // 'open' se já conectada
  token?: string;
  error?: string;
}

export class EvolutionService {
  /**
   * Nome determinístico da instância pra uma org Solo. Prefixo `falatu_solo_`
   * torna trivial identificar quais instâncias da Evolution são de Solo
   * (útil pra billing e limpeza operacional). NÃO usar o business_name da
   * org — pode ter espaço/emoji e é editável (nome tem que ser estável).
   */
  static instanceNameForOrg(orgId: string): string {
    if (!orgId || typeof orgId !== "string") throw new Error("orgId inválido pra instanceNameForOrg");
    return `falatu_solo_${orgId}`;
  }

  /**
   * Carrega config a partir de ENV. Retorna null se qualquer campo obrigatório
   * faltar — o caller decide se falha (rota /provision) ou pula (onboarding
   * best-effort). Extraído pra permitir override no teste.
   */
  static getConfig(overrides?: Partial<EvolutionConfig>): EvolutionConfig | null {
    const baseUrl = (overrides?.baseUrl ?? process.env.EVOLUTION_BASE_URL ?? "").replace(/\/$/, "");
    const apiKey = overrides?.apiKey ?? process.env.EVOLUTION_API_KEY ?? "";
    const webhookUrl = overrides?.webhookUrl ?? `${process.env.APP_URL || "http://localhost:3000"}/api/webhooks/evolution`;
    if (!baseUrl || !apiKey) return null;
    return { baseUrl, apiKey, webhookUrl };
  }

  /**
   * Cria instância na Evolution. Tenta o payload rico (Evolution API); se der
   * 400, tenta o payload minimal (Evolution GO strict). Se a instância já
   * existir, retorna `alreadyExists=true` com o token existente (achado via
   * /instance/all) — permite re-provision idempotente. Best-effort: erro de
   * rede vira { ok:false, error } em vez de throw.
   */
  static async createInstance(instanceName: string, config?: EvolutionConfig): Promise<CreateInstanceResult> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return { ok: false, instanceName, error: "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados" };

    // 1. Verifica se instância já existe (dedup)
    try {
      const listResp = (await fetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey } })) as FetchResult;
      if (listResp.ok) {
        const data = await listResp.json();
        const existing = data?.data?.find?.((i: any) => i.name === instanceName || i.instanceName === instanceName);
        if (existing) {
          return { ok: true, instanceName, token: existing.token || existing.apikey, instanceId: existing.id, alreadyExists: true };
        }
      }
    } catch { /* segue pro create */ }

    // 2. Cria (payload rico primeiro)
    // F4.1d: Evolution GO EXIGE `token` no payload (retorna 400 "token is
    // required" sem ele). Geramos UUID por instância — vira o "hash/apikey"
    // que autentica requests futuros pra essa instância específica (padrão
    // que vi na resposta de /instance/all: cada linha tem seu próprio
    // `token` UUID). Passamos junto no payload rico (compat Node oficial,
    // que ignora se não usa) e no minimal (obrigatório no GO).
    const instanceToken = randomUUID();
    const richPayload = {
      instanceName, name: instanceName, token: instanceToken, qrcode: true,
      webhook: cfg.webhookUrl,
      events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"],
    };
    let createResp: FetchResult | null = null;
    try {
      createResp = (await fetch(`${cfg.baseUrl}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
        body: JSON.stringify(richPayload),
      })) as FetchResult;
    } catch (e: any) {
      return { ok: false, instanceName, error: `Rede ao criar: ${e?.message || e}` };
    }

    // Se rico falhou 400, tenta payload minimal (Evolution GO exige `name` + `token`)
    if (!createResp.ok && createResp.status === 400) {
      try {
        createResp = (await fetch(`${cfg.baseUrl}/instance/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
          body: JSON.stringify({ name: instanceName, token: instanceToken }),
        })) as FetchResult;
      } catch (e: any) {
        return { ok: false, instanceName, error: `Rede ao criar (retry): ${e?.message || e}` };
      }
    }

    if (!createResp.ok) {
      let body = ""; try { body = await createResp.text(); } catch { /* noop */ }
      return { ok: false, instanceName, error: `Evolution ${createResp.status}: ${body.slice(0, 200)}` };
    }

    let data: any = {}; try { data = await createResp.json(); } catch { /* noop */ }
    // F4.1d: Evolution GO ecoa nosso `token` na resposta; Node oficial gera
    // o dele em `data.token`/`instance.token`/`hash.apikey`. Usa o retornado
    // se veio (respeita geração server-side); senão volta pro que geramos.
    const token = data?.data?.token || data?.instance?.token || data?.hash?.apikey || instanceToken;
    const instanceId = data?.data?.id || data?.instance?.id || undefined;
    const qrBase64 = data?.qrcode?.base64 || data?.data?.Qrcode;
    return { ok: true, instanceName, token, instanceId, qrBase64 };
  }

  /**
   * Configura webhook + obtém QR. É o passo 2 depois do create (ou o único
   * passo quando a instância já existe). Segue os 3 padrões de resposta que a
   * Evolution usa: /api/v1/instance/qr (Go), /instance/connect/<name> (legacy),
   * ou já-conectada (state=open).
   */
  static async connectAndGetQr(
    instanceName: string,
    activeToken: string,
    config?: EvolutionConfig,
    instanceId?: string,
  ): Promise<ConnectAndQrResult> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return { ok: false, error: "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados" };

    // 1. Configura webhook (dois formatos — Evolution GO e Evolution API legacy)
    // F4.1e (lido do fonte EvolutionAPI/evolution-go):
    // - Auth das rotas de instância (`Auth` middleware) resolve a instância
    //   PELO TOKEN no header `apikey` (GetInstanceByToken). A GLOBAL_API_KEY
    //   só vale nas rotas admin (create/all/delete). `activeToken` aqui é o
    //   token da instância — correto.
    // - `subscribe` é validado case-SENSITIVE contra MESSAGE/CONNECTION/...
    //   (event_types.go). Nosso antigo ["messages","connection"] era descartado
    //   em silêncio → instância ficava sem NENHUM evento → o webhook nunca
    //   receberia a conexão nem mensagens. Maiúsculo é obrigatório.
    try {
      await fetch(`${cfg.baseUrl}/instance/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: activeToken, instance: instanceName },
        body: JSON.stringify({ webhookUrl: cfg.webhookUrl, subscribe: ["MESSAGE", "CONNECTION", "QRCODE"] }),
      });
    } catch { /* best-effort */ }

    try {
      await fetch(`${cfg.baseUrl}/webhook/set/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: activeToken },
        body: JSON.stringify({
          webhook: { url: cfg.webhookUrl, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"] },
        }),
      });
    } catch { /* best-effort */ }

    // 2. Pega QR — 3 variantes de endpoint testadas em ordem, primeira que
    // retornar base64 vence. Ordem escolhida por probabilidade em produção:
    //   a) `/instance/qr`         — Evolution GO (whatsmeow, evoapicloud) ★
    //   b) `/api/v1/instance/qr`  — variante Go antiga (algumas builds mais velhas)
    //   c) `/instance/connect/<name>` — Evolution API oficial (Node/legacy)
    //
    // F4.1e — formato REAL do Evolution GO (instance_service.go GetQr):
    //   { "message": "success", "data": { "qrcode": "data:image/png;base64,...",
    //     "code": "2@..." } }
    // O campo é `data.qrcode` MINÚSCULO e já vem como data URL completo — o
    // parser antigo só tentava `data.Qrcode` e nunca achava ("retornou vazio").
    // Timing: o GetQr do servidor auto-inicia a sessão whatsmeow e espera ~5s;
    // se o QR ainda não saiu, responde 400 "no QR code available. Please wait
    // a moment and try again" — por isso o retry com pausa de 2.5s (3 rodadas).
    let qrBase64 = "";
    let state = "";
    const qrEndpoints = [
      `${cfg.baseUrl}/instance/qr`,
      `${cfg.baseUrl}/api/v1/instance/qr`,
    ];
    const tryFetchQr = async (): Promise<string> => {
      for (const url of qrEndpoints) {
        try {
          const qrResp = (await fetch(url, {
            headers: { apikey: activeToken, instance: instanceName },
          })) as FetchResult;
          if (!qrResp.ok) continue;
          const ct = qrResp.headers?.get?.("content-type") || "application/json";
          if (!String(ct).includes("application/json")) continue;
          const qrData = await qrResp.json();
          const got = qrData?.data?.qrcode || qrData?.base64 || qrData?.data?.Qrcode || qrData?.qrcode?.base64 || qrData?.data?.qr || qrData?.qr || "";
          if (got) return String(got);
        } catch { /* tenta próximo endpoint */ }
      }
      return "";
    };
    for (let attempt = 0; attempt < 3 && !qrBase64; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
      qrBase64 = await tryFetchQr();
    }

    // F4.1f — auto-heal do client zumbi. Visto em produção: o whatsmeow do
    // Evolution GO pode ficar com um client em memória NÃO logado cujo loop
    // de QR já expirou. Nesse estado o GetQr entra no branch "Client exists
    // but not connected" e NUNCA reinicia a sessão — o QR fica vazio pra
    // sempre. O remédio (do fonte) é POST /instance/forcereconnect/:id
    // (auth = GLOBAL key), que dá Disconnect() no client e recria o loop.
    // Só roda quando as 3 tentativas normais falharam E temos o instanceId.
    if (!qrBase64 && instanceId) {
      try {
        await fetch(`${cfg.baseUrl}/instance/forcereconnect/${instanceId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
          body: JSON.stringify({ number: "" }),
        });
      } catch { /* best-effort — as tentativas abaixo decidem */ }
      for (let attempt = 0; attempt < 2 && !qrBase64; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        qrBase64 = await tryFetchQr();
      }
    }

    // 3. Fallback legacy — /instance/connect/<name> (Evolution API Node oficial).
    // Este endpoint devolve o próprio QR na resposta do "connect" — comportamento
    // diferente do Go/whatsmeow, que separa `connect` (subscribe) de `qr` (obter).
    if (!qrBase64) {
      try {
        const legacyResp = (await fetch(`${cfg.baseUrl}/instance/connect/${instanceName}`, {
          headers: { apikey: cfg.apiKey },
        })) as FetchResult;
        if (legacyResp.ok) {
          const ct = legacyResp.headers?.get?.("content-type") || "application/json";
          if (String(ct).includes("application/json")) {
            const cd = await legacyResp.json();
            qrBase64 = cd?.base64 || cd?.qrcode?.base64 || "";
            if (!qrBase64 && (cd?.instance?.state === "open" || cd?.state === "open")) state = "open";
          }
        }
      } catch { /* noop */ }
    }

    if (state === "open") return { ok: true, state: "open", token: activeToken };
    if (qrBase64) {
      const finalQr = qrBase64.startsWith("data:image") ? qrBase64 : `data:image/png;base64,${qrBase64}`;
      return { ok: true, qrBase64: finalQr, token: activeToken };
    }
    return { ok: false, error: "QR não obtido (Evolution retornou vazio)" };
  }

  /**
   * Provision full: create + connect. Atômico do ponto de vista do caller —
   * um único await, ok/error único. Idempotente: instância existente é reusada.
   */
  static async provision(instanceName: string, config?: EvolutionConfig): Promise<ConnectAndQrResult & { instanceName: string; alreadyExists?: boolean }> {
    const created = await this.createInstance(instanceName, config);
    if (!created.ok) return { ok: false, instanceName, error: created.error };
    const activeToken = created.token || (config?.apiKey ?? process.env.EVOLUTION_API_KEY ?? "");
    if (!activeToken) return { ok: false, instanceName, error: "Sem token pra connectAndGetQr" };
    const qr = await this.connectAndGetQr(instanceName, activeToken, config, created.instanceId);
    return { ...qr, instanceName, alreadyExists: created.alreadyExists };
  }
}
