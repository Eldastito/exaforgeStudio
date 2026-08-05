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
          return { ok: true, instanceName, token: existing.token || existing.apikey, alreadyExists: true };
        }
      }
    } catch { /* segue pro create */ }

    // 2. Cria (payload rico primeiro)
    const richPayload = {
      instanceName, name: instanceName, qrcode: true,
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

    // Se rico falhou 400, tenta payload minimal (Evolution GO)
    if (!createResp.ok && createResp.status === 400) {
      try {
        createResp = (await fetch(`${cfg.baseUrl}/instance/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
          body: JSON.stringify({ name: instanceName }),
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
    const token = data?.data?.token || data?.instance?.token || data?.hash?.apikey;
    const qrBase64 = data?.qrcode?.base64 || data?.data?.Qrcode;
    return { ok: true, instanceName, token, qrBase64 };
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
  ): Promise<ConnectAndQrResult> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return { ok: false, error: "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados" };

    // 1. Configura webhook (dois formatos — Evolution GO e Evolution API legacy)
    try {
      await fetch(`${cfg.baseUrl}/instance/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: activeToken, instance: instanceName },
        body: JSON.stringify({ webhookUrl: cfg.webhookUrl, subscribe: ["messages", "connection"] }),
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

    // 2. Pega QR — tenta Go pattern primeiro
    let qrBase64 = "";
    let state = "";
    try {
      const qrResp = (await fetch(`${cfg.baseUrl}/api/v1/instance/qr`, {
        headers: { apikey: activeToken, instance: instanceName },
      })) as FetchResult;
      if (qrResp.ok) {
        const ct = qrResp.headers?.get?.("content-type") || "application/json";
        if (String(ct).includes("application/json")) {
          const qrData = await qrResp.json();
          qrBase64 = qrData?.base64 || qrData?.data?.Qrcode || qrData?.qrcode?.base64 || "";
        }
      }
    } catch { /* fallback pra legacy */ }

    // 3. Fallback legacy — /instance/connect/<name>
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
    const qr = await this.connectAndGetQr(instanceName, activeToken, config);
    return { ...qr, instanceName, alreadyExists: created.alreadyExists };
  }
}
