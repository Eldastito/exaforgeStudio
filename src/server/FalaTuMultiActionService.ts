import { randomUUID } from "crypto";
import { FalaTuAskService } from "./FalaTuAskService.js";
import { FalatuRecordService } from "./FalatuRecordService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * FalaTuMultiActionService — "UMA frase → N ações → UMA confirmação" (ADR-204 F3.6a, PRD Fase 3 §17).
 *
 * "cadastra o cliente João e marca reunião com ele amanhã às 10h; anota ligar pro contador" é 3 pedidos numa frase. Sem isto, o
 * FalaTu entendia UM (o primeiro verbo) e engolia o resto. Aqui a frase é DIVIDIDA, o dono vê a LISTA do que vai ser preparado
 * (cada item pode ser removido) e confirma UMA vez.
 *
 * NÃO é orquestrador novo e NÃO é caminho de escrita novo (ADR-204 F3.6 — "sem orquestrador novo"):
 *  - a divisão REUSA `FalaTuAskService.classify` — a mesma regra de intenção de sempre: um pedaço só conta como ação se o
 *    classificador existente o reconhece como registro (despesa/venda/cliente/recebível/compromisso/anotação). Não há vocabulário
 *    novo. Pedaço que não é ação ("leite" em "anota comprar pão e leite") é COLADO no anterior, não vira ação;
 *  - confirmar executa cada item pelo MESMO `FalaTuAskService.converse` (com `noMulti`): cada item cai no pipeline de sempre —
 *    proposta GOVERNADA (`DecisionAction → ApprovalPolicy → CommandExecutor`, onde a política decide se pede aprovação humana,
 *    com o piso de F3.1) ou captura PENDENTE no Inbox. A confirmação ÚNICA é do PREPARO; ela NÃO aprova nada no lugar de ninguém.
 *
 * REGRAS:
 *  - 0-regressão: frase com UMA ação, pergunta, ou mistura pergunta+ação segue exatamente o caminho anterior (`detect` → null).
 *  - Pré-visualização SEM escrita: `detect` só descreve; nada é criado até `confirm`.
 *  - Dinheiro role-gated (§73): item de dinheiro para quem não vê dinheiro aparece `blocked` (e o `converse` barra de novo).
 *  - Honesto: item que o motor não consegue preparar (faltou valor/nome/data, cliente não achado) volta com o motivo — nunca
 *    "fingimos" que fez. O resumo diz quantas ficaram aguardando aprovação, quantas no Inbox e quantas não deu.
 *  - Limite de 6 ações por frase; o plano vive em MEMÓRIA do processo (15 min, por empresa+usuário — LGPD, sem texto em banco);
 *    reiniciar o servidor ou passar o prazo "esquece" e o FalaTu pede pra repetir. Confirmar 2× devolve o mesmo resultado (idempotente).
 *  - Auditoria sem o texto do dono: só quantidade e tipos.
 */
export const MULTI_MAX_ACTIONS = 6;
export const MULTI_PLAN_TTL_MS = 15 * 60_000;
/** Depois de confirmar, o item que ESPERA a aprovação de um cadastro pode ser retomado por até 2 h ("Tentar agora"). */
export const MULTI_WAIT_TTL_MS = 2 * 60 * 60_000;

const ACTION_KINDS = new Set(["record", "record_expense", "record_sale", "record_contact", "record_receivable", "record_appointment"]);
const MONEY_KINDS = new Set(["record_expense", "record_sale", "record_receivable"]);
const LABEL: Record<string, string> = { record: "Anotação (vai pro Inbox pra você confirmar)", record_expense: "Despesa (vai pra Aprovações)", record_sale: "Venda (vai pra Aprovações)", record_contact: "Cadastro de cliente (vai pra Aprovações)", record_receivable: "Recebível (vai pra Aprovações)", record_appointment: "Compromisso (vai pra Aprovações)" };
const SHORT: Record<string, string> = { record: "anotação", record_expense: "despesa", record_sale: "venda", record_contact: "cliente", record_receivable: "recebível", record_appointment: "compromisso" };

// Fronteiras candidatas entre pedidos: ponto-e-vírgula, "e (depois|também)", "depois", "também" e vírgula — NUNCA vírgula entre
// dígitos (R$ 1,50 / 1.234,56). Só viram corte se os DOIS lados são ação.
const BOUNDARY_RE = /\s*(?:;|,?\s+e\s+(?:depois\s+|tamb[eé]m\s+)?|,?\s+depois\s+|,?\s+tamb[eé]m\s+|(?<!\d),\s*(?!\d))\s*/gi;

