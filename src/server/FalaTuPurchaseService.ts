import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * FalaTu — compras com conferência (ADR-151 Fatia 4).
 *
 * O usuário planeja a compra numa lista do FalaTu, compra, fotografa a NOTA
 * FISCAL e a conferência cruza planejado × comprado. A leitura da nota reusa
 * `extractInvoiceItems` (ADR-021/030, disciplina "não invente item que não
 * está na nota" já testada); o MATCHING é DETERMINÍSTICO (normalização +
 * overlap de tokens, sem IA) — a IA lê a nota, o código sugere o pareamento,
 * o HUMANO confirma na tela de reconciliação.
 *
 * Guardrails RN-151 desta fatia:
 * - A conferência NUNCA marca item da lista sozinha: check() só registra a
 *   sugestão pendente; marcar `realized` é exclusivo do confirm() humano.
 * - Item EXTRA da nota (fora da lista) NUNCA entra na lista sem opt-in
 *   explícito (índices em `addExtras`) — comprou por impulso, o humano decide
 *   se vira item.
 * - confirm() relê DO BANCO a conferência pendente; o cliente só escolhe
 *   subconjuntos do que foi sugerido (ids/índices), nunca injeta item novo.
 * - Leitura da nota é SNAPSHOT (invoice_json): reprocessar a mesma foto pode
 *   dar outra leitura — o registro do que foi conferido não muda depois.
 *
 * Consumo: ler nota é ação de IA — mesmo gate da captura (PlanService.
 * aiAllowed + contagem no ai_interactions_log, agent 'falatu').
 * Nunca DELETE (convenção nº 9): discard é UPDATE de status.
 */

export interface InvoiceReading {
  supplierName: string | null;
  items: { name: string; quantity: number | null; unit: string | null; unitCost: number | null; confidence: number }[];
  confidence: number;
}

export interface PurchaseMatching {
  matched: { listItemId: string; listItemName: string; invoiceIndex: number; invoiceName: string; quantity: number | null; unit: string | null; unitCost: number | null; confidence: number }[];
  missing: { listItemId: string; name: string }[];
  extras: { invoiceIndex: number; name: string; quantity: number | null; unit: string | null; unitCost: number | null; confidence: number }[];
}

/** lower + sem acento + só [a-z0-9 ] — "Café Pilão 500g" → "cafe pilao 500g". */
function norm(s: string): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return norm(s).split(" ").filter((t) => t.length >= 2);
}

