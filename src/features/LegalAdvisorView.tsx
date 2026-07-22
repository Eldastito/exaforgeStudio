import { useEffect, useRef, useState } from 'react';
import { Scale, Loader2, Send, BookOpen, ShieldAlert, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

/**
 * Dica jurídica proativa (ADR-115 Fatia 2) — reutilizável: mostra, no momento
 * certo (ex.: cobrança de fiado), a orientação ancorada no CDC + artigos, com
 * disclaimer. A IA sugere; o lojista decide. Colapsável para não atrapalhar.
 */
export function LegalTip({ situation, className = '' }: { situation: string; className?: string }) {
  const [tip, setTip] = useState<any | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/legal/situation/${situation}`).then((r) => r.json()).then((d: any) => { if (alive && d?.dica) setTip(d); }).catch(() => {});
    return () => { alive = false; };
  }, [situation]);

  if (!tip) return null;
  return (
    <div className={`rounded-xl border border-indigo-500/25 bg-indigo-500/5 ${className}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Scale className="w-4 h-4 text-indigo-300 shrink-0" />
        <span className="flex-1 text-[12px] text-indigo-100"><strong>Dica jurídica:</strong> {tip.titulo}</span>
        {open ? <ChevronUp className="w-4 h-4 text-indigo-300" /> : <ChevronDown className="w-4 h-4 text-indigo-300" />}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="text-[12px] text-zinc-200">{tip.dica}</p>
          {tip.artigos?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tip.artigos.map((a: any) => (
                <span key={a.ref || a.numero} title={a.texto} className="rounded-full border border-zinc-700 bg-zinc-900/50 px-2 py-0.5 text-[10px] text-zinc-300">{a.ref || `Art. ${a.numero}`}</span>
              ))}
            </div>
          )}
          <p className="mt-2 text-[10px] text-amber-200/70">{tip.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

// Consultora Jurídica (ADR-115) — Q&A ancorado no CDC. Global (todas as verticais).
// A IA orienta o lojista a NÃO se prejudicar; disclaimer sempre visível.

interface Artigo { numero: string; titulo: string; texto: string; fonte?: string; ref?: string }
interface Answer {
  grounded: boolean;
  orientacao: string;
  artigos: Artigo[];
  disclaimer: string;
  fonte: string;
  versao: string;
  question: string;
}

export function LegalAdvisorView() {
  const [topics, setTopics] = useState<{ label: string; question: string }[]>([]);
  const [base, setBase] = useState<{ fonte: string; versao: string; artigos: number; normas?: number } | null>(null);
  const [themes, setThemes] = useState<{ total: number; temas: { ref: string; titulo: string; count: number }[] } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Answer[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);

  const loadThemes = () => apiFetch('/api/legal/history').then((r) => r.json()).then((d: any) => { if (d && typeof d.total === 'number') setThemes(d); }).catch(() => {});
  useEffect(() => {
    apiFetch('/api/legal').then((r) => r.json()).then((d: any) => {
      if (Array.isArray(d?.topics)) setTopics(d.topics);
      if (d?.base) setBase(d.base);
    }).catch(() => {});
    loadThemes();
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, busy]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 3 || busy) return;
    setBusy(true);
    setQ('');
    try {
      const res = await apiFetch('/api/legal/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setHistory((h) => [...h, { ...d, question: text }]); loadThemes(); }
      else toast.error(d.error || 'Não consegui responder.');
    } catch { toast.error('Falha na consulta.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 p-2.5"><Scale className="w-6 h-6 text-indigo-300" /></div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Consultora Jurídica</h2>
            <p className="text-sm text-zinc-400">Orientação prática ancorada no <strong>Código de Defesa do Consumidor</strong>, súmulas do STJ e PROCON para você não se prejudicar. {base && <span className="text-zinc-500">Base: {base.normas || base.artigos} normas · v{base.versao}</span>}</p>
          </div>
        </div>

        {/* Disclaimer sempre visível */}
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-200/90">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Orientação baseada no CDC — <strong>não substitui um advogado</strong>. Em caso complexo ou litígio, procure um profissional do Direito.</span>
        </div>

        {/* Perguntas sugeridas */}
        {history.length === 0 && topics.length > 0 && (
          <div className="mt-5">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">Dúvidas comuns</div>
            <div className="flex flex-wrap gap-2">
              {topics.map((t) => (
                <button key={t.label} onClick={() => ask(t.question)} disabled={busy}
                  className="rounded-full border border-zinc-700 bg-zinc-900/50 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Consultas por tema (ADR-115 Fatia 3): onde o lojista mais tem dúvida/risco */}
        {history.length === 0 && themes && themes.total > 0 && themes.temas.length > 0 && (
          <div className="mt-5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500 mb-2"><BookOpen className="w-3.5 h-3.5" /> O que você mais consultou ({themes.total})</div>
            <div className="space-y-1.5">
              {themes.temas.map((t) => (
                <div key={t.ref} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] text-zinc-200">{t.titulo}</span>
                  <span className="shrink-0 text-[11px] text-zinc-500">{t.ref} · {t.count}×</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Histórico de consultas */}
        <div className="mt-5 space-y-4">
          {history.map((a, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600/90 px-3.5 py-2 text-sm text-white">{a.question}</div>
              </div>
              <div className="rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-indigo-300/80 mb-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Como proceder
                </div>
                <p className="text-sm text-zinc-100 whitespace-pre-line">{a.orientacao}</p>

                {a.artigos.length > 0 && (
                  <div className="mt-3 border-t border-zinc-800 pt-3">
                    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-500 mb-2"><BookOpen className="w-3.5 h-3.5" /> Base legal</div>
                    <div className="space-y-2">
                      {a.artigos.map((art) => (
                        <div key={art.ref || art.numero} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                          <div className="text-[13px] font-medium text-zinc-200">{art.ref || `Art. ${art.numero}`} — {art.titulo}</div>
                          <p className="mt-0.5 text-[12px] text-zinc-400">{art.texto}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="mt-3 text-[11px] text-amber-200/70 border-t border-zinc-800 pt-2">{a.disclaimer}</p>
              </div>
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Consultando o CDC…</div>}
          <div ref={endRef} />
        </div>

        {/* Caixa de pergunta */}
        <div className="sticky bottom-0 mt-4 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-3">
          <div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-2">
            <textarea
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }}
              rows={1} placeholder="Descreva a situação (ex.: cliente quer trocar sem defeito)…"
              className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none" />
            <button onClick={() => ask(q)} disabled={busy || q.trim().length < 3}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
