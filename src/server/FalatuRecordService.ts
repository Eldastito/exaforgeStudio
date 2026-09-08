/**
 * FalatuRecordService — PORTA de REGISTRO de negócio ditado no Fala Tu (opção a
 * da frente "conversar com o negócio"). O dono fala "lança a despesa de R$200
 * com o fornecedor Padaria" e isso NÃO escreve direto: vira um COMANDO GOVERNADO
 * (`DecisionAction → ApprovalPolicy → CommandExecutor`) que nasce
 * `awaiting_approval` — só grava depois da aprovação humana (D4/RN-159-1: dinheiro
 * é conservador). Reúso puro (§184 — sem runtime/policy paralelo): compõe os
 * engines canônicos, espelhando `GovernedPublishService`.
 *
 * F5 = DESPESA (payables). Venda e cliente vêm nas fatias seguintes, na mesma
 * porta. O parser é DETERMINÍSTICO (regex, 0 IA → roda em CI) e NUNCA inventa: se
 * não achar o valor, não propõe nada (pede o valor).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { BusinessTimeService } from "./BusinessTimeService.js";
import { extractDate } from "./FalaTuAskService.js";
// Importa o handler pelo efeito colateral de REGISTRO no executor.
import "./FalatuRecordCommandHandler.js";

export interface ParsedExpense {
  amount: number | null;
  supplierName: string | null;
  description: string;
  dueDate: string; // YYYY-MM-DD
}

// Valor em BRL a partir da fala. pt-BR: '.' milhar, ',' decimal; tolera "R$",
// "1.500", "1500,50", "200". Retorna null quando não há valor (não inventa).
export function parseAmountBRL(text: string): number | null {
  const t = String(text || "");
  const m = t.match(/r\$\s*([\d.,]+)/i) || t.match(/\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2}|\d+(?:\.\d{1,2})?|\d+)\b/);
  if (!m) return null;
  let s = m[1];
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", "."); // 1.500,50 → 1500.50
  } else if (s.includes(".")) {
    // Só pontos: milhar (1.500 → 1500) quando o padrão é grupos de 3; senão decimal (1.50).
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const v = parseFloat(s);
  return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

// Nome do fornecedor, best-effort. Prioriza "fornecedor X"; senão pega o nome
// próprio depois de com/pra/para/do/da. Nunca inventa: sem match → null.
function parseSupplier(text: string): string | null {
  const t = String(text || "");
  let m = t.match(/fornecedor\s+(?:o\s+|a\s+)?([A-Za-zÀ-ú][A-Za-zÀ-ú0-9&.\- ]{1,38})/i);
  if (!m) m = t.match(/\b(?:com|pra|para|do|da)\s+(?:o\s+|a\s+)?([A-ZÀ-Ú][A-Za-zÀ-ú0-9&.\-]{1,38}(?:\s+[A-ZÀ-Ú][A-Za-zÀ-ú0-9&.\-]{1,38})?)/);
  if (!m) return null;
  // Corta em conectivos/valor que porventura tenham entrado na captura.
  let s = m[1].replace(/\s+(de|no valor|por|r\$).*$/i, "").trim();
  return s.length >= 2 ? s.slice(0, 40) : null;
}

const LEAD_VERB_RE = /^(?:grava|gravar|anota|anotar|registra|registrar|lan[çc]a|lan[çc]ar|paguei|pagar|pago)\b[:,]?\s*/i;
// F6 (venda) — verbo/expressão de VENDA no início, pra tirar do texto que vira a
// nota do lançamento.
const SALE_LEAD_RE = /^(?:registra(?:r)?|lan[çc]a(?:r)?|anota(?:r)?|grava(?:r)?)?\s*(?:a\s+|uma\s+)?(?:venda|vendi|vendeu|faturei)\b[:,]?\s*/i;

export interface ParsedSale {
  amount: number | null;
  note: string;
  eventDate: string; // YYYY-MM-DD
}

export interface ParsedContact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface ParsedAppointment {
  contactName: string | null;
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
  title: string;
}

function pad2n(n: number): string { return String(n).padStart(2, "0"); }

