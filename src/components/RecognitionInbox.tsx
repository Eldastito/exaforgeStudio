import { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Heart, Send, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

// Notas de Reconhecimento (Hunter, ADR-049) — o Diretor IA sugere
// pequenas notas ao dono quando detecta esforço/momento notável
// (CSAT máximo, cliente recuperado, recompra fiel). O dono revê, ajusta
// e decide se envia. Nunca envia automaticamente — automatizar mata o
// valor. Reconhecimento importa porque VEM DO DONO.

interface Note {
  id: string;
  targetType: 'customer' | 'employee' | 'partner';
  targetName: string | null;
  triggerType: string;
  suggestedMessage: string;
  status: 'suggested' | 'sent' | 'dismissed';
  createdAt: string;
}

const TRIGGER_LABEL: Record<string, string> = {
  csat_high: 'Nota máxima',
  loyal_repurchase: 'Cliente fiel voltou',
  high_ticket_order: 'Compra grande',
  recovered_customer: 'Cliente recuperado',
  kind_message: 'Mensagem carinhosa',
};

export function RecognitionInbox({ className = '' }: { className?: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [acting, setActing] = useState<Record<string, boolean>>({});

  const load = () => {
    setLoading(true);
    apiFetch('/api/recognition?status=suggested')
      .then((r) => r.json())
      .then((d) => setNotes(Array.isArray(d?.notes) ? d.notes : []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const act = async (id: string, action: 'sent' | 'dismissed') => {
    setActing((s) => ({ ...s, [id]: true }));
    try {
      const res = await apiFetch(`/api/recognition/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        // Otimista: remove da fila.
        setNotes((prev) => (prev || []).filter((n) => n.id !== id));
      }
    } finally {
      setActing((s) => { const { [id]: _, ...rest } = s; return rest; });
    }
  };

  const copy = (text: string) => {
    try { navigator.clipboard?.writeText(text); } catch { /* noop */ }
  };

  if (loading || !notes) {
    return (
      <div className={`rounded-2xl border border-rose-500/20 bg-slate-900/50 p-4 flex items-center gap-3 ${className}`}>
        <Loader2 className="w-4 h-4 animate-spin text-rose-300" />
        <span className="text-sm text-slate-400">Carregando reconhecimentos…</span>
      </div>
    );
  }
  if (notes.length === 0) return null;

  return (
    <div className={`rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-500/10 via-rose-500/5 to-slate-900/50 p-5 ${className}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className="rounded-lg bg-rose-500/20 p-2">
          <Heart className="w-4 h-4 text-rose-300" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-rose-300 font-semibold">💝 Reconhecer (Hunter)</p>
          <p className="text-sm text-zinc-100 font-medium">
            {notes.length === 1 ? '1 pessoa merece uma nota sua hoje' : `${notes.length} pessoas merecem uma nota sua hoje`}
          </p>
          <p className="text-xs text-zinc-400 mt-0.5">Reconhecimento vale porque vem do dono. Revê, ajusta e envia.</p>
        </div>
      </div>

      <ul className="space-y-2">
        {notes.map((n) => {
          const isOpen = !!expanded[n.id];
          return (
            <li key={n.id} className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3">
              <div className="flex items-start gap-2">
                <button
                  onClick={() => setExpanded((s) => ({ ...s, [n.id]: !isOpen }))}
                  className="flex-1 text-left"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-zinc-100">{n.targetName || 'Cliente'}</span>
                    <span className="text-[10px] uppercase tracking-wide text-rose-300/80">{TRIGGER_LABEL[n.triggerType] || n.triggerType}</span>
                  </div>
                  {!isOpen && (
                    <p className="text-xs text-zinc-400 mt-1 line-clamp-1">{n.suggestedMessage.split('\n')[0]}</p>
                  )}
                </button>
                <button
                  onClick={() => setExpanded((s) => ({ ...s, [n.id]: !isOpen }))}
                  className="text-zinc-500 hover:text-zinc-300"
                  aria-label={isOpen ? 'Recolher' : 'Expandir'}
                >
                  {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>

              {isOpen && (
                <div className="mt-2 space-y-2">
                  <pre className="whitespace-pre-wrap text-xs text-zinc-200 bg-slate-900/60 border border-slate-800 rounded-lg p-2 font-sans leading-relaxed">
                    {n.suggestedMessage}
                  </pre>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => copy(n.suggestedMessage)}
                      className="text-xs text-zinc-300 hover:text-white border border-slate-700 rounded-md px-2 py-1"
                    >
                      Copiar
                    </button>
                    <button
                      onClick={() => act(n.id, 'sent')}
                      disabled={!!acting[n.id]}
                      className="inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-2.5 py-1 disabled:opacity-50"
                    >
                      {acting[n.id] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Enviei
                    </button>
                    <button
                      onClick={() => act(n.id, 'dismissed')}
                      disabled={!!acting[n.id]}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-100 border border-slate-700 rounded-md px-2.5 py-1 disabled:opacity-50"
                    >
                      <X className="w-3 h-3" /> Dispensar
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
