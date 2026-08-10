import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { TaskService } from "./TaskService.js";
import { AppointmentService, TZ_OFFSET_MIN } from "./AppointmentService.js";
import { PurchaseRequisitionService } from "./PurchaseRequisitionService.js";

/**
 * FalaTu (ADR-151) — captura multimodal "Fala → Faz → Confere".
 *
 * O usuário fala/digita/fotografa → a IA transcreve e extrai intenção +
 * entidades → o item fica PENDENTE no inbox → o humano confirma (ou descarta)
 * → só então a tarefa/compromisso/lista materializa. Porte do protótipo
 * `Eldastito/FalaTu` reimplementado sobre as fundações da plataforma (llm.ts,
 * better-sqlite3, auditoria) — ver levantamento e decisões no ADR.
 *
 * Guardrails RN-151 (testados em scripts/test-falatu.ts):
 * - A IA NUNCA cria nada sozinha: capture() só registra o item pendente;
 *   materializar é exclusivo do confirm(), uma ação humana separada.
 * - NUNCA inventa data/hora de compromisso: sem data explícita na entrada,
 *   `eventDate` fica null e o humano preenche na confirmação (a origem
 *   defaultava "hoje", violando o próprio PRD).
 * - NUNCA inventa itens de lista que não estão na entrada.
 * - confirm() relê DO BANCO o que a IA extraiu — o cliente só sobrepõe campos
 *   editáveis (intent/título/data/hora/itens), nunca dono/organização (a
 *   origem aceitava o payload inteiro do cliente, forjável).
 * - `confidence` obrigatório na extração (a UI pede mais atenção quando baixo).
 *
 * Fatia 2 (rollout multi-tenant): o gate deixou de ser requireMasterAdmin e
 * virou flag opt-in da org (`organization_settings.falatu_enabled`, ligada
 * pelo operador no Admin Master) + RBAC granular ADR-095 (módulo "falatu" no
 * enforcement global; perfis com default none começam sem acesso). O Master
 * Admin continua entrando independente da flag. Limite de uso por plano: cada
 * captura é uma ação de IA — respeita PlanService.aiAllowed (billing + teto
 * mensal + top-ups ADR-091) e conta no ai_interactions_log como as demais.
 * TODA query filtra organization_id + user_id (convenção nº 1).
 * Nunca DELETE (convenção nº 9): discard é UPDATE de status.
 *
 * Fatia 5 (memória com desambiguação ATIVA): a captura cruza as menções da
 * extração (pessoas/projetos) com a memória (falatu_entities) por regra de
 * CÓDIGO, nunca de IA:
 * - 0 correspondências → 'new' (a confirmação cria a entidade, como antes);
 * - 1 correspondência (exata ou por prefixo de nome: "Carlos" ↔ "Carlos
 *   Silva") → 'known', auto-vinculada — é dedução determinística de match
 *   único, não um chute (e a confirmação só atualiza o contexto da entidade
 *   existente em vez de criar a duplicata "carlos");
 * - 2+ correspondências → 'ambiguous': o sistema PERGUNTA "qual Carlos?" e
 *   quem escolhe é o humano (resolveMention valida que a escolha está entre
 *   os candidatos sugeridos — o cliente não injeta vínculo arbitrário).
 *   Sem escolha, a confirmação NÃO vincula nem cria a entidade da menção —
 *   memória não é poluída por palpite.
 */

export type FalaTuIntent = "TASK" | "EVENT" | "LIST" | "NOTE" | "UNKNOWN";

export interface FalaTuExtraction {
  transcription: string;
  summary: string;
  intent: FalaTuIntent;
  entities: {
    people: string[];
    projects: string[];
    actions: string[];
    listItems: string[];
    eventDate: string | null; // YYYY-MM-DD, SÓ se explícita na entrada
    eventTime: string | null; // HH:MM, idem
  };
  confidence: number; // 0..1
  suggestedAction: string;
}

export interface FalaTuCaptureInput {
  text?: string;
  audio?: { mimeType: string; data: string }; // base64
  image?: { mimeType: string; data: string }; // base64
  source?: string;
  commandId?: string; // F8.2 — dedup de reenvio da fila offline (opcional)
}

const INTENTS: FalaTuIntent[] = ["TASK", "EVENT", "LIST", "NOTE", "UNKNOWN"];

export type FalaTuMentionStatus = "new" | "known" | "ambiguous";

export interface FalaTuMention {
  mention: string;
  type: "PERSON" | "PROJECT";
  status: FalaTuMentionStatus;
  candidates: { id: string; name: string; context: string | null }[];
  resolvedEntityId: string | null; // auto (known) ou escolha humana (ambiguous)
  resolvedNew: boolean;            // humano decidiu "outro/novo" numa ambígua
}

