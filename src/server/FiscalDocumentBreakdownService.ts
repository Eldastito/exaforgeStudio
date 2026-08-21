/**
 * FiscalDocumentBreakdownService — ADR-181 F4: breakdown CBS/IBS/IS para DOCUMENTOS.
 *
 * Camada fina e REUTILIZÁVEL sobre o `ConsumptionTaxService` (F3) que produz um BLOCO
 * SERIALIZÁVEL do breakdown, pronto pra CONGELAR no snapshot canônico de qualquer documento
 * (recibo, pedido…). Trabalha em CENTAVOS (a unidade dos documentos) e devolve os valores em
 * centavos. É AQUI que o número entra no papel — informativo no período de teste (2026).
 *
 * Guardrails RN-FISCAL (herdados do motor, preservados na serialização):
 *  - Honesto: perfil incompleto → `applicable:false` + motivo; NUNCA fabrica linha.
 *  - Nunca inventa (RN-FISCAL-1): tributo sem alíquota vigente entra em `unknownTributes`
 *    (não vira R$ 0). `partial` avisa que o bloco está incompleto.
 *  - Determinístico. Congelável: o bloco é um POJO estável (o caller grava no snapshot).
 */
import { ConsumptionTaxService, ConsumptionTaxInput } from "./ConsumptionTaxService.js";

const TRIBUTE_LABEL: Record<string, string> = { cbs: "CBS", ibs: "IBS", is: "IS (Seletivo)" };

export interface FiscalBreakdownLine {
  tribute: "cbs" | "ibs" | "is";
  label: string;
  ratePercent: number;
  amountCents: number;
}

export interface FiscalBreakdownBlock {
  applicable: boolean;                 // há algo informável?
  status: "computed" | "profile_incomplete";
  reason?: string;                     // quando !applicable
  baseCents: number;
  date: string;
  regime: string | null;
  scope: string | null;
  collectionMode: "das_embedded" | "separate" | null;
  creditEligible: boolean;
  lines: FiscalBreakdownLine[];        // só tributos COMPUTADOS
  unknownTributes: string[];           // tributos sem alíquota vigente (RN-FISCAL-1)
  totalCents: number | null;
  partial: boolean;
  note: string;
  // Marca a versão do formato do bloco — congelado no snapshot, sobrevive a mudanças futuras.
  schema: "fiscal_breakdown_v1";
}

function reais(cents: number): number { return cents / 100; }
function toCents(v: number): number { return Math.round(v * 100); }
function fmtBRL(cents: number): string { return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`; }
function fmtPct(p: number): string { return `${p.toFixed(2).replace(".", ",")}%`; }

export class FiscalDocumentBreakdownService {
  /**
   * Monta o bloco congelável a partir de um valor em CENTAVOS + data. Passa pelo motor F3 e
   * re-serializa em centavos. Honesto ponta-a-ponta (não fabrica número; preserva unknown).
   */
  static build(orgId: string, input: { amountCents: number; date: string; itemType?: "goods" | "service"; selective?: boolean }): FiscalBreakdownBlock {
    const amountCents = Math.max(0, Math.round(Number(input.amountCents) || 0));
    const ctInput: ConsumptionTaxInput = { baseValue: reais(amountCents), date: input.date, itemType: input.itemType, selective: input.selective };
    const r = ConsumptionTaxService.compute(orgId, ctInput);

    if (r.status === "profile_incomplete") {
      return {
        applicable: false, status: "profile_incomplete", reason: "profile_incomplete",
        baseCents: amountCents, date: r.date, regime: null, scope: null, collectionMode: null,
        creditEligible: false, lines: [], unknownTributes: [], totalCents: null, partial: true,
        note: r.note, schema: "fiscal_breakdown_v1",
      };
    }

    const lines: FiscalBreakdownLine[] = [];
    const unknown: string[] = [];
    for (const t of ["cbs", "ibs", "is"] as const) {
      const line = r.taxes[t];
      if (line.status === "computed" && line.rate != null && line.amount != null) {
        lines.push({ tribute: t, label: TRIBUTE_LABEL[t], ratePercent: line.rate, amountCents: toCents(line.amount) });
      } else if (line.status === "unknown") {
        unknown.push(t);
      }
      // not_applicable (ex.: IS não seletivo) simplesmente não entra — não é lacuna.
    }
    const totalCents = lines.length ? lines.reduce((a, l) => a + l.amountCents, 0) : null;

    return {
      applicable: lines.length > 0 || unknown.length > 0,
      status: "computed", baseCents: amountCents, date: r.date, regime: r.regime, scope: r.scope,
      collectionMode: r.collectionMode, creditEligible: r.creditEligible, lines, unknownTributes: unknown,
      totalCents, partial: r.partial, note: r.note, schema: "fiscal_breakdown_v1",
    };
  }

  /**
   * Renderiza o bloco em linhas de texto pro PDF/UI (informativo). Honesto: bloco não-aplicável
   * → uma linha explicando; unknown → linha "aguardando alíquota oficial" (nunca R$ 0).
   */
  static renderLines(block: FiscalBreakdownBlock | null | undefined): string[] {
    if (!block || !block.applicable) {
      return ["Tributos da Reforma (CBS/IBS/IS): informativo indisponível — perfil fiscal incompleto."];
    }
    const out: string[] = ["Tributos da Reforma (informativo):"];
    for (const l of block.lines) out.push(`${l.label} ${fmtPct(l.ratePercent)} — ${fmtBRL(l.amountCents)}`);
    for (const t of block.unknownTributes) out.push(`${TRIBUTE_LABEL[t]}: aguardando alíquota oficial.`);
    if (block.totalCents != null) {
      const tail = block.collectionMode === "das_embedded" ? " (recolhido dentro do DAS — não é cobrança à parte)" : "";
      out.push(`Total tributos${block.partial ? " (parcial)" : ""}: ${fmtBRL(block.totalCents)}${tail}`);
    }
    return out;
  }
}

export default FiscalDocumentBreakdownService;
