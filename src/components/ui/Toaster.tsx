import React from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';
import { useToast } from '@/src/store/useToast';

const TOAST_STYLES = {
  success: { icon: CheckCircle2, ring: 'border-emerald-500/30', accent: 'text-emerald-400', bar: 'bg-emerald-500' },
  error: { icon: AlertCircle, ring: 'border-rose-500/30', accent: 'text-rose-400', bar: 'bg-rose-500' },
  info: { icon: Info, ring: 'border-indigo-500/30', accent: 'text-indigo-400', bar: 'bg-indigo-500' },
} as const;

export function Toaster() {
  const toasts = useToast(s => s.toasts);
  const dismiss = useToast(s => s.dismiss);
  const confirms = useToast(s => s.confirms);
  const resolveConfirm = useToast(s => s.resolveConfirm);

  return (
    <>
      {/* Toasts */}
      <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2">
        {toasts.map(t => {
          const s = TOAST_STYLES[t.type];
          const Icon = s.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 overflow-hidden rounded-xl border ${s.ring} bg-zinc-900/95 p-3 pr-2 shadow-2xl backdrop-blur animate-in slide-in-from-right-4 fade-in`}
              role="status"
            >
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.accent}`} />
              <p className="flex-1 whitespace-pre-line break-words text-sm text-zinc-100">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="shrink-0 rounded-md p-1 text-zinc-500 hover:text-zinc-200" aria-label="Fechar">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Modais de confirmação (empilháveis) */}
      {confirms.map(c => (
        <div key={c.id} className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-start gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${c.danger ? 'bg-rose-500/15 text-rose-400' : 'bg-indigo-500/15 text-indigo-400'}`}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1">
                {c.title && <h3 className="text-base font-semibold text-zinc-100">{c.title}</h3>}
                <p className={`text-sm text-zinc-300 ${c.title ? 'mt-1' : ''} whitespace-pre-line`}>{c.message}</p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => resolveConfirm(c.id, false)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
              >
                {c.cancelText}
              </button>
              <button
                onClick={() => resolveConfirm(c.id, true)}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  c.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {c.confirmText}
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
