import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

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
 * Fase 1: rotas montadas atrás de requireMasterAdmin (operador da plataforma).
 * Mesmo assim TODA query filtra organization_id + user_id (convenção nº 1) —
 * o rollout multi-tenant (Fatia 2) troca só o gate.
 * Nunca DELETE (convenção nº 9): discard é UPDATE de status.
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
}

const INTENTS: FalaTuIntent[] = ["TASK", "EVENT", "LIST", "NOTE", "UNKNOWN"];

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

export class FalaTuService {
  /**
   * Chamada de IA isolada num método estático próprio pra ser mockável em
   * teste sem chave OpenAI (mesmo padrão de TaskAudioService.extractTaskFromText).
   */
  static async interpret(input: FalaTuCaptureInput): Promise<FalaTuExtraction> {
    const llm = await import("./llm.js");
    if (!llm.isAIConfigured()) throw new Error("IA não configurada (OPENAI_API_KEY ausente).");

    let raw = "";
    if (input.image?.data) {
      raw = await llm.extractStructuredFromImage(
        input.image.data,
        input.image.mimeType || "image/jpeg",
        EXTRACTION_SYSTEM,
        input.text?.trim() || "Extraia os dados pedidos desta imagem e devolva SOMENTE o JSON."
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
      raw = await llm.chat(text, { json: true, temperature: 0.2, system: EXTRACTION_SYSTEM });
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
    const extraction = await FalaTuService.interpret(input);
    const id = randomUUID();
    const mediaType = input.image?.data ? "image" : input.audio?.data ? "audio" : null;
    db.prepare(`
      INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, media_type, transcription, summary, intent, entities_json, suggested_action, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, orgId, userId, input.source === "whatsapp" ? "whatsapp" : "webapp",
      input.text?.trim() || null, mediaType,
      extraction.transcription || null, extraction.summary || null, extraction.intent,
      JSON.stringify(extraction.entities), extraction.suggestedAction || null, extraction.confidence
    );
    logAuthEvent(orgId, userId, null, "FALATU_CAPTURE", { inboxItemId: id, intent: extraction.intent, mediaType, confidence: extraction.confidence });
    return FalaTuService.getInboxItem(orgId, userId, id);
  }

  static getInboxItem(orgId: string, userId: string, id: string): any {
    return db.prepare(`SELECT * FROM falatu_inbox_items WHERE id = ? AND organization_id = ? AND user_id = ?`).get(id, orgId, userId);
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
    overrides: { intent?: string; title?: string; eventDate?: string | null; eventTime?: string | null; listItems?: string[]; listType?: string } = {}
  ) {
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

    const result = db.transaction(() => {
      let confirmedKind: string | null = null;
      let refId: string | null = null;

      if (intent === "TASK") {
        refId = randomUUID();
        db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, description, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(refId, orgId, userId, title, item.transcription || item.content || null, item.id);
        confirmedKind = "task";
      } else if (intent === "EVENT") {
        refId = randomUUID();
        db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time, inbox_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(refId, orgId, userId, title, eventDate, eventTime, item.id);
        confirmedKind = "event";
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
      for (const p of (Array.isArray(entities?.people) ? entities.people : [])) {
        upsert.run(randomUUID(), orgId, userId, "PERSON", p, p.trim().toLowerCase(), item.summary || null);
      }
      for (const p of (Array.isArray(entities?.projects) ? entities.projects : [])) {
        upsert.run(randomUUID(), orgId, userId, "PROJECT", p, p.trim().toLowerCase(), item.summary || null);
      }

      db.prepare(`UPDATE falatu_inbox_items SET status = 'confirmed', confirmed_kind = ?, confirmed_ref_id = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`)
        .run(confirmedKind, refId, userId, item.id);
      return { confirmedKind, refId };
    })();

    logAuthEvent(orgId, userId, null, "FALATU_CONFIRM", { inboxItemId: item.id, kind: result.confirmedKind, refId: result.refId });
    return { success: true, kind: result.confirmedKind, refId: result.refId, item: FalaTuService.getInboxItem(orgId, userId, inboxItemId) };
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
