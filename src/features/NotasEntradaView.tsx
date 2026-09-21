import React, { useState, useEffect, useCallback } from 'react';
import { toast } from '@/src/lib/toast';
import { FileText, Loader2, PackageCheck, ClipboardCheck, ArrowLeft, AlertTriangle, CheckCircle2, Search, X } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { EmptyState } from '@/src/components/EmptyState';

/**
 * Notas de Entrada — conferência do recebimento fiscal (ADR-200, Fase 2).
 * Consome /api/fiscal/inbound. Lista os documentos fiscais, cria o recebimento
 * esperado a partir do XML autorizado, confere as quantidades fisicamente
 * recebidas (decimal) e confirma — creditando só o recebido no estoque. A
 * associação de item sem produto tem endpoint próprio (follow-up de UI).
 *
 * Recurso gated por org: quando o flag fiscal_inbound_enabled está desligado,
 * a API responde 404 e a tela mostra o estado "não habilitado".
 */

type FiscalDoc = {
  id: string; number?: string; series?: string; issuer_name?: string; issuer_cnpj?: string;
  issue_at?: string; content_level: string; fiscal_status: string; processing_state: string;
  store_id?: string | null; goods_receipt_id?: string | null; total_invoice?: number | null;
};

type ReceiptItem = {
  id: string; fiscal_description?: string; ean?: string | null; expected_qty: number;
  received_qty: number; damage_qty: number; mapping_status: string; product_service_id?: string | null;
  divergence_status: string; ledger_status?: string;
};

type Receipt = {
  id: string; status: string; store_id?: string | null; items: ReceiptItem[];
  unmapped: number; divergences: number;
};

const CONTENT_LABEL: Record<string, string> = {
  authorized_process: 'XML completo', summary_only: 'Resumo', signed_only: 'Assinado (sem protocolo)',
  event_only: 'Evento', invalid: 'Inválido',
};
const FISCAL_LABEL: Record<string, string> = {
  authorized: 'Autorizada', cancelled: 'Cancelada', denied: 'Denegada', unknown: 'Desconhecida',
};
const DIVERGENCE_LABEL: Record<string, string> = {
  ok: 'OK', missing: 'Não veio', short: 'Faltou', over: 'Sobrou', unexpected: 'Sem pedido', pending: '—',
};

function num(v: any): number { return Number(v || 0); }
function fmt(v: any): string { return num(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 }); }
function fmtDate(v?: string): string { if (!v) return '—'; try { return new Date(v).toLocaleDateString('pt-BR'); } catch { return String(v); } }

