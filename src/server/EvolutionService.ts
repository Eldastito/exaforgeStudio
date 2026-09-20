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

// 16/09/2026 (relato do dono: "QR não aparece") — TIMEOUT duro em TODA chamada
// ao provedor. Sem ele, um Evolution fora do ar/mudo deixava o "Conectar"
// pendurado e a UI girando pra sempre, sem erro nenhum pra diagnosticar.
// Chama o `globalThis.fetch` da hora (os testes stub'am depois do import).
const EVO_TIMEOUT_MS = 12_000;
function evoFetch(url: string, init?: any): Promise<any> {
  const signal = typeof (AbortSignal as any)?.timeout === "function" ? (AbortSignal as any).timeout(EVO_TIMEOUT_MS) : undefined;
  return (globalThis as any).fetch(url, { ...(init || {}), ...(signal ? { signal } : {}) });
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  webhookUrl: string;
}

// 17/09/2026 (instância pareada mas NENHUMA mensagem chegava) — o webhook era
// registrado SEM o `?secret=`, e quando a exigência do segredo está ligada
// (env WEBHOOK_SECRET, toggle de Integrações, WEBHOOK_STRICT ou qualquer org
// com módulo clínica — isWebhookEnforced) TODO evento do provedor era
// rejeitado 401 "segredo_incorreto": o canal nunca virava 'connected' e o
// inbound morria na porta. O segredo vive no app_config (db) e este serviço é
// deliberadamente livre de db — então o server injeta um PROVIDER no boot.
let _webhookSecretProvider: (() => string | null) | null = null;
export function setEvolutionWebhookSecretProvider(fn: (() => string | null) | null): void {
  _webhookSecretProvider = fn;
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
  // F1.3 (RF-02/INV-07/CA-02): quando o QR não veio, sinaliza que um RESET
  // (delete+recreate) PODE ajudar — mas o reset é operação EXPLÍCITA do operador
  // (`resetInstance`), nunca autocorreção silenciosa. QR ausente ≠ autorização
  // pra apagar a sessão.
  needsReset?: boolean;
  // F5 do PRD Conexão WhatsApp (fonte 0.7.2: instance_service.go:99-101 e
  // 457-463): conta direcionada a PASSKEY não tem QR — o GetQr devolve o
  // estágio, o código e a openUrl da cerimônia (TTL ~5 min,
  // ceremony/store.go:29). É SUCESSO PENDENTE (state 'awaiting_passkey'),
  // nunca erro. `misconfigured` = servidor sem PASSKEY_PUBLIC_URL (a openUrl
  // vem como o literal <SET_PASSKEY_PUBLIC_URL> — sem ela não há o que abrir).
  // O código NUNCA vai pra log — só pra resposta autenticada.
  passkey?: { stage: string; code?: string; openUrl?: string; misconfigured?: boolean };
  // 17/09/2026 — resultado do registro do webhook (antes era mudo): false =
  // instância pode parear e ficar SURDA (nenhum evento/mensagem chega).
  webhookRegistered?: boolean;
  webhookAttempts?: Array<{ path: string; status: number | string }>;
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
   * Localiza a instância no provedor e devolve id+token (16/09/2026 — o reset
   * explícito precisa do id, mas o canal não o guarda; busca em /instance/all).
   * null = não encontrada OU provedor inacessível (o caller decide o fallback).
   */
  static async findInstance(instanceName: string, config?: EvolutionConfig): Promise<{ id?: string; token?: string } | null> {
    const cfg = config ?? this.getConfig();
    if (!cfg || !instanceName) return null;
    try {
      const resp = (await evoFetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey } })) as FetchResult;
      if (!resp.ok) return null;
      const data = await resp.json();
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      const hit = list.find((i: any) => i?.name === instanceName || i?.instanceName === instanceName);
      return hit ? { id: hit.id, token: hit.token || hit.apikey } : null;
    } catch { return null; }
  }

  /**
   * 16/09/2026 (4º relato: instância criada, QR segue vazio) — LOGS da instância
   * direto do provedor (`GET /instance/logs/{instanceId}`, AuthAdmin). O fonte do
   * evolution-go mostra que quando o `client.Connect()` com o WhatsApp falha, a
   * goroutine morre em SILÊNCIO e o GetQr responde só "no QR code available" pra
   * sempre — o motivo real (rede do VPS, proxy, EOF, versão) fica SÓ no log da
   * instância. Este método traz esse log pro nosso diagnóstico. Token-safe: a
   * chave global e tokens de instância são redigidos; mensagem truncada. Nunca
   * lança; [] em qualquer falha (rede, sem config, instância não achada).
   */
  static async getInstanceLogs(
    instanceName: string,
    config?: EvolutionConfig,
    opts?: { instanceId?: string; limit?: number },
  ): Promise<Array<{ at: string; level: string; message: string }>> {
    const cfg = config ?? this.getConfig();
    if (!cfg || !instanceName) return [];
    try {
      let instanceId = opts?.instanceId;
      let instanceToken: string | undefined;
      if (!instanceId) {
        const found = await this.findInstance(instanceName, cfg);
        if (!found?.id) return [];
        instanceId = found.id;
        instanceToken = found.token;
      }
      const limit = Math.max(1, Math.min(opts?.limit ?? 15, 50));
      const resp = (await evoFetch(`${cfg.baseUrl}/instance/logs/${encodeURIComponent(instanceId!)}?limit=${limit}`, {
        headers: { apikey: cfg.apiKey },
      })) as FetchResult;
      if (!resp.ok) return [];
      const data = await resp.json();
      const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.logs) ? data.logs : []));
      const redact = (s: string) => {
        let out = String(s || "");
        if (cfg.apiKey) out = out.split(cfg.apiKey).join("[REDACTED]");
        if (instanceToken) out = out.split(instanceToken).join("[REDACTED]");
        return out.slice(0, 300);
      };
      return list.slice(-limit).map((e: any) => ({
        at: String(e?.timestamp || e?.at || ""),
        level: String(e?.level || ""),
        message: redact(e?.message),
      }));
    } catch { return []; }
  }

  /**
   * Verificação NÃO-destrutiva: a instância existe no provedor? (F2.1a — import.)
   * Lista `/instance/all` e procura pelo nome. Retorna false em rede/erro (nunca
   * lança) — o caller trata "não confirmado". NÃO cria nada: importar por digitar
   * um nome que não existe no provedor não deve inventar instância (§8).
   */
  static async instanceExists(instanceName: string, config?: EvolutionConfig): Promise<boolean> {
    const cfg = config ?? this.getConfig();
    if (!cfg || !instanceName) return false;
    try {
      const resp = (await evoFetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey } })) as FetchResult;
      if (!resp.ok) return false;
      const data = await resp.json();
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      return list.some((i: any) => i?.name === instanceName || i?.instanceName === instanceName);
    } catch { return false; }
  }

  /**
   * WZ (pedido do dono, 15/09/2026) — LOGOUT da sessão no provedor, best-effort.
   * Diferente do `resetInstance` (destrutivo: apaga + recria), o logout só
   * encerra a sessão pareada — a instância continua existindo pra reconectar
   * por QR. Forks divergem no endpoint, então tenta os mais comuns (1º 2xx
   * vence). Nunca lança; retorna se ALGUM aceitou (o caller reporta honesto:
   * false = "marcado desconectado aqui; confira Aparelhos conectados no
   * celular"). Sem config → false (não finge logout).
   */
  static async logoutInstance(instanceName: string, config?: EvolutionConfig): Promise<boolean> {
    const cfg = config ?? this.getConfig();
    if (!cfg || !instanceName) return false;
    // 16/09/2026 — CORRIGIDO contra o fonte real do evolution-go (routes.go +
    // auth_middleware.go): logout é `DELETE /instance/logout` (SEM nome no
    // path) e o middleware `Auth` resolve a instância PELO TOKEN DELA no
    // header `apikey` (a chave GLOBAL não passa, sem fallback). A versão
    // anterior mandava `/instance/logout/<nome>` com a chave global →
    // 404/401 sempre (por isso providerLogout nunca confirmava). Busca o
    // token da instância via /instance/all (AuthAdmin) e faz o logout certo;
    // mantém os formatos antigos como fallback pra outros forks.
    const found = await this.findInstance(instanceName, cfg);
    if (found?.token) {
      try {
        const resp = (await evoFetch(`${cfg.baseUrl}/instance/logout`, { method: "DELETE", headers: { apikey: found.token } })) as FetchResult;
        if (resp.ok) return true;
      } catch { /* cai nos fallbacks */ }
      try {
        const resp = (await evoFetch(`${cfg.baseUrl}/instance/disconnect`, { method: "POST", headers: { "Content-Type": "application/json", apikey: found.token }, body: "{}" })) as FetchResult;
        if (resp.ok) return true;
      } catch { /* cai nos fallbacks */ }
    }
    const attempts: { method: string; path: string }[] = [
      { method: "DELETE", path: `/instance/logout/${encodeURIComponent(instanceName)}` },
      { method: "POST", path: `/instance/logout/${encodeURIComponent(instanceName)}` },
      { method: "POST", path: `/instance/disconnect/${encodeURIComponent(instanceName)}` },
    ];
    for (const a of attempts) {
      try {
        const resp = (await evoFetch(`${cfg.baseUrl}${a.path}`, { method: a.method, headers: { apikey: cfg.apiKey, instance: instanceName } })) as FetchResult;
        if (resp.ok) return true;
      } catch { /* tenta o próximo */ }
    }
    return false;
  }

  /**
   * Carrega config a partir de ENV. Retorna null se qualquer campo obrigatório
   * faltar — o caller decide se falha (rota /provision) ou pula (onboarding
   * best-effort). Extraído pra permitir override no teste.
   */
  static getConfig(overrides?: Partial<EvolutionConfig>): EvolutionConfig | null {
    const baseUrl = (overrides?.baseUrl ?? process.env.EVOLUTION_BASE_URL ?? "").replace(/\/$/, "");
    const apiKey = overrides?.apiKey ?? process.env.EVOLUTION_API_KEY ?? "";
    let webhookUrl = overrides?.webhookUrl ?? `${process.env.APP_URL || "http://localhost:3000"}/api/webhooks/evolution`;
    // Anexa o segredo do webhook (mesma URL que a tela de Integrações manda
    // colar à mão) — sem ele, com a exigência ligada, o inbound inteiro é 401.
    if (!overrides?.webhookUrl && _webhookSecretProvider) {
      try {
        const s = _webhookSecretProvider();
        if (s && !webhookUrl.includes("secret=")) {
          webhookUrl += `${webhookUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(s)}`;
        }
      } catch { /* sem secret disponível — registra sem, como antes */ }
    }
    if (!baseUrl || !apiKey) return null;
    return { baseUrl, apiKey, webhookUrl };
  }

  /**
   * Estado de conexão de uma linha do /instance/all, tolerante a fork.
   * 17/09/2026 — VERIFICADO no fonte real (EvolutionAPI/evolution-go 0.7.2,
   * instance_model.go): o GO serializa `connected` BOOLEANO (não existe campo
   * `status` string — o "Status: open" do manager é derivação da UI dele).
   * Sem ler o booleano, o sync nunca marcava conectado. Forks Node usam
   * status/connection/state string.
   */
  static providerStateOf(i: any): string {
    if (i?.connected === true) return "open";
    if (i?.connected === false) return "close";
    return String(i?.status ?? i?.connection ?? i?.connectionStatus ?? i?.state ?? "").toLowerCase();
  }

  /**
   * Lista as instâncias do provedor com o ESTADO de conexão (a mesma fonte do
   * "Status: open" do manager). null = provedor inacessível; [] = alcançável e
   * vazio. Base do sync de canais (o provedor é a verdade da sessão).
   * `webhook`/`events` são o que está REGISTRADO na instância (evolution-go
   * expõe os dois no /instance/all) — ouro pro diagnóstico de inbound.
   */
  static async listInstances(config?: EvolutionConfig): Promise<Array<{ name: string; id?: string; token?: string; state: string; webhook?: string | null; events?: string | null }> | null> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return null;
    try {
      const resp = (await evoFetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey } })) as FetchResult;
      if (!resp.ok) return null;
      const data = await resp.json();
      const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
      return list.map((i: any) => ({
        name: String(i?.name || i?.instanceName || ""),
        id: i?.id,
        token: i?.token || i?.apikey,
        state: this.providerStateOf(i),
        webhook: i?.webhook ?? null,
        events: i?.events ?? null,
      })).filter((i: any) => i.name);
    } catch { return null; }
  }

  /**
   * Registra o webhook/subscribe na instância (extraído do connectAndGetQr) —
   * agora com o RESULTADO visível: cada tentativa devolve o HTTP status, e `ok`
   * diz se ALGUM formato foi aceito. Antes as duas chamadas eram try/catch
   * mudos: um 404/401 aqui deixava a instância SEM webhook (pareada mas surda)
   * e ninguém ficava sabendo.
   */
  static async registerWebhook(instanceName: string, activeToken: string, config?: EvolutionConfig): Promise<{ ok: boolean; attempts: Array<{ path: string; status: number | string }> }> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return { ok: false, attempts: [{ path: "(config)", status: "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados" }] };
    const attempts: Array<{ path: string; status: number | string }> = [];
    try {
      const r = (await evoFetch(`${cfg.baseUrl}/instance/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: activeToken, instance: instanceName },
        body: JSON.stringify({ webhookUrl: cfg.webhookUrl, subscribe: ["MESSAGE", "CONNECTION", "QRCODE"] }),
      })) as FetchResult;
      attempts.push({ path: "/instance/connect", status: r.status });
    } catch (e: any) { attempts.push({ path: "/instance/connect", status: String(e?.message || e).slice(0, 80) }); }
    try {
      const r = (await evoFetch(`${cfg.baseUrl}/webhook/set/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: activeToken },
        body: JSON.stringify({
          webhook: { url: cfg.webhookUrl, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"] },
        }),
      })) as FetchResult;
      attempts.push({ path: "/webhook/set", status: r.status });
    } catch (e: any) { attempts.push({ path: "/webhook/set", status: String(e?.message || e).slice(0, 80) }); }
    const ok = attempts.some((a) => typeof a.status === "number" && a.status >= 200 && a.status < 300);
    return { ok, attempts };
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
      const listResp = (await evoFetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey } })) as FetchResult;
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
      createResp = (await evoFetch(`${cfg.baseUrl}/instance/create`, {
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
        createResp = (await evoFetch(`${cfg.baseUrl}/instance/create`, {
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
    // 17/09/2026 — extraído pra registerWebhook (resultado visível + reusável
    // pelo sync de canais, que re-registra numa instância já pareada).
    const webhookReg = await this.registerWebhook(instanceName, activeToken, cfg);

    // 1b. INV-07 (18/09/2026, caso real TOULON): "QR ausente em sessão conectada
    // significa que pareamento não é necessário". O /instance/connect acima
    // REVIVE o cliente no runtime do provedor; se as credenciais ainda valem,
    // ele re-loga sozinho e o GetQr NUNCA vai ter QR (no fonte, GetQr numa
    // sessão logada ainda REINICIA o cliente — insistir é nocivo). Então, antes
    // de pedir QR, pergunta o estado real: já "open" → conectado, sem QR.
    const liveState = async (): Promise<string> => {
      try {
        const all = await this.listInstances(cfg);
        return all?.find((x) => x.name === instanceName)?.state || "";
      } catch { return ""; }
    };
    if ((await liveState()) === "open") {
      return { ok: true, state: "open", token: activeToken, webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts };
    }

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
    let passkeyStage = "";
    let passkeyCode = "";
    let passkeyOpenUrl = "";
    // 16/09/2026 (4º relato) — o handler do evolution-go responde o MOTIVO no
    // corpo do 400 ({"error":"failed to start instance: ..."} ou "no QR code
    // available..."). Antes a gente descartava o corpo (`continue`) e reportava
    // o genérico "retornou vazio" — o operador ficava cego.
    // 17/09/2026 — erro POR ENDPOINT: o 404 do endpoint alternativo
    // (/api/v1/..., que não existe no evolution-go) SOBRESCREVIA o erro real
    // do endpoint principal — o diagnóstico mostrava "404 page not found" e
    // escondia o 401/400 verdadeiro do /instance/qr.
    const qrErrors = new Map<string, string>();
    // "session already logged in" no corpo do erro = a sessão re-logou no meio
    // do fluxo (credencial válida) — não existe QR a esperar.
    let alreadyLoggedIn = false;
    const qrEndpoints = [
      `${cfg.baseUrl}/instance/qr`,
      `${cfg.baseUrl}/api/v1/instance/qr`,
    ];
    const tryFetchQr = async (): Promise<string> => {
      for (const url of qrEndpoints) {
        try {
          const qrResp = (await evoFetch(url, {
            headers: { apikey: activeToken, instance: instanceName },
          })) as FetchResult;
          if (!qrResp.ok) {
            try {
              const body = await qrResp.text();
              let msg = "";
              try { msg = String(JSON.parse(body)?.error || ""); } catch { msg = body; }
              if (/already logged in/i.test(msg)) alreadyLoggedIn = true;
              if (msg) qrErrors.set(url.slice(cfg.baseUrl.length), `HTTP ${qrResp.status}: ${msg.slice(0, 160)}`);
            } catch { /* corpo ilegível — segue */ }
            continue;
          }
          const ct = qrResp.headers?.get?.("content-type") || "application/json";
          if (!String(ct).includes("application/json")) continue;
          const qrData = await qrResp.json();
          // 16/09/2026 (fonte real do build): quando a conta exige PASSKEY
          // (WebAuthn), NÃO existe QR — o GetQr devolve passkeyStage. Sem
          // capturar isso, reportávamos "QR vazio" e o operador ficava cego.
          // F5: além do estágio, captura o CÓDIGO e a URL da cerimônia — antes
          // eram descartados e o operador ia parar no Manager.
          if (qrData?.data?.passkeyStage) {
            passkeyStage = String(qrData.data.passkeyStage);
            if (qrData.data.passkeyCode) passkeyCode = String(qrData.data.passkeyCode);
            if (qrData.data.passkeyOpenUrl) passkeyOpenUrl = String(qrData.data.passkeyOpenUrl);
          }
          const got = qrData?.data?.qrcode || qrData?.base64 || qrData?.data?.Qrcode || qrData?.qrcode?.base64 || qrData?.data?.qr || qrData?.qr || "";
          if (got) return String(got);
        } catch { /* tenta próximo endpoint */ }
      }
      return "";
    };
    // 16/09/2026: janela AMPLIADA (3→5 tentativas, pausa 3s) MAS com ORÇAMENTO
    // TOTAL de 35s. O GetQr do evolution-go auto-inicia a sessão e dorme 3s
    // server-side — cold start real precisa de mais rodadas; porém, se cada
    // request estiver ESTOURANDO o timeout de 12s (provedor mudo), 5 rodadas ×
    // 2 endpoints passariam de 2 minutos com a UI pendurada. O deadline corta.
    const qrDeadline = Date.now() + 35_000;
    for (let attempt = 0; attempt < 5 && !qrBase64 && Date.now() < qrDeadline; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      qrBase64 = await tryFetchQr();
      if (passkeyStage) break; // passkey em andamento: QR não vai existir
      if (alreadyLoggedIn) break; // sessão re-logou: QR não vai existir (INV-07)
    }

    // F1.3 (RF-02/INV-07/CA-02) — REMOVIDO o auto-heal destrutivo que antes,
    // quando o QR vinha vazio, apagava (`DELETE /instance/delete/:id`) e recriava
    // a instância AUTOMATICAMENTE. Isso violava o invariante: "QR ausente em
    // sessão conectada significa que pareamento não é necessário, NÃO autorização
    // para reset" — o delete silencioso podia derrubar uma sessão ativa (ex.: um
    // evento fora de ordem ou uma corrida no GetQr) sem prova nem consentimento.
    // A capacidade de reset foi preservada em `resetInstance` (operação EXPLÍCITA,
    // exposta só a operador autorizado, com confirmação no produto). O connect
    // apenas SINALIZA `needsReset` no retorno vazio; quem decide resetar é humano.

    // 3. Fallback legacy — /instance/connect/<name> (Evolution API Node oficial).
    // Este endpoint devolve o próprio QR na resposta do "connect" — comportamento
    // diferente do Go/whatsmeow, que separa `connect` (subscribe) de `qr` (obter).
    if (!qrBase64) {
      try {
        const legacyResp = (await evoFetch(`${cfg.baseUrl}/instance/connect/${instanceName}`, {
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

    // INV-07: sem QR mas com sessão LOGADA no provedor = conectado — o caller
    // marca o canal `connected` (mesmo tratamento do state "open" legacy).
    // Confirma pelas duas fontes: o erro explícito do GetQr ("session already
    // logged in") ou o estado vivo do /instance/all re-checado agora.
    if (!qrBase64 && !passkeyStage && (alreadyLoggedIn || (await liveState()) === "open")) {
      return { ok: true, state: "open", token: activeToken, webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts };
    }

    if (state === "open") return { ok: true, state: "open", token: activeToken, webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts };
    if (qrBase64) {
      const finalQr = qrBase64.startsWith("data:image") ? qrBase64 : `data:image/png;base64,${qrBase64}`;
      return { ok: true, qrBase64: finalQr, token: activeToken, webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts };
    }
    // F5 do PRD Conexão WhatsApp: passkey em andamento é SUCESSO PENDENTE —
    // não é falha de QR, é outro fluxo de pareamento (WebAuthn). A UI mostra a
    // etapa (abrir link + código); antes convertíamos em erro e mandávamos o
    // operador pro Manager. Sem PASSKEY_PUBLIC_URL no servidor Evolution, a
    // openUrl vem como <SET_PASSKEY_PUBLIC_URL> → `misconfigured` (a UI pede a
    // configuração em vez de mostrar um link quebrado).
    if (passkeyStage) {
      const misconfigured = !passkeyOpenUrl || passkeyOpenUrl.includes("SET_PASSKEY_PUBLIC_URL") || !/^https:\/\//i.test(passkeyOpenUrl);
      return {
        ok: true, state: "awaiting_passkey", token: activeToken,
        webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts,
        passkey: { stage: passkeyStage, code: passkeyCode || undefined, openUrl: misconfigured ? undefined : passkeyOpenUrl, misconfigured },
      };
    }
    // QR vazio: honesto — e agora com o PORQUÊ do provedor (4º relato). Duas
    // fontes, na ordem de precisão:
    //  1. o corpo do erro que o próprio endpoint de QR devolveu (lastQrError);
    //  2. o último log de ERRO da instância no provedor (o Connect() com o
    //     WhatsApp morre numa goroutine — a falha real SÓ aparece lá).
    // Sinaliza `needsReset` só quando temos o instanceId (o reset EXPLÍCITO
    // precisa dele); nunca resetamos aqui (F1.3).
    const lastQrError = Array.from(qrErrors.entries()).map(([p, e]) => `${p} → ${e}`).join(" · ");
    let reason = lastQrError ? `provedor respondeu: ${lastQrError}` : "Evolution retornou vazio";
    if (instanceId) {
      try {
        const logs = await this.getInstanceLogs(instanceName, cfg, { instanceId, limit: 15 });
        const lastErr = [...logs].reverse().find((l) => /error|warn/i.test(l.level));
        if (lastErr) reason += ` · último log da instância [${lastErr.level}]: ${lastErr.message.slice(0, 200)}`;
      } catch { /* best-effort */ }
    }
    return { ok: false, error: `QR não obtido (${reason})`, needsReset: !!instanceId, webhookRegistered: webhookReg.ok, webhookAttempts: webhookReg.attempts };
  }

  /**
   * RESET EXPLÍCITO de uma instância travada (F1.3 — RF-02/INV-07/CA-02).
   *
   * Faz o que o antigo auto-heal fazia (DELETE /instance/delete/:id + recriar +
   * reconectar + QR), MAS como operação DELIBERADA: só deve ser chamada a partir
   * de uma rota autenticada de operador autorizado, com confirmação explícita no
   * produto e ciência do impacto (a sessão atual é encerrada). Nunca é disparada
   * automaticamente pelo caminho de conexão. Idempotente do ponto de vista do
   * caller: recria a instância e devolve QR/estado como o provision normal.
   */
  static async resetInstance(
    instanceName: string,
    instanceId: string,
    config?: EvolutionConfig,
  ): Promise<ConnectAndQrResult> {
    const cfg = config ?? this.getConfig();
    if (!cfg) return { ok: false, error: "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados" };
    if (!instanceId) return { ok: false, error: "resetInstance exige instanceId" };
    // Apaga o client zumbi (Disconnect + limpeza no whatsmeow) — AuthAdmin.
    try {
      await evoFetch(`${cfg.baseUrl}/instance/delete/${instanceId}`, {
        method: "DELETE",
        headers: { apikey: cfg.apiKey },
      });
    } catch { /* best-effort — se o delete falhar, o create abaixo ainda tenta */ }
    // Recria do zero e reconecta pelo caminho normal (que registra webhook + QR).
    const recreated = await this.createInstance(instanceName, config);
    if (!recreated.ok || !recreated.token) {
      return { ok: false, error: recreated.error || "Falha ao recriar instância no reset" };
    }
    return this.connectAndGetQr(instanceName, recreated.token, config, recreated.instanceId);
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
