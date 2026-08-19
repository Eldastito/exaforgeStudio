/**
 * HelpOrb — Tutor de Ajuda (ADR-179 F1 + F3). Botão flutuante "Precisa de ajuda?"
 * que abre um chat simples de dúvida→resposta. É o Fala Tu respondendo (RN-UX-1) —
 * NÃO é um 2º motor de chat: consome `POST /api/ux/help`, que aterra a resposta na
 * base de ajuda CURADA (com citação) ou admite honestamente quando não há cobertura.
 *
 * F3: contextual (sugestões da tela atual via /help/suggestions), acionável
 * ("Abrir tela" faz deep-link quando a resposta aponta um módulo/superfície) e
 * feedback 👍/👎 por resposta (/help/feedback). Funciona SEM `falatu_enabled`.
 */
import { useState, useRef, useEffect, type FormEvent, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { apiFetch } from '@/src/lib/api';

interface HelpArticle {
  id: string;
  title: string;
  moduleKey: string | null;
  steps: string[];
  commonErrors: string[];
  sourceRef: string | null;
  mediaUrl?: string | null;
}
interface HelpResponse {
  intent: string;
  message: string;
  article: HelpArticle | null;
  gapLogged: boolean;
  navTarget?: { key: string; label: string; available: boolean } | null;
}
interface Turn { q: string; a: HelpResponse | null; error?: boolean; vote?: 'up' | 'down' }
interface Suggestion { id: string; title: string; moduleKey: string | null; what: string | null }
interface Tour { articleId: string; title: string; steps: string[]; mediaUrl: string | null }
interface Tip { articleId: string; title: string; moduleKey: string | null; what: string | null; mediaUrl: string | null }

// Tela (viewMode) ↔ módulo da base de ajuda (module_key). Só o necessário p/ dar
// contexto e navegar; telas fora do mapa simplesmente não empurram sugestão nem botão.
const VIEW_TO_MODULE: Record<string, string> = {
  saude: 'central_saude', diretor: 'diretor', vendas: 'vendas', retailfloor: 'retail_floor',
  compras: 'compras', agenda: 'agenda', catalog: 'catalogo', campanhas: 'campanhas',
  clinica: 'clinica', studio: 'estudio',
};
const MODULE_TO_VIEW: Record<string, string> = {
  central_saude: 'saude', diretor: 'diretor', vendas: 'vendas', retail_floor: 'retailfloor',
  compras: 'compras', agenda: 'agenda', catalogo: 'catalog', campanhas: 'campanhas',
  clinica: 'clinica', estudio: 'studio',
  // superfícies de navegação ("onde fica…")
  hoje: 'saude', resultados: 'reports', empresa: 'settings',
};

export function HelpOrb({ moduleKey, onNavigate }: { moduleKey?: string | null; onNavigate?: (viewMode: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [tour, setTour] = useState<Tour | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null); // null = não está no tour
  const [hidden, setHidden] = useState(false);          // orb dispensado (some o balão)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // canto do balão (px)
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  posRef.current = pos; // sempre a posição atual (o pointerup lê daqui, sem stale closure)
  const BTN = 48; const MARGIN = 20;

  const ctxModule = (moduleKey && VIEW_TO_MODULE[moduleKey]) || null; // tela atual → module_key

  // Posição inicial (canto inferior direito) + restaura a última posição escolhida.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('zf_help_orb_pos');
      if (saved) { const p = JSON.parse(saved); if (typeof p?.x === 'number' && typeof p?.y === 'number') { setPos(clampPos(p.x, p.y)); return; } }
    } catch { /* noop */ }
    setPos({ x: window.innerWidth - BTN - MARGIN, y: window.innerHeight - BTN - MARGIN });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clampPos(x: number, y: number) {
    const maxX = (typeof window !== 'undefined' ? window.innerWidth : 1200) - BTN - 8;
    const maxY = (typeof window !== 'undefined' ? window.innerHeight : 800) - BTN - 8;
    return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
  }
  function onOrbPointerDown(e: ReactPointerEvent) {
    if (!pos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, startX: e.clientX, startY: e.clientY, moved: false };
  }
  function onOrbPointerMove(e: ReactPointerEvent) {
    const d = drag.current; if (!d) return;
    if (Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4) d.moved = true;
    setPos(clampPos(e.clientX - d.dx, e.clientY - d.dy));
  }
  function onOrbPointerUp() {
    const moved = drag.current?.moved;
    drag.current = null;
    if (moved) { try { if (posRef.current) localStorage.setItem('zf_help_orb_pos', JSON.stringify(posRef.current)); } catch { /* noop */ } }
    else setOpen((v) => !v); // clique sem arrastar = abre/fecha
  }

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, open]);

  // Ao abrir (ou trocar de tela): sugestões + tour da tela + dica "aprenda 1 coisa".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const q = ctxModule ? `?module=${encodeURIComponent(ctxModule)}` : '';
    apiFetch(`/api/ux/help/suggestions${q}`).then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d) => { if (alive) setSuggestions(Array.isArray(d?.suggestions) ? d.suggestions : []); }).catch(() => { if (alive) setSuggestions([]); });
    apiFetch(`/api/ux/help/tour${q}`).then((r) => (r.ok ? r.json() : { tour: null }))
      .then((d) => { if (alive) setTour(d?.tour || null); }).catch(() => { if (alive) setTour(null); });
    apiFetch('/api/ux/help/learn-one').then((r) => (r.ok ? r.json() : { tip: null }))
      .then((d) => { if (alive) setTip(d?.tip || null); }).catch(() => { if (alive) setTip(null); });
    return () => { alive = false; };
  }, [open, ctxModule]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setText('');
    setBusy(true);
    setTurns((t) => [...t, { q, a: null }]);
    try {
      const r = await apiFetch('/api/ux/help', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: q, moduleKey: ctxModule }),
      });
      const data = r.ok ? (await r.json()) as HelpResponse : null;
      setTurns((t) => t.map((it, i) => (i === t.length - 1 ? { ...it, a: data, error: !data } : it)));
    } catch {
      setTurns((t) => t.map((it, i) => (i === t.length - 1 ? { ...it, a: null, error: true } : it)));
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (e?: FormEvent) => { e?.preventDefault(); ask(text.trim()); };

  // "Me mostra onde": módulo do artigo (ou superfície do navTarget) → viewMode.
  function navFor(a: HelpResponse): { viewMode: string; label: string } | null {
    const artMod = a.article?.moduleKey;
    if (artMod && MODULE_TO_VIEW[artMod]) return { viewMode: MODULE_TO_VIEW[artMod], label: a.article!.title };
    const nk = a.navTarget?.key;
    if (a.navTarget?.available && nk && MODULE_TO_VIEW[nk]) return { viewMode: MODULE_TO_VIEW[nk], label: a.navTarget!.label };
    return null;
  }
  function goTo(viewMode: string) { onNavigate?.(viewMode); setOpen(false); }

  async function vote(idx: number, helpful: boolean) {
    const turn = turns[idx];
    if (!turn?.a || turn.vote) return;
    setTurns((t) => t.map((it, i) => (i === idx ? { ...it, vote: helpful ? 'up' : 'down' } : it)));
    try {
      await apiFetch('/api/ux/help/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: turn.a.article?.id || null, moduleKey: ctxModule, helpful }),
      });
    } catch { /* silencioso — voto é best-effort */ }
  }

  if (pos === null) return null; // aguarda posicionamento inicial (evita flash em 0,0)

  // Orb dispensado → deixa uma aba mínima pra reabrir (nunca some de vez).
  if (hidden) {
    return (
      <button onClick={() => setHidden(false)} title="Mostrar ajuda"
        className="fixed bottom-3 right-3 z-40 text-[11px] px-2.5 py-1 rounded-full bg-zinc-800/70 backdrop-blur-sm text-zinc-300 hover:bg-zinc-700 shadow">
        ? Ajuda
      </button>
    );
  }

  // Painel abre no lado com mais espaço (acima/abaixo, esquerda/direita do balão),
  // acompanhando o orb pra onde ele for arrastado.
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const openUp = pos.y > winH / 2;
  const alignRight = pos.x > winW / 2;
  const panelStyle: CSSProperties = {
    ...(alignRight ? { right: winW - (pos.x + BTN) } : { left: pos.x }),
    ...(openUp ? { bottom: winH - pos.y + 8 } : { top: pos.y + BTN + 8 }),
  };

  return (
    <>
      <button
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={onOrbPointerUp}
        style={{ left: pos.x, top: pos.y, touchAction: 'none' }}
        aria-label="Precisa de ajuda? (arraste para mover)"
        className="fixed z-40 h-12 w-12 rounded-full bg-indigo-600/70 hover:bg-indigo-600/90 backdrop-blur-sm text-white shadow-lg flex items-center justify-center text-xl transition-colors cursor-grab active:cursor-grabbing select-none"
        title="Precisa de ajuda? (arraste para mover)"
      >
        {open ? '×' : '?'}
      </button>

      {open && (
        // 70% cor / 30% transparência + desfoque: não cobre por completo os campos
        // atrás. Posicionado junto ao balão (segue quando arrastado).
        <div style={panelStyle} className="fixed z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-zinc-700/50 bg-zinc-900/70 backdrop-blur-md shadow-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-700/40 flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Precisa de ajuda?</div>
              <div className="text-xs text-zinc-500">Pergunte como fazer algo — respondo com base na documentação.</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => setOpen(false)} title="Fechar" className="text-zinc-400 hover:text-zinc-100 text-lg leading-none px-1">×</button>
              <button onClick={() => { setOpen(false); setHidden(true); }} title="Ocultar ajuda" className="text-[10px] text-zinc-500 hover:text-zinc-300">ocultar</button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 max-h-80 overflow-y-auto px-4 py-3 space-y-3">
            {/* Tour contextual (F5) — passos do artigo da tela como walkthrough */}
            {tourStep !== null && tour && (
              <div className="rounded-lg border border-indigo-800/50 bg-indigo-950/20 px-3 py-3">
                <div className="text-[11px] text-indigo-300 mb-1">Tour · {tour.title} · passo {tourStep + 1}/{tour.steps.length}</div>
                {tour.mediaUrl && tourStep === 0 && <img src={tour.mediaUrl} alt={tour.title} loading="lazy" className="mb-2 w-full rounded-lg border border-zinc-700" />}
                <div className="text-sm text-zinc-100">{tour.steps[tourStep]}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => setTourStep((s) => (s! > 0 ? s! - 1 : s))} disabled={tourStep === 0}
                    className="text-[12px] rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 px-2.5 py-1">Voltar</button>
                  {tourStep < tour.steps.length - 1 ? (
                    <button onClick={() => setTourStep((s) => s! + 1)} className="text-[12px] rounded bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1">Próximo</button>
                  ) : (
                    <button onClick={() => setTourStep(null)} className="text-[12px] rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1">Concluir</button>
                  )}
                  <button onClick={() => setTourStep(null)} className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300">Fechar tour</button>
                </div>
              </div>
            )}

            {turns.length === 0 && tourStep === null && (
              <div className="space-y-2.5">
                {/* Aprenda 1 coisa (F5) */}
                {tip && (
                  <button onClick={() => ask(`o que é ${tip.title}?`)}
                    className="w-full text-left rounded-lg border border-amber-800/40 bg-amber-950/10 hover:bg-amber-950/20 px-3 py-2">
                    <div className="text-[11px] text-amber-300">💡 Aprenda 1 coisa</div>
                    <div className="text-[13px] text-zinc-200">{tip.title}</div>
                  </button>
                )}
                {/* Tour da tela (F5) */}
                {tour && (
                  <button onClick={() => setTourStep(0)}
                    className="w-full text-left rounded-lg border border-indigo-800/40 bg-indigo-950/10 hover:bg-indigo-950/20 px-3 py-2 text-[13px] text-indigo-200">
                    ▶ Fazer o tour desta tela ({tour.steps.length} passos)
                  </button>
                )}
                {suggestions.length > 0 ? (
                  <>
                    <div className="text-xs text-zinc-500">Sobre esta tela:</div>
                    <div className="flex flex-col gap-1.5">
                      {suggestions.map((s) => (
                        <button key={s.id} onClick={() => ask(`o que é ${s.title}?`)}
                          className="text-left rounded-lg border border-zinc-800 bg-zinc-800/40 hover:bg-zinc-800 px-3 py-2 text-[13px] text-zinc-200">
                          {s.title}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-zinc-500">
                    Ex.: <em>"como funciona a Central de Saúde?"</em>, <em>"como faço a reposição de estoque?"</em>
                  </div>
                )}
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
                    {t.a.article?.mediaUrl && (
                      <img src={t.a.article.mediaUrl} alt={t.a.article.title} loading="lazy" className="mt-2 w-full rounded-lg border border-zinc-700" />
                    )}
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
                    {/* Ações: deep-link + feedback */}
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      {(() => { const n = navFor(t.a!); return n ? (
                        <button onClick={() => goTo(n.viewMode)} className="text-[11px] rounded bg-indigo-600/80 hover:bg-indigo-600 text-white px-2 py-1">Abrir tela →</button>
                      ) : null; })()}
                      <div className="ml-auto flex items-center gap-1">
                        {t.vote ? (
                          <span className="text-[11px] text-zinc-500">{t.vote === 'up' ? 'Valeu! 👍' : 'Obrigado pelo retorno.'}</span>
                        ) : (
                          <>
                            <button onClick={() => vote(i, true)} title="Ajudou" className="text-sm hover:scale-110 transition-transform">👍</button>
                            <button onClick={() => vote(i, false)} title="Não ajudou" className="text-sm hover:scale-110 transition-transform">👎</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          <form onSubmit={onSubmit} className="p-3 border-t border-zinc-800 flex gap-2">
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
