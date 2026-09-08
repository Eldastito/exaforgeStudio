/**
 * FalatuRecordCommandHandler — executa o registro de DESPESA ditado pelo dono no
 * Fala Tu, PELO choke-point governado (D4): a fala não escreve direto; vira um
 * COMANDO que atravessa `DecisionAction → ApprovalPolicy → CommandExecutor`.
 * Registrado no MESMO registry do executor (§184 — sem runtime paralelo),
 * espelhando `SocialPublishCommandHandler`.
 *
 * O efeito é DINHEIRO (conta a pagar) → a ação nasce `awaiting_approval`
 * (política 'single' por não estar na matriz de DEFAULTS + finance é
 * financeiro/destrutivo, RN-159-1). Só após a aprovação humana o `execute` roda
 * `FinancialLedgerService.addPayable`. Idempotência durável: o executor já barra
 * 2º `execute` bem-sucedido (`action_already_executed`) — o mesmo lançamento
 * nunca entra 2× no `payables`.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { CommandExecutorService, type CommandHandler } from "./CommandExecutorService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

function payloadOf(action: any): any { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } }

function brl(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = v.toFixed(2).split(".");
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

export const FalatuRecordExpenseCommandHandler: CommandHandler = {
  key: "FalatuRecordExpenseCommandHandler",
  commandTypes: ["falatu_record_expense"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Despesa a lançar: ${brl(Number(p.amount) || 0)}${p.supplierName ? ` — ${p.supplierName}` : ""} (vence ${p.dueDate || "?"})`,
      artifact: { kind: "payable_draft", amount: Number(p.amount) || 0, supplierName: p.supplierName ?? null, dueDate: p.dueDate ?? null, description: p.description ?? null },
    };
  },

  execute(orgId, action) {
    const p = payloadOf(action);
    const r = FinancialLedgerService.addPayable(orgId, {
      description: String(p.description || "Despesa (Fala Tu)"),
      amount: Number(p.amount) || 0,
      dueDate: String(p.dueDate || ""),
      supplierName: p.supplierName ?? undefined,
      category: p.category ?? undefined,
      createdBy: action.created_by || "falatu",
    });
    // Falha HONESTA (execução auditada como `failed`, retryável) — nunca finge.
    if (!r.ok) throw new Error(`Não consegui lançar a despesa (${r.error}).`);
    return {
      summary: `Despesa lançada: ${brl(Number(p.amount) || 0)}${p.supplierName ? ` — ${p.supplierName}` : ""}`,
      artifact: { kind: "payable", payableId: r.id, amount: Number(p.amount) || 0 },
      effect: "payable_created",
      externalRef: r.id,
    };
  },
};

// F6 — VENDA (entrada de caixa). Mesmo choke-point governado; o efeito é
// `recordEvent direction:'in'` (dinheiro que ENTROU — VENDA≠LUCRO≠CAIXA, só o
// que entrou de fato forma o caixa). Idempotência DURÁVEL via `sourceId=action.id`
// (o mesmo lançamento nunca entra 2× no `cash_events`) + o guard do executor.
export const FalatuRecordSaleCommandHandler: CommandHandler = {
  key: "FalatuRecordSaleCommandHandler",
  commandTypes: ["falatu_record_sale"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Venda a registrar: ${brl(Number(p.amount) || 0)} (entrada de caixa em ${p.eventDate || "?"})`,
      artifact: { kind: "cash_in_draft", amount: Number(p.amount) || 0, eventDate: p.eventDate ?? null, note: p.note ?? null },
    };
  },

  execute(orgId, action) {
    const p = payloadOf(action);
    const r = FinancialLedgerService.recordEvent(orgId, {
      direction: "in",
      amount: Number(p.amount) || 0,
      eventDate: p.eventDate || undefined,
      sourceType: "falatu_sale",
      sourceId: action.id, // idempotência durável (INSERT OR IGNORE por source)
      note: String(p.note || "Venda (Fala Tu)"),
      createdBy: action.created_by || "falatu",
    });
    if (!r.ok) throw new Error(`Não consegui registrar a venda (${r.error}).`);
    return {
      summary: `Venda registrada: ${brl(Number(p.amount) || 0)} (entrada de caixa)`,
      artifact: { kind: "cash_in", amount: Number(p.amount) || 0, deduped: !!(r as any).deduped },
      effect: "cash_in_recorded",
      externalRef: (r as any).id ?? action.id,
    };
  },
};

// F7 — CLIENTE (contato). Contatos são presos a um channel_id — não existe
// criador "sem canal" no repo; espelhamos BalcaoService.ensureFiadoContact:
// canal SINTÉTICO 'falatu' (uma vez por org) + dedupe por identifier
// (telefone/email/nome). Idempotência DURÁVEL: dedupe + guard do executor →
// o mesmo cliente nunca duplica.
export const FalatuRecordContactCommandHandler: CommandHandler = {
  key: "FalatuRecordContactCommandHandler",
  commandTypes: ["falatu_record_contact"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    const extra = [p.phone, p.email].filter(Boolean).join(" · ");
    return {
      summary: `Cliente a cadastrar: ${p.name || "?"}${extra ? ` (${extra})` : ""}`,
      artifact: { kind: "contact_draft", name: p.name ?? null, phone: p.phone ?? null, email: p.email ?? null },
    };
  },

  execute(orgId, action) {
    const p = payloadOf(action);
    const name = String(p.name || "").trim();
    if (!name) throw new Error("Não consegui identificar o nome do cliente.");
    // Canal sintético 'falatu' (uma vez por org), espelhando o 'balcao'.
    let ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'falatu'`).get(orgId) as any;
    if (!ch) {
      const chId = randomUUID();
      db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'falatu', 'Fala Tu', 'falatu', 'connected')`).run(chId, orgId);
      ch = { id: chId };
    }
    const identifier = String(p.phone || p.email || name).trim();
    const existing = db.prepare(`SELECT id FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = ?`).get(orgId, ch.id, identifier) as any;
    if (existing) {
      return { summary: `Cliente já cadastrado: ${name}`, artifact: { kind: "contact", contactId: existing.id, deduped: true }, effect: "contact_deduped", externalRef: existing.id };
    }
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, email) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(contactId, orgId, ch.id, name, identifier, p.email || null);
    return { summary: `Cliente cadastrado: ${name}`, artifact: { kind: "contact", contactId }, effect: "contact_created", externalRef: contactId };
  },
};

// F11 — COMPROMISSO com cliente. O efeito é criar o appointment na agenda
// (AppointmentService.create) — o contato JÁ foi resolvido no propose (payload
// carrega contactId + scheduledStart). Idempotência durável pelo guard do
// executor (o mesmo action nunca cria 2 appointments).
export const FalatuRecordAppointmentCommandHandler: CommandHandler = {
  key: "FalatuRecordAppointmentCommandHandler",
  commandTypes: ["falatu_record_appointment"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Compromisso a agendar: ${p.title || "Compromisso"} com ${p.contactName || "?"} (${p.scheduledStart || "?"})`,
      artifact: { kind: "appointment_draft", contactId: p.contactId ?? null, contactName: p.contactName ?? null, scheduledStart: p.scheduledStart ?? null, title: p.title ?? null },
    };
  },

  async execute(orgId, action) {
    const p = payloadOf(action);
    const { AppointmentService } = await import("./AppointmentService.js");
    let appt: any;
    try {
      appt = AppointmentService.create(orgId, { contactId: String(p.contactId || ""), title: String(p.title || "Compromisso"), scheduledStart: String(p.scheduledStart || "") }, action.created_by || "falatu");
    } catch (e: any) {
      throw new Error(`Não consegui agendar o compromisso: ${e.message}`);
    }
    return {
      summary: `Compromisso agendado: ${p.title || "Compromisso"} com ${p.contactName || ""}`,
      artifact: { kind: "appointment", appointmentId: appt?.id, contactName: p.contactName ?? null },
      effect: "appointment_created",
      externalRef: appt?.id ?? null,
    };
  },
};

// F12 — RECEBÍVEL / FIADO (conta a receber). O efeito é
// FinancialLedgerService.addReceivable (dinheiro que ENTRA no futuro; status
// 'open'). Idempotência durável pelo guard do executor.
export const FalatuRecordReceivableCommandHandler: CommandHandler = {
  key: "FalatuRecordReceivableCommandHandler",
  commandTypes: ["falatu_record_receivable"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Recebível a lançar: ${brl(Number(p.amount) || 0)}${p.clientName ? ` — ${p.clientName}` : ""} (vence ${p.dueDate || "?"})`,
      artifact: { kind: "receivable_draft", amount: Number(p.amount) || 0, clientName: p.clientName ?? null, dueDate: p.dueDate ?? null, contactId: p.contactId ?? null },
    };
  },

  execute(orgId, action) {
    const p = payloadOf(action);
    const r = FinancialLedgerService.addReceivable(orgId, {
      description: String(p.description || "Recebível (Fala Tu)"),
      amount: Number(p.amount) || 0,
      dueDate: String(p.dueDate || ""),
      contactId: p.contactId || undefined,
      createdBy: action.created_by || "falatu",
    });
    if (!r.ok) throw new Error(`Não consegui lançar o recebível (${r.error}).`);
    return {
      summary: `Recebível lançado: ${brl(Number(p.amount) || 0)}${p.clientName ? ` — ${p.clientName}` : ""}`,
      artifact: { kind: "receivable", receivableId: (r as any).id ?? null, amount: Number(p.amount) || 0 },
      effect: "receivable_created",
      externalRef: (r as any).id ?? action.id,
    };
  },
};

// Registra no MESMO registry do executor (mesmo padrão de SocialPublishCommandHandler).
CommandExecutorService.registerHandler(FalatuRecordExpenseCommandHandler);
CommandExecutorService.registerHandler(FalatuRecordSaleCommandHandler);
CommandExecutorService.registerHandler(FalatuRecordContactCommandHandler);
CommandExecutorService.registerHandler(FalatuRecordAppointmentCommandHandler);
CommandExecutorService.registerHandler(FalatuRecordReceivableCommandHandler);

export default FalatuRecordExpenseCommandHandler;