/** `dependsOn`: este compromisso é com um cliente que um item ANTERIOR da mesma frase ainda vai cadastrar (só proposto → precisa de aprovação). */
export interface MultiItem { id: string; text: string; kind: string; label: string; blocked: string | null; dependsOn?: string | null; dependsName?: string | null; resolvedText?: string }
interface StoredPlan { orgId: string; userId: string; items: MultiItem[]; createdAt: number; contextStoreId: string | null; source: string | undefined; result: any | null; waitUntil: number | null }
const plans = new Map<string, StoredPlan>();
const uidOf = (u: any) => String(u?.userId || u?.id || "");

export class FalaTuMultiActionService {
  /** Divide a frase em pedidos. Devolve [] quando NÃO é multi-ação (0-regressão). Puro: sem DB. */
  static split(text: string, today: string): string[] {
    const t = String(text || "").trim();
    if (t.length < 8) return [];
    const isAction = (s: string) => ACTION_KINDS.has(FalaTuAskService.classify(s.trim(), today).kind);
    // pedaços com as posições no texto ORIGINAL — a cola reaproveita o trecho original (nunca recompõe, nunca altera valores)
    const spans: Array<{ a: number; b: number }> = []; let last = 0;
    for (const m of t.matchAll(BOUNDARY_RE)) {
      if (m.index == null || m.index === 0 || m[0].length === 0) continue;
      spans.push({ a: last, b: m.index }); last = m.index + m[0].length;
    }
    spans.push({ a: last, b: t.length });
    const parts = spans.map((sp) => ({ ...sp, s: t.slice(sp.a, sp.b).trim() })).filter((p) => p.s);
    if (parts.length < 2 || !isAction(parts[0].s)) return [];
    // pedaço que NÃO é ação é cola do anterior ("comprar pão" + "leite"), não uma ação nova
    const groups: Array<{ a: number; b: number }> = [{ a: parts[0].a, b: parts[0].b }];
    for (const p of parts.slice(1)) {
      if (isAction(p.s)) groups.push({ a: p.a, b: p.b });
      else groups[groups.length - 1].b = p.b;
    }
    const merged = groups.map((g) => t.slice(g.a, g.b).trim());
    // a cola pode ter quebrado a classificação do anterior (ex.: virou pergunta): todos precisam seguir sendo ação
    if (merged.length < 2 || !merged.every(isAction)) return [];
    return merged;
  }