// Horário na fala. Aceita "10h", "10h30", "10:30", "às 14", "14 horas". Sem
// marcador de hora explícito → null (não confunde "dia 5" com 5h).
function parseTime(text: string): string | null {
  const t = String(text || "");
  let m = t.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (m && +m[1] <= 23 && +m[2] <= 59) return `${pad2n(+m[1])}:${m[2]}`;
  m = t.match(/\b(\d{1,2})\s*h(?:oras?)?\b/i);
  if (m && +m[1] <= 23) return `${pad2n(+m[1])}:00`;
  m = t.match(/\b[àa]s\s+(\d{1,2})\b/i);
  if (m && +m[1] <= 23) return `${pad2n(+m[1])}:00`;
  return null;
}

export class FalatuRecordService {
  /** Parser determinístico da despesa ditada. `today` = data comercial da org. */
  static parseExpense(text: string, today: string): ParsedExpense {
    const t = String(text || "").trim();
    const amount = parseAmountBRL(t);
    const supplierName = parseSupplier(t);
    const dueDate = extractDate(t, today) || today;
    // Descrição = a própria fala do dono (sem o verbo de gravar), capada — fiel,
    // nunca inventada. Fallback só se sobrar vazio.
    const description = t.replace(LEAD_VERB_RE, "").trim().slice(0, 160) || "Despesa (Fala Tu)";
    return { amount, supplierName, description, dueDate };
  }