// Normalização de nome pro matching da memória (mesma régua da conferência de
// compras, Fatia 4): lower + sem acento + só alfanumérico. Calculada em runtime
// sobre `name` (não sobre name_norm, que historicamente não tira acento).
function normName(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseFalaTuMemory(json: string | null | undefined): { mentions: FalaTuMention[] } | null {
  try {
    const m = JSON.parse(json || "null");
    return m && Array.isArray(m.mentions) ? m : null;
  } catch { return null; }
}

// Prompt ÚNICO de extração (a origem tinha 2 cópias já divergentes). As regras
// de "nunca invente" seguem a disciplina dos prompts de visão da plataforma
// (ADR-019/021/030): campo não presente na entrada = null, nunca um chute.
const EXTRACTION_SYSTEM = `Você é o assistente "FalaTu". Receba uma entrada do usuário (texto, transcrição de áudio ou conteúdo extraído de imagem/nota) e devolva SOMENTE um JSON:
{"transcription": "o texto original/transcrito/extraído", "summary": "resumo em 1 frase da intenção principal", "intent": "TASK"|"EVENT"|"LIST"|"NOTE"|"UNKNOWN", "entities": {"people": ["nomes de pessoas citadas"], "projects": ["projetos citados"], "actions": ["ações a fazer"], "listItems": ["itens de lista, SÓ se intent=LIST"], "eventDate": "YYYY-MM-DD SÓ se a entrada disser a data explicitamente, senão null", "eventTime": "HH:MM SÓ se a entrada disser o horário explicitamente, senão null"}, "confidence": <número 0 a 1>, "suggestedAction": "descrição amigável do que sugere fazer"}
Regras rígidas: NUNCA invente data ou horário que não estejam na entrada — use null (quem decide é o humano na confirmação). NUNCA invente itens de lista que não foram ditos. NUNCA invente nomes. Responda SOMENTE o JSON.`;

function normalizeExtraction(raw: any): FalaTuExtraction {
  const e = raw?.entities || {};
  const arr = (v: any) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : []);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const timeRe = /^\d{2}:\d{2}$/;
  return {
    transcription: typeof raw?.transcription === "string" ? raw.transcription : "",
    summary: typeof raw?.summary === "string" ? raw.summary : "",
    intent: INTENTS.includes(raw?.intent) ? raw.intent : "UNKNOWN",
    entities: {
      people: arr(e.people),
      projects: arr(e.projects),
      actions: arr(e.actions),
      listItems: arr(e.listItems),
      eventDate: dateRe.test(e.eventDate || "") ? e.eventDate : null,
      eventTime: timeRe.test(e.eventTime || "") ? e.eventTime : null,
    },
    confidence: Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
    suggestedAction: typeof raw?.suggestedAction === "string" ? raw.suggestedAction : "",
  };
}

// ADR-160 F5/F6/F7 — estado das portas I/O (opt-ins de espelho no domínio canônico).
export interface BridgeState { tasks: boolean; events: boolean; lists: boolean; }