export function NotasEntradaView() {
  const [docs, setDocs] = useState<FiscalDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  // Picker de produto (associação de item sem mapeamento)
  const [mapItemId, setMapItemId] = useState<string | null>(null);
  const [mapQuery, setMapQuery] = useState('');
  const [mapResults, setMapResults] = useState<Array<{ id: string; name: string; ean?: string | null }>>([]);
  const [mapSearching, setMapSearching] = useState(false);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/fiscal/inbound/documents');
      if (r.status === 404) { setDisabled(true); setDocs([]); return; }
      if (!r.ok) throw new Error('Falha ao carregar notas.');
      const d = await r.json();
      setDocs(Array.isArray(d.documents) ? d.documents : []);
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao carregar notas de entrada.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  async function openReceipt(receiptId: string) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/fiscal/inbound/receipts/${receiptId}`);
      if (!r.ok) throw new Error('Falha ao abrir recebimento.');
      const d = await r.json();
      setReceipt(d.receipt);
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao abrir recebimento.');
    } finally {
      setBusy(false);
    }
  }

  async function createReceipt(doc: FiscalDoc) {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/fiscal/inbound/documents/${doc.id}/create-receipt`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = d?.reason === 'store_assignment_required' ? 'A loja destinatária não foi resolvida (confira o CNPJ da loja).' : (d?.reason || 'Não foi possível criar o recebimento.');
        throw new Error(reason);
      }
      if (d.receiptId) { await openReceipt(d.receiptId); await loadDocs(); }
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao criar recebimento.');
    } finally {
      setBusy(false);
    }
  }

  async function setReceived(item: ReceiptItem, received: number, damage: number) {
    if (!receipt) return;
    try {
      const r = await apiFetch(`/api/fiscal/inbound/receipts/${receipt.id}/items/${item.id}/received`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receivedQty: received, damageQty: damage }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.reason || 'Falha ao salvar quantidade.');
      if (d.receipt) setReceipt(d.receipt);
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao salvar quantidade.');
    }
  }

  // Busca produtos do catálogo (reutiliza /api/products) com debounce simples.
  useEffect(() => {
    if (!mapItemId) return;
    const q = mapQuery.trim();
    let alive = true;
    setMapSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/products?limit=20&offset=0&q=${encodeURIComponent(q)}`);
        const list = r.ok ? await r.json() : [];
        if (alive) setMapResults(Array.isArray(list) ? list : []);
      } catch {
        if (alive) setMapResults([]);
      } finally {
        if (alive) setMapSearching(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [mapItemId, mapQuery]);

  function openPicker(itemId: string) { setMapItemId(itemId); setMapQuery(''); setMapResults([]); }
  function closePicker() { setMapItemId(null); setMapQuery(''); setMapResults([]); }

  async function mapItem(itemId: string, productServiceId: string) {
    if (!receipt) return;
    try {
      const r = await apiFetch(`/api/fiscal/inbound/receipts/${receipt.id}/items/${itemId}/map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productServiceId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.reason || 'Falha ao associar produto.');
      if (d.receipt) setReceipt(d.receipt);
      closePicker();
      toast.success('Produto associado.');
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao associar produto.');
    }
  }

  async function confirmReceipt() {
    if (!receipt) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/fiscal/inbound/receipts/${receipt.id}/confirm`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = d?.reason === 'store_required' ? 'Recebimento sem loja não pode ser confirmado.' : (d?.reason || 'Falha ao confirmar.');
        throw new Error(reason);
      }
      toast.success(`Recebimento confirmado. ${d.credited || 0} item(ns) creditado(s), ${d.skipped || 0} pulado(s).`);
      if (d.receipt) setReceipt(d.receipt);
      await loadDocs();
    } catch (e: any) {
      toast.error(e?.message || 'Erro ao confirmar recebimento.');
    } finally {
      setBusy(false);
    }
  }

  // ----- Recurso não habilitado ---------------------------------------------
  if (disabled) {
    return (
      <div className="flex-1 overflow-auto p-6 bg-zinc-950">
        <p className="zf-kicker mb-1">Notas de Entrada</p>
        <h2 className="zf-page-title flex items-center gap-2"><FileText className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Entrada de NF-e</h2>
        <div className="mt-6">
          <EmptyState icon={<FileText className="w-8 h-8" />} title="Recurso não habilitado" description="A entrada automática de NF-e ainda não está ligada para esta organização. Fale com o suporte para habilitar." />
        </div>
      </div>
    );
  }

  // ----- Conferência de um recebimento --------------------------------------
  if (receipt) {
    const done = receipt.status === 'confirmed';
    return (
      <div className="flex-1 overflow-auto p-6 bg-zinc-950">
        <button className="text-zinc-400 hover:text-zinc-200 text-sm flex items-center gap-1 mb-4" onClick={() => { setReceipt(null); loadDocs(); }}>
          <ArrowLeft className="w-4 h-4" /> Voltar às notas
        </button>
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="zf-kicker mb-1">Conferência de recebimento</p>
            <h2 className="zf-page-title flex items-center gap-2"><ClipboardCheck className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Recebimento {done ? '(confirmado)' : ''}</h2>
            <p className="text-zinc-400 text-sm mt-1">{receipt.items.length} item(ns) · {receipt.unmapped} sem produto · {receipt.divergences} divergência(s)</p>
          </div>
          {!done && (
            <Button onClick={confirmReceipt} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />} Confirmar recebimento
            </Button>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="text-left p-3">Descrição fiscal</th>
                <th className="text-left p-3">Produto</th>
                <th className="text-right p-3">Esperado</th>
                <th className="text-right p-3">Recebido</th>
                <th className="text-right p-3">Avaria</th>
                <th className="text-left p-3">Divergência</th>
              </tr>
            </thead>
            <tbody>
              {receipt.items.map((it) => (
                <React.Fragment key={it.id}>
                <tr className="border-t border-zinc-800">
                  <td className="p-3 text-zinc-200 max-w-xs truncate" title={it.fiscal_description || ''}>{it.fiscal_description || '—'}<div className="text-xs text-zinc-500">{it.ean || 'sem EAN'}</div></td>
                  <td className="p-3">
                    {it.product_service_id
                      ? <span className="text-emerald-300 text-xs">associado</span>
                      : (done
                          ? <span className="inline-flex items-center gap-1 text-amber-400 text-xs"><AlertTriangle className="w-3 h-3" /> sem produto</span>
                          : <button className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 text-xs" onClick={() => (mapItemId === it.id ? closePicker() : openPicker(it.id))}><Search className="w-3 h-3" /> associar</button>)}
                  </td>
                  <td className="p-3 text-right text-zinc-300">{fmt(it.expected_qty)}</td>
                  <td className="p-3 text-right">
                    <input
                      type="number" step="0.001" min="0" defaultValue={it.received_qty ?? 0} disabled={done}
                      className="w-24 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-right text-zinc-100 disabled:opacity-60"
                      onBlur={(e) => { const v = Number(e.target.value); if (v !== num(it.received_qty)) setReceived(it, v, num(it.damage_qty)); }}
                    />
                  </td>
                  <td className="p-3 text-right">
                    <input
                      type="number" step="0.001" min="0" defaultValue={it.damage_qty ?? 0} disabled={done}
                      className="w-20 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-right text-zinc-100 disabled:opacity-60"
                      onBlur={(e) => { const v = Number(e.target.value); if (v !== num(it.damage_qty)) setReceived(it, num(it.received_qty), v); }}
                    />
                  </td>
                  <td className="p-3 text-zinc-300">
                    {DIVERGENCE_LABEL[it.divergence_status] || it.divergence_status}
                    {it.ledger_status === 'fractional_pending' && <div className="text-xs text-amber-400">fração não creditada</div>}
                  </td>
                </tr>
                {mapItemId === it.id && (
                  <tr className="border-t border-zinc-800 bg-zinc-900/50">
                    <td colSpan={6} className="p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <Search className="w-4 h-4 text-zinc-400" />
                        <input
                          autoFocus type="text" value={mapQuery} onChange={(e) => setMapQuery(e.target.value)}
                          placeholder="Buscar produto do catálogo por nome ou código…"
                          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-zinc-100 text-sm"
                        />
                        <button className="text-zinc-400 hover:text-zinc-200" onClick={closePicker}><X className="w-4 h-4" /></button>
                      </div>
                      {mapSearching ? (
                        <div className="text-zinc-500 text-xs py-2 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> buscando…</div>
                      ) : mapResults.length === 0 ? (
                        <div className="text-zinc-500 text-xs py-2">{mapQuery.trim() ? 'Nenhum produto encontrado.' : 'Digite para buscar no catálogo.'}</div>
                      ) : (
                        <div className="max-h-48 overflow-auto divide-y divide-zinc-800 rounded border border-zinc-800">
                          {mapResults.map((p) => (
                            <button key={p.id} className="w-full text-left px-3 py-2 hover:bg-zinc-800 flex justify-between items-center" onClick={() => mapItem(it.id, p.id)}>
                              <span className="text-zinc-200 text-sm">{p.name}</span>
                              <span className="text-zinc-500 text-xs">{p.ean || ''}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {done && (
          <p className="text-zinc-500 text-xs mt-4">No modo supervisionado, o saldo oficial permanece no Alterdata; o ZapFlow confirmou o recebido na sombra.</p>
        )}
      </div>
    );
  }

  // ----- Lista de documentos -------------------------------------------------
  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-6">
        <div>
          <p className="zf-kicker mb-1">Notas de Entrada</p>
          <h2 className="zf-page-title flex items-center gap-2"><FileText className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Entrada de NF-e</h2>
          <p className="text-zinc-400 text-sm mt-1">Confira o que chegou contra a nota e credite só o recebido no estoque.</p>
        </div>
        <Button variant="outline" className="border-zinc-700 text-zinc-200" onClick={loadDocs} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Atualizar
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-500"><Loader2 className="w-6 h-6 animate-spin" /></div>
      ) : docs.length === 0 ? (
        <EmptyState icon={<FileText className="w-8 h-8" />} title="Nenhuma nota de entrada" description="Notas importadas por XML aparecem aqui para conferência e entrada de estoque." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="text-left p-3">Nota</th>
                <th className="text-left p-3">Emissão</th>
                <th className="text-left p-3">Fornecedor</th>
                <th className="text-left p-3">Completude</th>
                <th className="text-left p-3">Situação</th>
                <th className="text-right p-3">Total</th>
                <th className="text-right p-3">Ação</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-zinc-800">
                  <td className="p-3 text-zinc-200">{d.number || '—'}{d.series ? `/${d.series}` : ''}</td>
                  <td className="p-3 text-zinc-300">{fmtDate(d.issue_at)}</td>
                  <td className="p-3 text-zinc-300 max-w-xs truncate" title={d.issuer_name || ''}>{d.issuer_name || '—'}</td>
                  <td className="p-3 text-zinc-300">{CONTENT_LABEL[d.content_level] || d.content_level}</td>
                  <td className="p-3 text-zinc-300">{FISCAL_LABEL[d.fiscal_status] || d.fiscal_status}</td>
                  <td className="p-3 text-right text-zinc-300">{d.total_invoice != null ? num(d.total_invoice).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}</td>
                  <td className="p-3 text-right">
                    {d.goods_receipt_id ? (
                      <Button size="sm" variant="outline" className="border-zinc-700 text-zinc-200" disabled={busy} onClick={() => openReceipt(d.goods_receipt_id!)}>
                        <ClipboardCheck className="w-4 h-4 mr-1" /> Conferir
                      </Button>
                    ) : d.content_level === 'authorized_process' ? (
                      d.processing_state === 'store_assignment_required'
                        ? <span className="text-amber-400 text-xs">definir loja</span>
                        : <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500" disabled={busy} onClick={() => createReceipt(d)}>
                            <PackageCheck className="w-4 h-4 mr-1" /> Criar recebimento
                          </Button>
                    ) : (
                      <span className="text-zinc-500 text-xs">aguardando XML</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default NotasEntradaView;