  /** Pré-visualização: se a frase tem ≥2 ações, guarda o plano (SEM escrever nada) e devolve o cartão. Senão null. */
  static detect(orgId: string, user: any, text: string, opts: { today: string; contextStoreId?: string | null; source?: string; now?: number }): { answer: string; data: any } | null {
    const clauses = this.split(text, opts.today);
    if (clauses.length < 2) return null;
    const uid = uidOf(user); if (!uid) return null;
    const now = opts.now ?? Date.now();
    this.sweep(now);
    if (clauses.length > MULTI_MAX_ACTIONS) {
      return { answer: `Vi ${clauses.length} pedidos numa frase só. Para eu não errar, mande até ${MULTI_MAX_ACTIONS} de cada vez.`, data: { multiPlan: null, tooMany: clauses.length } };
    }
    const canMoney = FalaTuAskService.canSeeMoney(orgId, user);
    const items: MultiItem[] = clauses.map((c, i) => {
      const kind = FalaTuAskService.classify(c, opts.today).kind;
      return { id: `a${i + 1}`, text: c, kind, label: LABEL[kind] || kind, blocked: MONEY_KINDS.has(kind) && !canMoney ? "Restrito ao dono, sócios, administradores e gerentes." : null };
    });
    this.linkDependencies(items);
    const planId = randomUUID();
    plans.set(planId, { orgId, userId: uid, items, createdAt: now, contextStoreId: opts.contextStoreId ?? null, source: opts.source, result: null, waitUntil: null });
    const lines = items.map((it, i) => `${i + 1}. ${it.text} — ${it.blocked ? `🔒 ${it.blocked}` : it.label}`);
    return {
      answer: `Entendi ${items.length} pedidos numa frase:\n${lines.join("\n")}\n\nConfirme UMA vez para eu preparar (você pode tirar algum antes). Nada é gravado ainda, e o que precisa de aprovação continua dependendo dela.`,
      data: { multiPlan: { planId, expiresAt: new Date(now + MULTI_PLAN_TTL_MS).toISOString(), items: items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, label: i.label, blocked: i.blocked, dependsOn: i.dependsOn ?? null, dependsName: i.dependsName ?? null })) } },
    };
  }

  /** Confirma UMA vez: prepara cada item mantido pelo caminho de sempre. `keep` = ids mantidos (default: todos os não bloqueados). */
  static async confirm(orgId: string, user: any, planId: string, keep?: string[] | null, opts: { now?: Date } = {}): Promise<{ ok: boolean; error?: string; summary?: string; results?: any[]; alreadyConfirmed?: boolean }> {
    const uid = uidOf(user);
    const plan = plans.get(String(planId));
    const now = (opts.now || new Date()).getTime();
    if (!plan || plan.orgId !== orgId || plan.userId !== uid) return { ok: false, error: "Esse plano não existe mais (ou não é seu). Mande a frase de novo." };
    if (plan.result) return { ok: true, alreadyConfirmed: true, ...plan.result };
    if (now - plan.createdAt > MULTI_PLAN_TTL_MS) { plans.delete(planId); return { ok: false, error: "O plano expirou (15 min). Mande a frase de novo." }; }
    const wanted = keep == null ? plan.items.filter((i) => !i.blocked).map((i) => i.id) : [...new Set(keep.map(String))];
    const known = new Set(plan.items.map((i) => i.id));
    const bad = wanted.filter((k) => !known.has(k));
    if (bad.length) return { ok: false, error: `Item(ns) fora do plano: ${bad.join(", ")}.` };
    if (!wanted.length) return { ok: false, error: "Deixe pelo menos uma ação marcada (ou cancele o plano)." };

    const results: any[] = [];
    const byId = new Map<string, any>();
    for (const it of plan.items) {
      let r: any;
      if (!wanted.includes(it.id)) r = { id: it.id, text: it.text, outcome: "removed" };
      else if (it.blocked) r = { id: it.id, text: it.text, outcome: "blocked", message: it.blocked };
      else {
        // O cliente que um item ANTERIOR ainda vai cadastrar só existe depois de aprovado: este item ESPERA (não finge que fez).
        const dep = it.dependsOn ? byId.get(it.dependsOn) : null;
        if (dep && (dep.outcome === "awaiting_approval" || dep.outcome === "prepared")) {
          r = { id: it.id, text: it.text, outcome: "waiting", dependsOn: it.dependsOn, message: `Depende do cadastro de ${it.dependsName}: aprove o cadastro em Aprovações e use "Tentar agora".` };
        } else r = await this.runItem(orgId, user, it, plan, opts.now);
      }
      results.push(r); byId.set(it.id, r);
    }
    const summary = this.summarize(results);
    plan.result = { summary, results };
    if (results.some((r) => r.outcome === "waiting")) plan.waitUntil = now + MULTI_WAIT_TTL_MS;
    try { logAuthEvent(orgId, uid, null, "FALATU_MULTI_CONFIRMED", { items: plan.items.length, kept: wanted.length, outcomes: results.map((r) => r.outcome), kinds: plan.items.map((i) => SHORT[i.kind] || i.kind) }); } catch { /* best-effort */ }
    return { ok: true, summary, results };
  }

  /** Prepara UM item pelo caminho de sempre (`converse` com `noMulti`). Nunca lança. */
  private static async runItem(orgId: string, user: any, it: MultiItem, plan: StoredPlan, now?: Date): Promise<any> {
    try {
      const r: any = await FalaTuAskService.converse(orgId, user, it.resolvedText || it.text, { now, source: plan.source, contextStoreId: plan.contextStoreId, noMulti: true } as any);
      const awaiting = !!r?.data?.awaitingApproval, pending = !!r?.data?.pendingId;
      const outcome = r?.moneyRestricted ? "blocked" : awaiting ? "awaiting_approval" : pending ? "inbox" : r?.data?.actionId ? "prepared" : "not_prepared";
      return { id: it.id, text: it.text, outcome, message: r?.answer || null, actionId: r?.data?.actionId || null, pendingId: r?.data?.pendingId || null };
    } catch (e: any) { return { id: it.id, text: it.text, outcome: "error", message: String(e?.message || "falhou") }; }
  }

  private static summarize(results: any[]): string {
    const n = (o: string) => results.filter((r) => r.outcome === o).length;
    const done = n("awaiting_approval") + n("prepared"), inbox = n("inbox"), waiting = n("waiting"), notDone = n("not_prepared") + n("blocked") + n("error"), removed = n("removed");
    const parts = [done ? `${done} preparada(s) (aguardando sua aprovação em *Aprovações* quando a política exige)` : null, inbox ? `${inbox} anotada(s) no Inbox pra você confirmar` : null, waiting ? `${waiting} esperando o cadastro ser aprovado (use "Tentar agora" depois)` : null, notDone ? `${notDone} NÃO preparada(s) — veja o motivo em cada uma` : null, removed ? `${removed} removida(s) por você` : null].filter(Boolean);
    return parts.length ? `Pronto: ${parts.join("; ")}.` : "Nada foi preparado.";
  }

  /**
   * "Tentar agora": retoma os itens que ESPERAVAM o cadastro. Roda de novo só os ainda em espera, pelo mesmo caminho de sempre —
   * se o cliente já existe (cadastro aprovado e executado) o compromisso é preparado; se não, continua esperando, com o motivo.
   * Idempotente: item já resolvido não roda de novo. Vale por 2 h depois da confirmação.
   */
  static async continueWaiting(orgId: string, user: any, planId: string, opts: { now?: Date } = {}): Promise<{ ok: boolean; error?: string; summary?: string; results?: any[]; stillWaiting?: number }> {
    const plan = plans.get(String(planId));
    const now = (opts.now || new Date()).getTime();
    if (!plan || plan.orgId !== orgId || plan.userId !== uidOf(user) || !plan.result) return { ok: false, error: "Não há itens esperando neste plano." };
    if (!plan.result.results.some((r: any) => r.outcome === "waiting")) return { ok: false, error: "Nada está esperando neste plano." };
    if (!plan.waitUntil || now > plan.waitUntil) return { ok: false, error: "O prazo para retomar esses itens passou (2 h). Mande a frase de novo." };
    const results: any[] = plan.result.results;
    for (let i = 0; i < results.length; i++) {
      if (results[i].outcome !== "waiting") continue;
      const it = plan.items.find((x) => x.id === results[i].id)!;
      const r = await this.runItem(orgId, user, it, plan, opts.now);
      // o cliente ainda não existe (cadastro não aprovado/executado): segue esperando, sem criar nada
      const stillMissing = r.outcome === "not_prepared" && /N[ãa]o achei o cliente/i.test(String(r.message || ""));
      results[i] = stillMissing ? { ...results[i], message: `O cadastro de ${it.dependsName} ainda não foi aprovado. Aprove em Aprovações e tente de novo.` } : r;
    }
    const stillWaiting = results.filter((r) => r.outcome === "waiting").length;
    plan.result = { summary: this.summarize(results), results };
    if (!stillWaiting) plan.waitUntil = null;
    try { logAuthEvent(orgId, uidOf(user), null, "FALATU_MULTI_CONTINUED", { waitingBefore: results.length, stillWaiting }); } catch { /* best-effort */ }
    return { ok: true, summary: plan.result.summary, results, stillWaiting };
  }

  /**
   * Liga o compromisso ao cadastro anterior da MESMA frase: (a) o compromisso cita o nome cadastrado ("…com João Silva…") ou (b) diz
   * "com ele/ela" e há UM só cadastro antes (ambíguo → não adivinha). O pronome é trocado pelo nome só na hora de preparar.
   */
  private static linkDependencies(items: MultiItem[]): void {
    const L = "A-Za-zÀ-ú";
    const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const contacts = items.map((it, idx) => ({ it, idx, name: it.kind === "record_contact" ? FalatuRecordService.parseContact(it.text).name : null })).filter((c) => c.name);
    for (const [idx, it] of items.entries()) {
      if (it.kind !== "record_appointment") continue;
      const before = contacts.filter((c) => c.idx < idx);
      let dep = before.filter((c) => norm(it.text).includes(norm(c.name!))).pop();
      const pron = new RegExp(`(?<![${L}])com\\s+(?:ele|ela)(?![${L}])`, "i");
      if (!dep && pron.test(it.text) && before.length === 1) { dep = before[0]; it.resolvedText = it.text.replace(pron, `com ${dep.name}`); }
      if (!dep) continue;
      it.dependsOn = dep.it.id; it.dependsName = dep.name;
      it.label = `Compromisso — espera o cadastro de ${dep.name} ser aprovado`;
    }
  }

  /** Cancela o plano (nada foi escrito, então só descarta). */
  static cancel(orgId: string, user: any, planId: string): boolean {
    const p = plans.get(String(planId));
    if (!p || p.orgId !== orgId || p.userId !== uidOf(user) || p.result) return false;
    plans.delete(String(planId)); return true;
  }

  private static sweep(now: number): void { for (const [k, p] of plans) if (p.waitUntil ? now > p.waitUntil : now - p.createdAt > MULTI_PLAN_TTL_MS * 2) plans.delete(k); }
  static reset(): void { plans.clear(); }
}

export default FalaTuMultiActionService;