export class FalaTuService {
  /** A org ligou o FalaTu? (flag opt-in Fatia 2; Master Admin não passa por aqui.) */
  static orgEnabled(orgId: string): boolean {
    try {
      const r = db.prepare(`SELECT falatu_enabled FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      return !!Number(r?.falatu_enabled);
    } catch { return false; }
  }

  static setOrgEnabled(orgId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET falatu_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled };
  }

  /**
   * Chamada de IA isolada num método estático próprio pra ser mockável em
   * teste sem chave OpenAI (mesmo padrão de TaskAudioService.extractTaskFromText).
   *
   * F5.2 — se `opts.systemPreamble` está setado (RAG ligou e bateu memória
   * relevante), o preamble é prepend no `EXTRACTION_SYSTEM` como bloco
   * `<memoria_relevante>`. O prompt final vira "memória + regras de
   * extração" — a LLM lê a memória como contexto ANTES de decidir intent,
   * mas as regras rígidas do EXTRACTION_SYSTEM (não invente data/hora/etc)
   * seguem valendo. Vale pros dois caminhos (text/audio + imagem).
   */
  static async interpret(
    input: FalaTuCaptureInput,
    opts: { systemPreamble?: string } = {},
  ): Promise<FalaTuExtraction> {
    const llm = await import("./llm.js");
    if (!llm.isAIConfigured()) throw new Error("IA não configurada (OPENAI_API_KEY ausente).");

    const system = opts.systemPreamble
      ? `${opts.systemPreamble}\n\n${EXTRACTION_SYSTEM}`
      : EXTRACTION_SYSTEM;

    let raw = "";
    if (input.image?.data) {
      raw = await llm.extractStructuredFromImage(
        input.image.data,
        input.image.mimeType || "image/jpeg",
        system,
        input.text?.trim() || "Extraia os dados pedidos desta imagem e devolva SOMENTE o JSON.",
        "high", // captura por foto: leitura de detalhe fino (rótulos, valores, texto pequeno).
      );
    } else {
      let text = input.text?.trim() || "";
      if (input.audio?.data) {
        const buffer = Buffer.from(input.audio.data, "base64");
        const mime = input.audio.mimeType || "audio/ogg";
        const ext = mime.includes("webm") ? "webm" : mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "ogg";
        const transcript = await llm.transcribeAudio(buffer, `falatu.${ext}`, mime);
        text = text ? `${text}\n${transcript}` : transcript;
      }
      if (!text) throw new Error("Entrada vazia.");
      raw = await llm.chat(text, { json: true, temperature: 0.2, system });
    }

    let parsed: any = {};
    try { parsed = JSON.parse(raw || "{}"); } catch { /* JSON malformado do LLM → extração vazia com confidence 0, nunca 500 */ }
    return normalizeExtraction(parsed);
  }

  /** Captura uma entrada, roda a extração e registra o item PENDENTE. Não cria nada além do inbox. */
  static async capture(orgId: string, userId: string, input: FalaTuCaptureInput) {
    if (!input.text?.trim() && !input.audio?.data && !input.image?.data) {
      throw new Error("Envie texto, áudio ou imagem.");
    }
    // ADR-154 F8.2 — idempotência de reenvio da fila offline: o MESMO
    // (org, user, commandId) devolve a captura já registrada ANTES de gastar
    // qualquer IA (reenvio do outbox não paga extração duas vezes). Checar
    // antes do aiAllowed é proposital: reenvio de captura já cobrada não pode
    // ser recusado por teto atingido depois dela.
    const commandId = input.commandId?.trim() || null;
    if (commandId) {
      const existing = db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? AND client_command_id = ?`).get(orgId, userId, commandId) as any;
      if (existing) return existing;
    }
    // ADR-154 F8.7 — Protocolos: TEXTO é checado ANTES de qualquer IA (match
    // é regra de código; ativação de resgate não paga extração nem vira item
    // pendente). Áudio precisa transcrever primeiro — checado após interpret.
    // 0 match → null → a captura segue exatamente o fluxo de sempre.
    if (input.text?.trim()) {
      const { FalaTuProtocolService } = await import("./FalaTuProtocolService.js");
      const proto = FalaTuProtocolService.handleCaptureText(orgId, userId, input.text, input.source);
      if (proto) return { protocol: proto };
    }
    // Fatia 2 — limite de uso por plano: captura consome IA, então passa pelo
    // mesmo enforcement do atendimento (billing bloqueado + teto mensal do
    // plano + top-ups/recompra automática, ADR-091 §4). Invariante de negócio
    // fica no service (a rota só valida forma).
    const { PlanService } = await import("./PlanService.js");
    const gate = PlanService.aiAllowed(orgId);
    if (!gate.allowed) {
      if (gate.reason === "monthly_limit") throw new Error("Limite mensal de ações de IA do plano atingido. Compre um pacote extra ou aguarde a virada do mês.");
      if (gate.reason === "billing_past_due") throw new Error("Sua assinatura está em atraso. Regularize o pagamento pra voltar a usar o FalaTu.");
      throw new Error("Conta bloqueada ou cobrança pendente — captura por IA indisponível.");
    }
    // ADR-154 F1.1 — atribui o consumo desta captura ao FalaTu (org + usuário +
    // módulo). Sem isto, chamadas downstream em llm.ts caem no default
    // module='legacy' e o dashboard admin não consegue separar quanto o FalaTu
    // gastou vs. outros módulos. É o backfill best-effort do primeiro módulo.
    const { setUsageContext } = await import("./usageContext.js");
    setUsageContext({ orgId, userId, module: "falatu" });
    // ADR-154 F5.2 — RAG: se a org ligou `falatu_rag_enabled`, faz busca
    // top-K por similaridade cosseno na memória confirmada (F5.1) usando o
    // texto de entrada como query, e monta um bloco `<memoria_relevante>`
    // pra prepend no system do llm.chat DENTRO de interpret(). O custo do
    // embedding da query é cobrado da org (setUsageContext já rodou acima).
    // Sem texto (áudio ou imagem sem legenda), pula — F5.3 pode plugar RAG
    // sobre transcrito. Best-effort: erro no RAG nunca derruba a captura.
    let systemPreamble = "";
    try {
      const queryText = input.text?.trim() || "";
      if (queryText) {
        const { FalaTuMemoryEmbeddingsService } = await import("./FalaTuMemoryEmbeddingsService.js");
        systemPreamble = await FalaTuMemoryEmbeddingsService.buildRelevantMemoryBlock(orgId, userId, queryText, 5);
      }
    } catch (e) {
      console.error("[FalaTu] RAG preamble falhou (best-effort — segue sem memória):", e);
    }
    const extraction = await FalaTuService.interpret(input, systemPreamble ? { systemPreamble } : {});
    const id = randomUUID();
    const mediaType = input.image?.data ? "image" : input.audio?.data ? "audio" : null;
    // F8.7 — Protocolos por ÁUDIO: agora que existe transcrição, aplica a
    // mesma regra de código. Ativação não vira item pendente (a transcrição
    // já foi paga — metering RN-154 §8 intacto).
    if (mediaType === "audio" && extraction.transcription) {
      const { FalaTuProtocolService } = await import("./FalaTuProtocolService.js");
      const proto = FalaTuProtocolService.handleCaptureText(orgId, userId, extraction.transcription, input.source);
      if (proto) return { protocol: proto };
    }
    const mentions = FalaTuService.analyzeMentions(orgId, userId, extraction);
    try {
      db.prepare(`
        INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, media_type, transcription, summary, intent, entities_json, suggested_action, confidence, status, memory_json, client_command_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id, orgId, userId, input.source === "whatsapp" ? "whatsapp" : "webapp",
        input.text?.trim() || null, mediaType,
        extraction.transcription || null, extraction.summary || null, extraction.intent,
        JSON.stringify(extraction.entities), extraction.suggestedAction || null, extraction.confidence,
        JSON.stringify({ mentions }), commandId
      );
    } catch (e: any) {
      // Corrida de reenvio simultâneo (duas abas / flush duplo): o unique
      // parcial decide e devolvemos o vencedor (padrão convenção nº 7).
      if (commandId && String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? AND client_command_id = ?`).get(orgId, userId, commandId) as any;
        if (winner) return winner;
      }
      throw e;
    }
    // Conta a captura como ação de IA do mês (mesma régua do PlanService.getUsage
    // e do aiAllowed) — sem isto o FalaTu seria IA "de graça" fora do plano.
    // Best-effort (convenção nº 7): falha no log de consumo nunca perde a captura.
    try {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, input_prompt, output_response, confidence) VALUES (?, ?, 'falatu', ?, ?, ?)`)
        .run(randomUUID(), orgId, (input.text?.trim() || (mediaType ? `[${mediaType}]` : "")).slice(0, 500), extraction.summary || extraction.intent, extraction.confidence);
    } catch { /* noop */ }
    logAuthEvent(orgId, userId, null, "FALATU_CAPTURE", { inboxItemId: id, intent: extraction.intent, mediaType, confidence: extraction.confidence, ragInjected: !!systemPreamble });
    return FalaTuService.getInboxItem(orgId, userId, id);
  }

  static getInboxItem(orgId: string, userId: string, id: string): any {
    return db.prepare(`SELECT * FROM falatu_inbox_items WHERE id = ? AND organization_id = ? AND user_id = ?`).get(id, orgId, userId);
  }

  /**
   * Fatia 5 — cruza as menções da extração com a memória do usuário. Regra de
   * CÓDIGO (ver header): match por nome normalizado exato ou por prefixo de
   * palavra ("carlos" casa "carlos silva" e vice-versa). 1 candidato =
   * auto-vínculo determinístico; 2+ = ambíguo, o humano resolve.
   */
  static analyzeMentions(orgId: string, userId: string, extraction: FalaTuExtraction): FalaTuMention[] {
    let stored: any[] = [];
    try {
      stored = db.prepare(`SELECT id, entity_type, name, context FROM falatu_entities WHERE organization_id = ? AND user_id = ?`).all(orgId, userId) as any[];
    } catch { stored = []; }
    const mentions: FalaTuMention[] = [];
    const add = (type: "PERSON" | "PROJECT", list: string[]) => {
      for (const raw of Array.isArray(list) ? list : []) {
        const mention = String(raw).trim();
        const mNorm = normName(mention);
        if (!mNorm) continue;
        const candidates = stored
          .filter((e) => e.entity_type === type)
          .filter((e) => {
            const eNorm = normName(e.name);
            return eNorm === mNorm || eNorm.startsWith(mNorm + " ") || mNorm.startsWith(eNorm + " ");
          })
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
          .slice(0, 8)
          .map((e) => ({ id: e.id, name: e.name, context: e.context || null }));
        const status: FalaTuMentionStatus = candidates.length === 0 ? "new" : candidates.length === 1 ? "known" : "ambiguous";
        mentions.push({
          mention, type, status, candidates,
          resolvedEntityId: status === "known" ? candidates[0].id : null,
          resolvedNew: false,
        });
      }
    };
    add("PERSON", extraction.entities.people || []);
    add("PROJECT", extraction.entities.projects || []);
    return mentions;
  }

  /**
   * Resolução HUMANA de uma menção ambígua ("qual Carlos?"). `entityId` tem
   * que estar entre os candidatos sugeridos na captura (guardrail RN-151: o
   * cliente escolhe entre o que o código propôs, nunca injeta vínculo);
   * `entityId=null` = "outro/novo" (a confirmação cria a entidade da menção).
   */
  static resolveMention(orgId: string, userId: string, inboxItemId: string, mention: string, entityId: string | null) {
    const item = FalaTuService.getInboxItem(orgId, userId, inboxItemId);
    if (!item) throw new Error("Item não encontrado.");
    if (item.status !== "pending") throw new Error("Item já resolvido.");
    const memory = parseFalaTuMemory(item.memory_json);
    if (!memory) throw new Error("Item sem menções para resolver.");
    const m = memory.mentions.find((x) => x.mention === mention || normName(x.mention) === normName(mention));
    if (!m) throw new Error("Menção não encontrada neste item.");
    if (entityId) {
      if (!(m.candidates || []).some((c) => c.id === entityId)) {
        throw new Error("Escolha inválida: a opção não está entre as sugeridas.");
      }
      m.resolvedEntityId = entityId;
      m.resolvedNew = false;
    } else {
      m.resolvedEntityId = null;
      m.resolvedNew = true;
    }
    db.prepare(`UPDATE falatu_inbox_items SET memory_json = ? WHERE id = ? AND organization_id = ? AND user_id = ?`)
      .run(JSON.stringify(memory), item.id, orgId, userId);
    logAuthEvent(orgId, userId, null, "FALATU_RESOLVE_MENTION", { inboxItemId: item.id, mention: m.mention, entityId: entityId || null, isNew: !entityId });
    return FalaTuService.getInboxItem(orgId, userId, inboxItemId);
  }

  static listInbox(orgId: string, userId: string, status?: string): any[] {
    if (status) {
      return db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200`).all(orgId, userId, status);
    }
    return db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 200`).all(orgId, userId);
  }

  /**
   * Confirmação humana ("Confere"): relê o item pendente DO BANCO e
   * materializa a entidade. `overrides` cobre só os campos que o humano pode
   * editar na tela de confirmação — intenção, título, data/hora, itens.
   */
  static confirm(
    orgId: string,
    userId: string,
    inboxItemId: string,
    overrides: { intent?: string; title?: string; eventDate?: string | null; eventTime?: string | null; listItems?: string[]; listType?: string; mentionResolutions?: Record<string, string>; contactId?: string | null } = {}
  ) {
    // Fatia 5: resoluções de menção enviadas junto da confirmação (a UI faz
    // tudo num clique) passam pelo MESMO validador do resolveMention — a
    // escolha tem que estar entre os candidatos sugeridos ("new" = outro/novo).
    if (overrides.mentionResolutions && typeof overrides.mentionResolutions === "object") {
      for (const [mention, choice] of Object.entries(overrides.mentionResolutions)) {
        if (typeof choice !== "string" || !choice) continue;
        FalaTuService.resolveMention(orgId, userId, inboxItemId, mention, choice === "new" ? null : choice);
      }
    }
    const item = FalaTuService.getInboxItem(orgId, userId, inboxItemId);
    if (!item) throw new Error("Item não encontrado.");
    if (item.status !== "pending") throw new Error("Item já resolvido.");

    let entities: FalaTuExtraction["entities"];
    try { entities = JSON.parse(item.entities_json || "{}"); } catch { entities = {} as any; }

    const intent = (overrides.intent && INTENTS.includes(overrides.intent as FalaTuIntent) ? overrides.intent : item.intent) as FalaTuIntent;
    const title = overrides.title?.trim() || item.summary || item.transcription || item.content || "Sem título";

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const timeRe = /^\d{2}:\d{2}$/;
    // RN-151: data/hora vêm da extração ou do humano — nunca de um default.
    const eventDate = overrides.eventDate !== undefined
      ? (dateRe.test(overrides.eventDate || "") ? overrides.eventDate : null)
      : (entities?.eventDate || null);
    const eventTime = overrides.eventTime !== undefined
      ? (timeRe.test(overrides.eventTime || "") ? overrides.eventTime : null)
      : (entities?.eventTime || null);

    // ADR-160 F5/F6 — porta I/O: a org optou por espelhar tarefa/evento no
    // domínio canônico? Lê as flags ANTES da transação (uma vez).
    const bridgeTasks = FalaTuService.isTaskBridgeEnabled(orgId);
    const bridgeEvents = FalaTuService.isEventBridgeEnabled(orgId);
    const bridgeLists = FalaTuService.isListBridgeEnabled(orgId);
    // F6: contato REAL vinculado pelo humano nesta confirmação (nunca inventado).
    // Só vira agendamento canônico se existir NESTA org (senão, silo-only).
    const rawContactId = typeof overrides.contactId === "string" ? overrides.contactId.trim() : "";
    const eventContactId = rawContactId && db.prepare("SELECT id FROM contacts WHERE id = ? AND organization_id = ?").get(rawContactId, orgId) ? rawContactId : null;

    // ADR-154 F5.1: coleta IDs de entidades tocadas nesta confirmação pra
    // enfileirar embeddings DEPOIS da transação — nunca dentro (evita atrasar
    // commit por chamada de rede + queremos o embedding SÓ do que persistiu).
    const touchedEntityIds = new Set<string>();
    let bridgedTaskId: string | null = null;
    let bridgedAppointmentId: string | null = null;
    let bridgedRequisitionId: string | null = null;
    const result = db.transaction(() => {
      let confirmedKind: string | null = null;
      let refId: string | null = null;

      if (intent === "TASK") {
        refId = randomUUID();
        db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, description, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(refId, orgId, userId, title, item.transcription || item.content || null, item.id);
        confirmedKind = "task";
        // Porta I/O: espelha no TaskService canônico (atômico — mesma tx; a
        // criação é INSERT síncrono, sem assignee ⇒ sem notificação/rede aqui).
        // `source:'falatu'` dá rastreabilidade; o vínculo silo→canônico fica em
        // `bridged_task_id`. Falha aqui derruba a confirmação inteira (não deixa
        // silo sem canônico quando a porta está ligada).
        if (bridgeTasks) {
          const canonical = TaskService.create(orgId, { title, description: item.transcription || item.content || undefined, source: "falatu" }, userId);
          bridgedTaskId = canonical?.id || null;
          if (bridgedTaskId) db.prepare(`UPDATE falatu_tasks SET bridged_task_id = ? WHERE id = ?`).run(bridgedTaskId, refId);
        }
      } else if (intent === "EVENT") {
        refId = randomUUID();
        db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(refId, orgId, userId, title, eventDate, eventTime, item.id);
        confirmedKind = "event";
        // Porta I/O (F6): espelha na agenda CANÔNICA só quando há contato REAL
        // vinculado + data + hora (appointments.contact_id é NOT NULL; nunca
        // inventa — RN-151). Sem isso, fica lembrete pessoal no silo. Cria SÓ o
        // registro (AppointmentService.create não dispara e-mail/Calendar — isso
        // é da borda). Atômico com o silo (mesma tx; contato já validado acima).
        if (bridgeEvents && eventContactId && eventDate && eventTime) {
          const off = TZ_OFFSET_MIN, sign = off <= 0 ? "-" : "+", abs = Math.abs(off);
          const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
          const appt = AppointmentService.create(orgId, { contactId: eventContactId, title, scheduledStart: `${eventDate}T${eventTime}:00${tz}` }, userId);
          bridgedAppointmentId = appt?.id || null;
          if (bridgedAppointmentId) db.prepare(`UPDATE falatu_events SET bridged_appointment_id = ? WHERE id = ?`).run(bridgedAppointmentId, refId);
        }
      } else if (intent === "LIST") {
        refId = randomUUID();
        const listType = ["general", "shopping", "meeting", "trip"].includes(overrides.listType || "") ? overrides.listType : "general";
        db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(refId, orgId, userId, title, listType, item.id);
        // RN-151: itens vêm da extração ou do humano — nunca fabricados.
        const items = Array.isArray(overrides.listItems)
          ? overrides.listItems.filter((x) => typeof x === "string" && x.trim())
          : (Array.isArray(entities?.listItems) ? entities.listItems : []);
        const ins = db.prepare(`INSERT INTO falatu_list_items (id, organization_id, list_id, name) VALUES (?, ?, ?, ?)`);
        for (const name of items) ins.run(randomUUID(), orgId, refId, String(name).trim());
        confirmedKind = "list";
        // Porta I/O (F7): SÓ lista de COMPRAS vira requisição canônica (general/
        // meeting/trip não são domínio de negócio → silo-only). E só os itens que
        // CASAM com o catálogo (matcher determinístico) viram linhas — os demais
        // ficam no silo (product_service_id é NOT NULL; nunca inventa produto —
        // RN-151). Cria rascunho (draft): humano aprova depois (nunca auto-compra).
        // Síncrono ⇒ atômico com o silo. `chat`/IA não é tocada aqui.
        if (bridgeLists && listType === "shopping" && items.length) {
          const { matched } = PurchaseRequisitionService.matchItemsToProducts(orgId, items.map((n) => ({ name: String(n).trim() })));
          if (matched.length) {
            const req = PurchaseRequisitionService.addManualItems(orgId, matched.map((m) => ({ productServiceId: m.productServiceId, quantity: m.quantity })), userId);
            bridgedRequisitionId = req?.id || null;
            if (bridgedRequisitionId) db.prepare(`UPDATE falatu_lists SET bridged_requisition_id = ? WHERE id = ?`).run(bridgedRequisitionId, refId);
          }
        }
      } else {
        confirmedKind = "note"; // NOTE/UNKNOWN: só arquiva como memória confirmada
      }

      // Memória de entidades: upsert deduplica por nome normalizado (a origem
      // duplicava a cada confirmação).
      const upsert = db.prepare(`
        INSERT INTO falatu_entities (id, organization_id, user_id, entity_type, name, name_norm, context)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (organization_id, user_id, entity_type, name_norm)
        DO UPDATE SET context = excluded.context, updated_at = CURRENT_TIMESTAMP
      `);
      const memory = parseFalaTuMemory(item.memory_json);
      if (memory) {
        // Fatia 5 — memory-aware: menção vinculada (auto 'known' ou escolha
        // humana) só ATUALIZA o contexto da entidade existente — "Carlos" não
        // vira duplicata de "Carlos Silva". Ambígua sem resolução NÃO vincula
        // nem cria (nunca por palpite); 'new'/"outro" cria como antes.
        const touch = db.prepare(`UPDATE falatu_entities SET context = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND user_id = ?`);
        for (const m of memory.mentions) {
          if (m.resolvedEntityId) {
            touch.run(item.summary || null, m.resolvedEntityId, orgId, userId);
            touchedEntityIds.add(m.resolvedEntityId);
          } else if (m.status === "new" || m.resolvedNew) {
            const type = m.type === "PROJECT" ? "PROJECT" : "PERSON";
            const nameNorm = m.mention.trim().toLowerCase();
            upsert.run(randomUUID(), orgId, userId, type, m.mention, nameNorm, item.summary || null);
            // Após upsert, resolve o id (novo OU existente atualizado — ON CONFLICT).
            const row = db.prepare(`SELECT id FROM falatu_entities WHERE organization_id = ? AND user_id = ? AND entity_type = ? AND name_norm = ?`).get(orgId, userId, type, nameNorm) as any;
            if (row?.id) touchedEntityIds.add(row.id);
          }
        }
      } else {
        // Itens capturados antes da Fatia 5 (sem memory_json): comportamento original.
        for (const p of (Array.isArray(entities?.people) ? entities.people : [])) {
          const nameNorm = p.trim().toLowerCase();
          upsert.run(randomUUID(), orgId, userId, "PERSON", p, nameNorm, item.summary || null);
          const row = db.prepare(`SELECT id FROM falatu_entities WHERE organization_id = ? AND user_id = ? AND entity_type = 'PERSON' AND name_norm = ?`).get(orgId, userId, nameNorm) as any;
          if (row?.id) touchedEntityIds.add(row.id);
        }
        for (const p of (Array.isArray(entities?.projects) ? entities.projects : [])) {
          const nameNorm = p.trim().toLowerCase();
          upsert.run(randomUUID(), orgId, userId, "PROJECT", p, nameNorm, item.summary || null);
          const row = db.prepare(`SELECT id FROM falatu_entities WHERE organization_id = ? AND user_id = ? AND entity_type = 'PROJECT' AND name_norm = ?`).get(orgId, userId, nameNorm) as any;
          if (row?.id) touchedEntityIds.add(row.id);
        }
      }

      db.prepare(`UPDATE falatu_inbox_items SET status = 'confirmed', confirmed_kind = ?, confirmed_ref_id = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`)
        .run(confirmedKind, refId, userId, item.id);
      return { confirmedKind, refId };
    })();

    logAuthEvent(orgId, userId, null, "FALATU_CONFIRM", { inboxItemId: item.id, kind: result.confirmedKind, refId: result.refId, bridgedTaskId, bridgedAppointmentId, bridgedRequisitionId });

    // ADR-154 F5.1: enfileira embeddings da memória (assíncrono, opt-in via
    // falatu_rag_enabled). Best-effort — SoloEmbeddingsService swallows erros
    // e o service skipa silenciosamente se a org não ligou RAG. Chamada DEPOIS
    // do logAuth pra não atrasar o caminho crítico do "Fala → Faz → Confere".
    // Import dinâmico quebra ciclo potencial (Embeddings importaria FalaTu via
    // testes futuros) e mantém convenção nº 11 do CLAUDE.md.
    void import("./FalaTuMemoryEmbeddingsService.js").then((m) => {
      try {
        m.FalaTuMemoryEmbeddingsService.enqueueForInboxItem(orgId, userId, item.id);
        for (const eid of touchedEntityIds) {
          m.FalaTuMemoryEmbeddingsService.enqueueForEntity(orgId, userId, eid);
        }
      } catch (e) {
        console.error("[FalaTu] Falha ao enfileirar embeddings (best-effort):", e);
      }
    }).catch(() => { /* import falhou — não impacta confirm */ });

    return { success: true, kind: result.confirmedKind, refId: result.refId, bridgedTaskId, bridgedAppointmentId, bridgedRequisitionId, item: FalaTuService.getInboxItem(orgId, userId, inboxItemId) };
  }

  /**
   * ADR-160 F5/F6/F7 — PORTA I/O. Estado/controle dos opt-ins que fazem o Fala Tu
   * escrever no domínio CANÔNICO ao confirmar: TASK → `TaskService` (F5); EVENT →
   * agenda via `AppointmentService` (F6, só com contato+data+hora); LIST 'shopping'
   * → requisição de compra via `PurchaseRequisitionService` (F7, só itens do
   * catálogo). Além dos silos. Default off = comportamento de hoje (0 regressão).
   */
  static isTaskBridgeEnabled(orgId: string): boolean {
    const row = db.prepare("SELECT falatu_bridge_tasks_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return !!(row && Number(row.falatu_bridge_tasks_enabled));
  }

  static isEventBridgeEnabled(orgId: string): boolean {
    const row = db.prepare("SELECT falatu_bridge_events_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return !!(row && Number(row.falatu_bridge_events_enabled));
  }

  static isListBridgeEnabled(orgId: string): boolean {
    const row = db.prepare("SELECT falatu_bridge_lists_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return !!(row && Number(row.falatu_bridge_lists_enabled));
  }

  static setTaskBridge(orgId: string, enabled: boolean): BridgeState {
    db.prepare("UPDATE organization_settings SET falatu_bridge_tasks_enabled = ? WHERE organization_id = ?").run(enabled ? 1 : 0, orgId);
    return FalaTuService.bridgeState(orgId);
  }

  static setEventBridge(orgId: string, enabled: boolean): BridgeState {
    db.prepare("UPDATE organization_settings SET falatu_bridge_events_enabled = ? WHERE organization_id = ?").run(enabled ? 1 : 0, orgId);
    return FalaTuService.bridgeState(orgId);
  }

  static setListBridge(orgId: string, enabled: boolean): BridgeState {
    db.prepare("UPDATE organization_settings SET falatu_bridge_lists_enabled = ? WHERE organization_id = ?").run(enabled ? 1 : 0, orgId);
    return FalaTuService.bridgeState(orgId);
  }

  static bridgeState(orgId: string): BridgeState {
    return { tasks: FalaTuService.isTaskBridgeEnabled(orgId), events: FalaTuService.isEventBridgeEnabled(orgId), lists: FalaTuService.isListBridgeEnabled(orgId) };
  }

  static discard(orgId: string, userId: string, inboxItemId: string) {
    const r = db.prepare(`UPDATE falatu_inbox_items SET status = 'discarded', resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND status = 'pending'`)
      .run(userId, inboxItemId, orgId, userId);
    if (r.changes === 0) throw new Error("Item não encontrado ou já resolvido.");
    logAuthEvent(orgId, userId, null, "FALATU_DISCARD", { inboxItemId });
    return { success: true };
  }

  static tasks(orgId: string, userId: string): any[] {
    return db.prepare(`SELECT * FROM falatu_tasks WHERE organization_id = ? AND user_id = ? ORDER BY completed ASC, created_at DESC LIMIT 500`).all(orgId, userId);
  }

  static toggleTask(orgId: string, userId: string, taskId: string, completed: boolean) {
    const r = db.prepare(`UPDATE falatu_tasks SET completed = ?, completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ? AND organization_id = ? AND user_id = ?`)
      .run(completed ? 1 : 0, completed ? 1 : 0, taskId, orgId, userId);
    if (r.changes === 0) throw new Error("Tarefa não encontrada.");
    return db.prepare(`SELECT * FROM falatu_tasks WHERE id = ?`).get(taskId);
  }

  static events(orgId: string, userId: string): any[] {
    return db.prepare(`SELECT * FROM falatu_events WHERE organization_id = ? AND user_id = ? ORDER BY event_date IS NULL, event_date ASC, created_at DESC LIMIT 500`).all(orgId, userId);
  }

  static lists(orgId: string, userId: string): any[] {
    return db.prepare(`
      SELECT l.*,
        (SELECT COUNT(*) FROM falatu_list_items i WHERE i.list_id = l.id AND i.organization_id = l.organization_id) AS item_count,
        (SELECT COUNT(*) FROM falatu_list_items i WHERE i.list_id = l.id AND i.organization_id = l.organization_id AND i.realized = 1) AS realized_count
      FROM falatu_lists l
      WHERE l.organization_id = ? AND l.user_id = ? AND l.status = 'active'
      ORDER BY l.created_at DESC LIMIT 200
    `).all(orgId, userId);
  }

  static listItems(orgId: string, userId: string, listId: string): any[] {
    const list = db.prepare(`SELECT id FROM falatu_lists WHERE id = ? AND organization_id = ? AND user_id = ?`).get(listId, orgId, userId);
    if (!list) throw new Error("Lista não encontrada.");
    return db.prepare(`SELECT * FROM falatu_list_items WHERE organization_id = ? AND list_id = ? ORDER BY created_at ASC`).all(orgId, listId);
  }

  static toggleListItem(orgId: string, userId: string, itemId: string, realized: boolean) {
    // Dono validado na MESMA query (o IDOR da origem era exatamente o toggle sem dono).
    const r = db.prepare(`
      UPDATE falatu_list_items SET realized = ?
      WHERE id = ? AND organization_id = ?
        AND list_id IN (SELECT id FROM falatu_lists WHERE organization_id = ? AND user_id = ?)
    `).run(realized ? 1 : 0, itemId, orgId, orgId, userId);
    if (r.changes === 0) throw new Error("Item não encontrado.");
    return db.prepare(`SELECT * FROM falatu_list_items WHERE id = ?`).get(itemId);
  }

  static entities(orgId: string, userId: string): any[] {
    return db.prepare(`SELECT * FROM falatu_entities WHERE organization_id = ? AND user_id = ? ORDER BY entity_type ASC, name ASC LIMIT 500`).all(orgId, userId);
  }

  /** Briefing do dia: pendências + compromissos de hoje (e sem data) + listas ativas. */
  static briefing(orgId: string, userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      pendingInbox: db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ? AND status = 'pending'`).get(orgId, userId) as any,
      tasks: db.prepare(`SELECT * FROM falatu_tasks WHERE organization_id = ? AND user_id = ? AND completed = 0 ORDER BY created_at DESC LIMIT 50`).all(orgId, userId),
      todayEvents: db.prepare(`SELECT * FROM falatu_events WHERE organization_id = ? AND user_id = ? AND (event_date = ? OR event_date IS NULL) ORDER BY event_time ASC LIMIT 50`).all(orgId, userId, today),
      lists: FalaTuService.lists(orgId, userId),
    };
  }
}
