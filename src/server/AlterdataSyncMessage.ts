/**
 * AlterdataSyncMessage — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 5, RF-12).
 *
 * Classifica o resultado de uma execução de sincronização em uma mensagem
 * HONESTA — nada de "Sincronização concluída" quando um módulo required
 * falhou. Consumido pela UI (toast + card de última sync) e pelo backend
 * (payload de POST /alterdata/sync).
 *
 * Regras (do PRD §RF-12):
 *   - Sucesso total → "Sincronização concluída"
 *   - Falha parcial → "Sincronização parcial: X ok, Y falhou"
 *   - Falha total → "Sincronização falhou"
 *
 * Fonte da verdade:
 *   1. `runStatus` do ledger (RF-06, PR 3) quando disponível
 *   2. Fallback: heurística sobre o summary (pulados > 0 → parcial)
 */
import type { LedgerRunStatus } from "./AlterdataSyncLedgerService.js";

export type SyncOutcomeSeverity = "ok" | "partial" | "failed";

export interface SyncOutcome {
  severity: SyncOutcomeSeverity;
  title: string;
  detail: string;
}

export interface SyncSummaryShape {
  referencias?: number;
  variantes?: number;
  totalProdutos?: number;
  totalVariantes?: number;
  saldos?: {
    applied?: number;
    skippedNoStore?: number;
    skippedNoProduct?: number;
    sampleNoProduct?: string[];
  };
  precos?: {
    applied?: number;
    skippedNoProduct?: number;
    sampleNoProduct?: string[];
  };
  caixas?: { applied?: number; skippedNoStore?: number; errors?: number };
  vendas?: { imported?: number };
  clientes?: { imported?: number };
  erpComissao?: { imported?: number };
}

/**
 * Devolve `{ severity, title, detail }` honestos pra exibir na UI. `ledgerStatus`,
 * quando presente, ganha da heurística (é a fonte da verdade oficial).
 */
export function formatSyncOutcome(
  summary: SyncSummaryShape | null | undefined,
  ledgerStatus?: LedgerRunStatus | null,
): SyncOutcome {
  const s = summary ?? {};
  const skips: string[] = [];
  const sNoStore = Number(s.saldos?.skippedNoStore || 0);
  const sNoProd = Number(s.saldos?.skippedNoProduct || 0);
  const pNoProd = Number(s.precos?.skippedNoProduct || 0);
  const caixaErr = Number(s.caixas?.errors || 0);
  const sSample = Array.isArray(s.saldos?.sampleNoProduct) && s.saldos!.sampleNoProduct!.length
    ? ` (ex.: ${s.saldos!.sampleNoProduct!.join(", ")})` : "";
  const pSample = Array.isArray(s.precos?.sampleNoProduct) && s.precos!.sampleNoProduct!.length
    ? ` (ex.: ${s.precos!.sampleNoProduct!.join(", ")})` : "";
  if (sNoStore) skips.push(`${sNoStore} saldo(s) sem loja cadastrada`);
  if (sNoProd) skips.push(`${sNoProd} saldo(s) sem produto correspondente${sSample}`);
  if (pNoProd) skips.push(`${pNoProd} preço(s) sem produto correspondente${pSample}`);
  if (caixaErr) skips.push(`${caixaErr} turno(s) do PDV com erro`);

  const totals = s.totalProdutos ? ` (catálogo: ${s.totalProdutos} produtos, ${s.totalVariantes || 0} variantes)` : "";
  const pdvBits: string[] = [];
  if (Number(s.caixas?.applied || 0)) pdvBits.push(`${s.caixas!.applied} fechamento(s) PDV`);
  if (Number(s.vendas?.imported || 0)) pdvBits.push(`${s.vendas!.imported} venda(s) PDV`);
  if (Number(s.clientes?.imported || 0)) pdvBits.push(`${s.clientes!.imported} cliente(s) PDV`);
  if (Number(s.erpComissao?.imported || 0)) pdvBits.push(`${s.erpComissao!.imported} comissão(ões) do ERP`);
  const pdv = pdvBits.length ? ` · ${pdvBits.join(" · ")}` : "";

  const base = `${s.referencias || 0} produtos · ${s.variantes || 0} variantes${totals} · ${s.saldos?.applied || 0} saldos · ${s.precos?.applied || 0} preços${pdv}`;

  // Fonte da verdade: ledger, quando presente
  let severity: SyncOutcomeSeverity;
  if (ledgerStatus === "failed") severity = "failed";
  else if (ledgerStatus === "partial_failure" || ledgerStatus === "cancelled") severity = "partial";
  else if (ledgerStatus === "success") severity = "ok";
  else severity = skips.length > 0 ? "partial" : "ok"; // fallback heurístico

  const title =
    severity === "ok" ? "Sincronização concluída"
    : severity === "partial" ? "Sincronização parcial"
    : "Sincronização falhou";

  const detail = skips.length
    ? `${base} — pulados: ${skips.join("; ")}`
    : base;

  return { severity, title, detail };
}