  /**
   * Propõe a DESPESA como comando governado. Semeia a `agent_policy` de execução
   * (execute/approved_execution) — NÃO amplia autonomia: só deixa o executor
   * PERMITIR o efeito que a aprovação humana já liberou (mesma lógica do
   * `GovernedPublishService`/`dispatchGoverned`). A ação nasce `awaiting_approval`
   * (finance + fora da matriz = política 'single'). NÃO executa aqui.
   */
  static proposeExpense(orgId: string, parsed: ParsedExpense, opts: { createdBy?: string; correlationId?: string | null } = {}): any {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'finance' AND action_type = 'falatu_record_expense'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'finance', 'falatu_record_expense', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }
    return DecisionActionService.propose(orgId, {
      domain: "finance",
      actionType: "falatu_record_expense",
      title: `Lançar despesa${parsed.supplierName ? ` — ${parsed.supplierName}` : ""}`,
      description: parsed.description,
      expectedImpact: parsed.amount != null ? -Math.abs(parsed.amount) : null, // dinheiro que SAI
      impactUnit: "BRL",
      basis: "fact",
      commandType: "falatu_record_expense",
      commandPayload: { amount: parsed.amount, supplierName: parsed.supplierName, description: parsed.description, dueDate: parsed.dueDate },
      correlationId: opts.correlationId ?? null,
      createdBy: opts.createdBy || "falatu",
    });
  }

  /**
   * Ponto de entrada conversacional: recebe a fala de despesa, parseia e propõe.
   * Retorna { proposed:false } quando não achou valor (não inventa — pede o valor).
   */
  static recordExpense(orgId: string, user: any, text: string, opts: { now?: Date; correlationId?: string | null } = {}): { proposed: boolean; amount?: number | null; supplierName?: string | null; dueDate?: string; actionId?: string } {
    const today = BusinessTimeService.businessDate(orgId, opts.now || new Date());
    const parsed = this.parseExpense(text, today);
    if (parsed.amount == null) return { proposed: false };
    const action = this.proposeExpense(orgId, parsed, { createdBy: user?.userId || user?.id, correlationId: opts.correlationId ?? null });
    return { proposed: true, amount: parsed.amount, supplierName: parsed.supplierName, dueDate: parsed.dueDate, actionId: action?.id };
  }

  // ── F6: VENDA (entrada de caixa) ────────────────────────────────────────────
  /** Parser determinístico da venda ditada. Registra como dinheiro que ENTROU. */
  static parseSale(text: string, today: string): ParsedSale {
    const t = String(text || "").trim();
    const amount = parseAmountBRL(t);
    const eventDate = extractDate(t, today) || today;
    const note = t.replace(SALE_LEAD_RE, "").trim().slice(0, 160) || "Venda (Fala Tu)";
    return { amount, note, eventDate };
  }

  /**
   * Propõe a VENDA como comando governado (mesma mecânica da despesa — semeia a
   * política de execução, propõe awaiting_approval). O efeito é ENTRADA de caixa
   * (`recordEvent direction:'in'`), não conta a pagar. `expectedImpact` positivo
   * (dinheiro que entra).
   */
  static proposeSale(orgId: string, parsed: ParsedSale, opts: { createdBy?: string; correlationId?: string | null } = {}): any {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'finance' AND action_type = 'falatu_record_sale'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'finance', 'falatu_record_sale', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }
    return DecisionActionService.propose(orgId, {
      domain: "finance",
      actionType: "falatu_record_sale",
      title: "Registrar venda (entrada de caixa)",
      description: parsed.note,
      expectedImpact: parsed.amount != null ? Math.abs(parsed.amount) : null, // dinheiro que ENTRA
      impactUnit: "BRL",
      basis: "fact",
      commandType: "falatu_record_sale",
      commandPayload: { amount: parsed.amount, note: parsed.note, eventDate: parsed.eventDate },
      correlationId: opts.correlationId ?? null,
      createdBy: opts.createdBy || "falatu",
    });
  }

  static recordSale(orgId: string, user: any, text: string, opts: { now?: Date; correlationId?: string | null } = {}): { proposed: boolean; amount?: number | null; eventDate?: string; actionId?: string } {
    const today = BusinessTimeService.businessDate(orgId, opts.now || new Date());
    const parsed = this.parseSale(text, today);
    if (parsed.amount == null) return { proposed: false };
    const action = this.proposeSale(orgId, parsed, { createdBy: user?.userId || user?.id, correlationId: opts.correlationId ?? null });
    return { proposed: true, amount: parsed.amount, eventDate: parsed.eventDate, actionId: action?.id };
  }

  // ── F7: CLIENTE (contato) ────────────────────────────────────────────────────
  /** Parser determinístico do cliente ditado. Nome é obrigatório; tel/email best-effort. */
  static parseContact(text: string): ParsedContact {
    const t = String(text || "").trim();
    const m = t.match(/(?:cliente|contato)\s+(?:chamad[oa]\s+|de\s+nome\s+)?(.+)$/i);
    const rest = m ? m[1] : "";
    const email = (rest.match(/[^\s@]+@[^\s@]+\.[^\s@]+/) || [])[0] || null;
    const phoneRaw = (rest.match(/\+?\d[\d\s().-]{7,}\d/) || [])[0] || null;
    const phone = phoneRaw ? phoneRaw.replace(/[^\d+]/g, "") : null;
    let name: string | null = rest
      .replace(/\b(telefone|fone|tel|whatsapp|whats|zap|celular|n[uú]mero|email|e-?mail)\b.*$/i, "")
      .replace(/\+?\d[\d\s().-]{6,}\d/g, "")
      .replace(/[^\s@]+@[^\s@]+/g, "")
      .replace(/[,;:.\s]+$/, "")
      .trim();
    name = name ? name.slice(0, 80) : null;
    return { name, phone, email };
  }

  /**
   * Propõe o CADASTRO de cliente como comando governado. Domínio 'crm' (não é
   * financeiro → não é default-deny; nasce awaiting_approval pela política
   * 'single' de fallback). Semeia a policy de execução (não amplia autonomia).
   */
  static proposeContact(orgId: string, parsed: ParsedContact, opts: { createdBy?: string; correlationId?: string | null } = {}): any {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'crm' AND action_type = 'falatu_record_contact'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'crm', 'falatu_record_contact', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }
    return DecisionActionService.propose(orgId, {
      domain: "crm",
      actionType: "falatu_record_contact",
      title: `Cadastrar cliente${parsed.name ? ` — ${parsed.name}` : ""}`,
      description: [parsed.name, parsed.phone, parsed.email].filter(Boolean).join(" · ").slice(0, 160),
      commandType: "falatu_record_contact",
      commandPayload: { name: parsed.name, phone: parsed.phone, email: parsed.email },
      correlationId: opts.correlationId ?? null,
      createdBy: opts.createdBy || "falatu",
    });
  }

  static recordContact(orgId: string, user: any, text: string, opts: { correlationId?: string | null } = {}): { proposed: boolean; name?: string | null; phone?: string | null; email?: string | null; actionId?: string } {
    const parsed = this.parseContact(text);
    if (!parsed.name) return { proposed: false };
    const action = this.proposeContact(orgId, parsed, { createdBy: user?.userId || user?.id, correlationId: opts.correlationId ?? null });
    return { proposed: true, name: parsed.name, phone: parsed.phone, email: parsed.email, actionId: action?.id };
  }

  // ── F11: COMPROMISSO com cliente ──────────────────────────────────────────
  /** Parser determinístico do compromisso ditado. Nada é inventado. */
  static parseAppointment(text: string, today: string): ParsedAppointment {
    const t = String(text || "").trim();
    const date = extractDate(t, today);
    const time = parseTime(t);
    const nm = t.match(/\b(reuni[aã]o|compromisso|consulta|atendimento|visita|call|encontro)\b/i);
    const title = nm ? nm[1][0].toUpperCase() + nm[1].slice(1).toLowerCase() : "Compromisso";
    // Nome do cliente depois de "com" (best-effort), cortando data/hora/dia-da-semana.
    let contactName: string | null = null;
    const cm = t.match(/\bcom\s+(?:o\s+|a\s+)?(.+)$/i);
    if (cm) {
      contactName = cm[1]
        .replace(/\b(depois de amanh[aã]|amanh[aã]|hoje|ontem|anteontem|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)\b.*$/i, "")
        .replace(/\bdia\s+\d.*$/i, "")
        .replace(/\b[àa]s?\s+\d.*$/i, "")
        .replace(/\b\d{1,2}[:h/].*$/i, "")
        .replace(/\b\d{1,2}\s*h.*$/i, "")
        .replace(/[,;].*$/, "")
        .replace(/[\s.]+$/, "")
        .trim().slice(0, 60);
      if (!contactName) contactName = null;
    }
    return { contactName, date, time, title };
  }

  /** Resolve o cliente por NOME entre os contatos da org. 1 match → id; 0 → not_found; 2+ → ambiguous. */
  static resolveContactByName(orgId: string, name: string): { status: "ok" | "not_found" | "ambiguous"; contactId?: string } {
    const rows = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND name LIKE ? COLLATE NOCASE`).all(orgId, `%${String(name || "").trim()}%`) as any[];
    if (rows.length === 0) return { status: "not_found" };
    if (rows.length > 1) return { status: "ambiguous" };
    return { status: "ok", contactId: rows[0].id };
  }

  /**
   * Propõe o COMPROMISSO como comando governado (domínio 'agenda', não financeiro
   * → não default-deny; nasce awaiting_approval). O contato JÁ resolvido entra no
   * payload; o handler só cria o appointment na aprovação.
   */
  static proposeAppointment(orgId: string, payload: { contactId: string; contactName: string; scheduledStart: string; title: string }, opts: { createdBy?: string; correlationId?: string | null } = {}): any {
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'agenda' AND action_type = 'falatu_record_appointment'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'agenda', 'falatu_record_appointment', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }
    return DecisionActionService.propose(orgId, {
      domain: "agenda",
      actionType: "falatu_record_appointment",
      title: `Agendar ${payload.title} com ${payload.contactName}`,
      description: `${payload.title} · ${payload.contactName} · ${payload.scheduledStart}`.slice(0, 160),
      commandType: "falatu_record_appointment",
      commandPayload: payload,
      correlationId: opts.correlationId ?? null,
      createdBy: opts.createdBy || "falatu",
    });
  }

  static recordAppointment(orgId: string, user: any, text: string, opts: { now?: Date; correlationId?: string | null } = {}): { proposed: boolean; reason?: "no_contact_name" | "no_datetime" | "contact_not_found" | "contact_ambiguous"; contactName?: string | null; date?: string | null; time?: string | null; title?: string; actionId?: string } {
    const today = BusinessTimeService.businessDate(orgId, opts.now || new Date());
    const p = this.parseAppointment(text, today);
    if (!p.contactName) return { proposed: false, reason: "no_contact_name" };
    if (!p.date || !p.time) return { proposed: false, reason: "no_datetime", contactName: p.contactName };
    const resolved = this.resolveContactByName(orgId, p.contactName);
    if (resolved.status === "not_found") return { proposed: false, reason: "contact_not_found", contactName: p.contactName };
    if (resolved.status === "ambiguous") return { proposed: false, reason: "contact_ambiguous", contactName: p.contactName };
    const scheduledStart = `${p.date}T${p.time}:00`;
    const action = this.proposeAppointment(orgId, { contactId: resolved.contactId!, contactName: p.contactName, scheduledStart, title: p.title }, { createdBy: user?.userId || user?.id, correlationId: opts.correlationId ?? null });
    return { proposed: true, contactName: p.contactName, date: p.date, time: p.time, title: p.title, actionId: action?.id };
  }
}

export default FalatuRecordService;
