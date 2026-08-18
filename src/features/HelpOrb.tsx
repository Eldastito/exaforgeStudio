/**
 * HelpOrb — Tutor de Ajuda (ADR-179 F1). Botão flutuante "Precisa de ajuda?" que
 * abre um chat simples de dúvida→resposta. É o Fala Tu respondendo (RN-UX-1) — NÃO
 * é um 2º motor de chat: apenas consome `POST /api/ux/help`, que aterra a resposta
 * na base de ajuda CURADA (com citação da fonte) ou admite honestamente quando não
 * há cobertura (RN-HELP-1/2).
 *
 * Funciona SEM `falatu_enabled` (ajuda é universal); voz/WhatsApp são o Fala Tu
 * completo, fora do escopo desta fatia. `moduleKey` = tela atual (contextual, soft).
 */
import { useState, useRef, useEffect, type FormEvent } from 'react';
import { apiFetch } from '@/src/lib/api';

interface HelpArticle {
  id: string;
  title: string;
  moduleKey: string | null;
  steps: string[];
  commonErrors: string[];
  sourceRef: string | null;
}
interface HelpResponse {
  intent: string;
  message: string;
  article: HelpArticle | null;
  gapLogged: boolean;
}
interface Turn { q: string; a: HelpResponse | null; error?: boolean }

export function HelpOrb({ moduleKey }: { moduleKey?: string | null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, open]);

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    setText('');
    setBusy(true);
    setTurns((t) => [...t, { q, a: null }]);
    try {
      const r = await apiFetch('/api/ux/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: q, moduleKey: moduleKey || null }),
      });
      const data = r.ok ? (await r.json()) as HelpResponse : null;
      setTurns((t) => t.map((it, i) => (i === t.length - 1 ? { ...it, a: data, error: !data } : it)));
    } catch {
      setTurns((t) => t.map((it, i) => (i === t.length - 1 ? { ...it, a: null, error: true } : it)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Botão flutuante */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Precisa de ajuda?"
        className="fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg flex items-center justify-center text-xl transition-transform hover:scale-105"
        title="Precisa de ajuda?"
      >
        {open ? '×' : '?'}
      </button>

      {/* Painel de chat */}
      {open && (
        <div className="fixed bottom-20 right-5 z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <div className="text-sm font-semibold text-zinc-100">Precisa de ajuda?</div>
            <div className="text-xs text-zinc-500">Pergunte como fazer algo — respondo com base na documentação.</div>
          </div>

          <div ref={scrollRef} className="flex-1 max-h-80 overflow-y-auto px-4 py-3 space-y-3">
            {turns.length === 0 && (
              <div className="text-xs text-zinc-500">
                Ex.: <em>"como funciona a Central de Saúde?"</em>, <em>"como faço a reposição de estoque?"</em>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="space-y-1.5">
                <div className="text-sm text-zinc-300"><span className="text-zinc-500">Você:</span> {t.q}</div>
                {t.a === null && !t.error && <div className="text-xs text-zinc-500 animate-pulse">pensando…</div>}
                {t.error && <div className="text-xs text-amber-400">Não consegui responder agora. Tente de novo.</div>}
                {t.a && (
                  <div className="rounded-lg bg-zinc-800/70 px-3 py-2">
                    <div className="text-sm text-zinc-100 whitespace-pre-line">{t.a.message}</div>
                    {t.a.article && t.a.article.commonErrors.length > 0 && (
                      <div className="mt-2 text-xs text-zinc-400">
                        <div className="font-medium text-zinc-300">Erros comuns:</div>
                        <ul className="list-disc list-inside">
                          {t.a.article.commonErrors.map((er, k) => <li key={k}>{er}</li>)}
                        </ul>
                      </div>
                    )}
                    {t.a.article && (
                      <div className="mt-2 text-[11px] text-indigo-300">Fonte: {t.a.article.title}</div>
                    )}
                    {!t.a.article && t.a.gapLogged && (
                      <div className="mt-1 text-[11px] text-zinc-500">Ainda não tenho isso documentado — registrei sua dúvida para melhorarmos.</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <form onSubmit={ask} className="p-3 border-t border-zinc-800 flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Digite sua dúvida…"
              className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button type="submit" disabled={busy || !text.trim()}
              className="rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm px-3 py-2">
              Enviar
            </button>
          </form>
        </div>
      )}
    </>
  );
}

export default HelpOrb;