export class FalaTuPurchaseService {
  /**
   * Leitura da nota isolada num método próprio pra ser mockável em teste sem
   * chave OpenAI (mesmo padrão de FalaTuService.interpret). Normaliza o JSON
   * do modelo — item sem nome é descartado, número inválido vira null (nunca
   * um chute).
   */
  static async readInvoice(image: { mimeType: string; data: string }): Promise<InvoiceReading> {
    const llm = await import("./llm.js");
    if (!llm.isAIConfigured()) throw new Error("IA não configurada (OPENAI_API_KEY ausente).");
    const raw = await llm.extractInvoiceItems(image.data, image.mimeType || "image/jpeg");
    let parsed: any = {};
    try { parsed = JSON.parse(raw || "{}"); } catch { /* JSON malformado → leitura vazia, nunca 500 */ }
    const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const items = (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter((i: any) => typeof i?.name === "string" && i.name.trim())
      .map((i: any) => ({
        name: i.name.trim(),
        quantity: num(i.quantity),
        unit: typeof i.unit === "string" && i.unit.trim() ? i.unit.trim() : null,
        unitCost: num(i.unitCost),
        confidence: Math.max(0, Math.min(100, num(i.confidence) ?? 0)),
      }));
    return {
      supplierName: typeof parsed?.supplierName === "string" && parsed.supplierName.trim() ? parsed.supplierName.trim() : null,
      items,
      confidence: Math.max(0, Math.min(100, num(parsed?.confidence) ?? 0)),
    };
  }

  /**
   * Pareamento determinístico planejado × nota. Score = fração dos tokens do
   * item da LISTA presentes no nome da nota (token igual ou prefixo — "arroz"
   * casa "arroz branco tipo 1"). Guloso pelo melhor score ≥ 0.5; cada item da
   * nota casa com no máximo um item da lista. Exportado puro pra teste.
   */
  static matchItems(
    listItems: { id: string; name: string }[],
    invoiceItems: InvoiceReading["items"]
  ): PurchaseMatching {
    const candidates: { li: number; inv: number; score: number; hits: number }[] = [];
    listItems.forEach((li, liIdx) => {
      const lt = tokens(li.name);
      if (!lt.length) return;
      invoiceItems.forEach((inv, invIdx) => {
        const it = tokens(inv.name);
        const hits = lt.filter((t) => it.some((x) => x === t || x.startsWith(t) || t.startsWith(x))).length;
        const score = hits / lt.length;
        if (score >= 0.5) candidates.push({ li: liIdx, inv: invIdx, score, hits });
      });
    });
    // Empate de score → mais tokens casados primeiro: "leite condensado" (2
    // hits) pareia antes de "leite" (1 hit) roubar a linha do condensado.
    candidates.sort((a, b) => b.score - a.score || b.hits - a.hits);
    const usedLi = new Set<number>();
    const usedInv = new Set<number>();
    const matched: PurchaseMatching["matched"] = [];
    for (const c of candidates) {
      if (usedLi.has(c.li) || usedInv.has(c.inv)) continue;
      usedLi.add(c.li); usedInv.add(c.inv);
      const li = listItems[c.li];
      const inv = invoiceItems[c.inv];
      matched.push({ listItemId: li.id, listItemName: li.name, invoiceIndex: c.inv, invoiceName: inv.name, quantity: inv.quantity, unit: inv.unit, unitCost: inv.unitCost, confidence: inv.confidence });
    }
    return {
      matched,
      missing: listItems.filter((_, i) => !usedLi.has(i)).map((li) => ({ listItemId: li.id, name: li.name })),
      extras: invoiceItems.map((inv, i) => ({ invoiceIndex: i, name: inv.name, quantity: inv.quantity, unit: inv.unit, unitCost: inv.unitCost, confidence: inv.confidence })).filter((x) => !usedInv.has(x.invoiceIndex)),
    };
  }

  /** Lê a nota, cruza com os itens AINDA NÃO comprados da lista e registra a conferência PENDENTE. */
  static async check(orgId: string, userId: string, listId: string, image: { mimeType: string; data: string }) {
    const list = db.prepare(`SELECT * FROM falatu_lists WHERE id = ? AND organization_id = ? AND user_id = ? AND status = 'active'`).get(listId, orgId, userId) as any;
    if (!list) throw new Error("Lista não encontrada.");

    // Mesmo gate de plano da captura (ler nota consome IA).
    const { PlanService } = await import("./PlanService.js");
    const gate = PlanService.aiAllowed(orgId);
    if (!gate.allowed) {
      if (gate.reason === "monthly_limit") throw new Error("Limite mensal de ações de IA do plano atingido. Compre um pacote extra ou aguarde a virada do mês.");
      throw new Error("Conta bloqueada ou cobrança pendente — leitura de nota indisponível.");
    }

    const invoice = await FalaTuPurchaseService.readInvoice(image);
    if (!invoice.items.length) throw new Error("Não consegui ler itens nesta foto. Tente uma foto mais nítida da nota.");

    // Confere só o que ainda está pendente na lista — o já comprado não re-casa.
    const pendingItems = db.prepare(`SELECT id, name FROM falatu_list_items WHERE organization_id = ? AND list_id = ? AND realized = 0 ORDER BY created_at ASC`).all(orgId, listId) as any[];
    const matching = FalaTuPurchaseService.matchItems(pendingItems, invoice.items);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO falatu_purchase_checks (id, organization_id, user_id, list_id, supplier_name, invoice_json, matching_json, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, orgId, userId, listId, invoice.supplierName, JSON.stringify(invoice), JSON.stringify(matching), invoice.confidence);

    try {
      db.prepare(`INSERT INTO ai_interactions_log (id, organization_id, agent_used, input_prompt, output_response, confidence) VALUES (?, ?, 'falatu', ?, ?, ?)`)
        .run(randomUUID(), orgId, `[nota fiscal] lista ${list.title}`.slice(0, 500), `${invoice.items.length} itens lidos`, invoice.confidence / 100);
    } catch { /* noop */ }
    logAuthEvent(orgId, userId, null, "FALATU_PURCHASE_CHECK", { checkId: id, listId, invoiceItems: invoice.items.length, matched: matching.matched.length, extras: matching.extras.length, confidence: invoice.confidence });
    return FalaTuPurchaseService.get(orgId, userId, id);
  }

  static get(orgId: string, userId: string, id: string): any {
    return db.prepare(`SELECT * FROM falatu_purchase_checks WHERE id = ? AND organization_id = ? AND user_id = ?`).get(id, orgId, userId) || null;
  }

  /** Conferência pendente mais recente da lista (pra UI restaurar ao reabrir). */
  static latestForList(orgId: string, userId: string, listId: string): any {
    return db.prepare(`
      SELECT * FROM falatu_purchase_checks
      WHERE organization_id = ? AND user_id = ? AND list_id = ? AND status = 'pending'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(orgId, userId, listId) || null;
  }

  /**
   * Confirmação humana da reconciliação. `listItemIds` escolhe QUAIS pareados
   * marcar como comprados (default: todos os sugeridos); `addExtras` são os
   * ÍNDICES (invoiceIndex) dos extras que o humano quer puxar pra lista — sem
   * opt-in, extra nenhum entra (RN-151). Tudo relido do banco.
   */
  static confirm(orgId: string, userId: string, checkId: string, opts: { listItemIds?: string[]; addExtras?: number[] } = {}) {
    const check = FalaTuPurchaseService.get(orgId, userId, checkId);
    if (!check) throw new Error("Conferência não encontrada.");
    if (check.status !== "pending") throw new Error("Conferência já resolvida.");

    let matching: PurchaseMatching;
    try { matching = JSON.parse(check.matching_json || "{}"); } catch { matching = { matched: [], missing: [], extras: [] }; }

    const wanted = Array.isArray(opts.listItemIds) ? new Set(opts.listItemIds) : null;
    const toRealize = (matching.matched || []).filter((m) => !wanted || wanted.has(m.listItemId));
    const extraIdx = new Set(Array.isArray(opts.addExtras) ? opts.addExtras.map(Number) : []);
    const toAdd = (matching.extras || []).filter((x) => extraIdx.has(Number(x.invoiceIndex)));

    const result = db.transaction(() => {
      // Marca comprado só o que foi pareado E escolhido — dono validado na query.
      const upd = db.prepare(`UPDATE falatu_list_items SET realized = 1 WHERE id = ? AND organization_id = ? AND list_id = ?`);
      let realized = 0;
      for (const m of toRealize) realized += upd.run(m.listItemId, orgId, check.list_id).changes;

      // Extras opt-in entram já como comprados (vieram da nota), com quantidade.
      const ins = db.prepare(`INSERT INTO falatu_list_items (id, organization_id, list_id, name, quantity, planned, realized) VALUES (?, ?, ?, ?, ?, 0, 1)`);
      for (const x of toAdd) ins.run(randomUUID(), orgId, check.list_id, x.name, x.quantity != null ? `${x.quantity}${x.unit ? ` ${x.unit}` : ""}` : null);

      db.prepare(`UPDATE falatu_purchase_checks SET status = 'confirmed', resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?`).run(userId, check.id);
      return { realized, added: toAdd.length };
    })();

    logAuthEvent(orgId, userId, null, "FALATU_PURCHASE_CONFIRM", { checkId: check.id, listId: check.list_id, realized: result.realized, addedExtras: result.added });
    return { success: true, ...result, check: FalaTuPurchaseService.get(orgId, userId, checkId) };
  }

  static discard(orgId: string, userId: string, checkId: string) {
    const r = db.prepare(`UPDATE falatu_purchase_checks SET status = 'discarded', resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND status = 'pending'`)
      .run(userId, checkId, orgId, userId);
    if (r.changes === 0) throw new Error("Conferência não encontrada ou já resolvida.");
    logAuthEvent(orgId, userId, null, "FALATU_PURCHASE_DISCARD", { checkId });
    return { success: true };
  }
}

export default FalaTuPurchaseService;
