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
}

export default FalatuRecordService;
