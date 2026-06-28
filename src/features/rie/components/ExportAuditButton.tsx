import { useState } from 'react';
import { FileDown, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import type { RicPeriod } from '../types';

/**
 * Exporta o PDF da auditoria de 10 seções (+ plano 30/60/90). Pode demorar
 * alguns segundos porque o plano chama o LLM — daí o estado de loading.
 */
export function ExportAuditButton({ period }: { period: RicPeriod }) {
  const [loading, setLoading] = useState(false);

  const exportPdf = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/analytics/revenue-intelligence/audit-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, includePlan: true }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `auditoria-receita-${period}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // silencioso — o botão volta ao normal; o usuário pode tentar de novo.
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={exportPdf}
      disabled={loading}
      className="flex items-center gap-2 rounded-ric-card border border-ric-border bg-ric-surface px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-ric-surface-2 disabled:opacity-60"
    >
      {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
      {loading ? 'Gerando…' : 'Exportar PDF'}
    </button>
  );
}
