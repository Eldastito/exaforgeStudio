/**
 * BeautyTvPanel (ADR-169 F35) — Painel de TV do salão.
 *
 * Vitrine em tela cheia pra abrir num monitor/TV do salão: mostra em letras
 * grandes "AGORA ATENDENDO" (cliente + especialista) e a fila "A SEGUIR".
 * SEM controles (não é a recepção — é só a exibição). Atualiza sozinho a
 * cada 15s. Reusa a rota autenticada `/api/beauty/reception/today` (a TV é
 * aberta no navegador já logado da recepção; nenhum endpoint público que
 * vaze a agenda).
 *
 * Privacidade (tela pública): mostra PRIMEIRO NOME + inicial do sobrenome
 * (ex.: "Emily S."), não o nome completo — suficiente pra chamar a cliente,
 * menor exposição.
 *
 * Look próprio de painel (fundo escuro, alto contraste) — não usa os tokens
 * de tema pra ficar legível de longe em qualquer tema.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { X, Maximize2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

type Appt = {
  id: string; startTime: string | null;
  clientName: string; serviceName: string | null;
  professionalName: string | null; status: string;
};
type Board = { date: string; appointments: Appt[]; nowServing: Appt[] };

/** "Emily Souza" → "Emily S." (primeiro nome + inicial do sobrenome). */
export function tvDisplayName(full: string): string {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Cliente';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export default function BeautyTvPanel({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [clock, setClock] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/beauty/reception/today');
      if (r.ok) setBoard(await r.json());
    } catch { /* mantém o último quadro em caso de falha momentânea */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  // relógio ao vivo
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // tenta entrar em tela cheia de verdade ao abrir (silencioso se o browser negar).
  useEffect(() => {
    try { (document.documentElement as any).requestFullscreen?.().catch(() => {}); } catch { /* noop */ }
    return () => { try { if (document.fullscreenElement) (document as any).exitFullscreen?.(); } catch { /* noop */ } };
  }, []);

  const serving = board?.nowServing || [];
  const upNext = (board?.appointments || [])
    .filter((a) => a.status === 'pending' || a.status === 'confirmed')
    .slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex flex-col text-white overflow-hidden"
      style={{ background: 'radial-gradient(1200px 800px at 70% -10%, #3b1a2e 0%, #0b0b12 55%, #08080c 100%)' }}>
      {/* topo */}
      <div className="flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-3">
          <span className="text-2xl">💇‍♀️</span>
          <span className="text-2xl font-semibold tracking-wide text-pink-300">Atendimentos</span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-4xl font-bold tabular-nums">{clock}</span>
          <button onClick={onClose} title="Sair do modo TV" className="text-white/40 hover:text-white/90">
            <X className="w-7 h-7" />
          </button>
        </div>
      </div>

      {/* AGORA ATENDENDO */}
      <div className="px-8 flex-1 min-h-0 flex flex-col">
        <div className="text-emerald-400 text-lg font-semibold uppercase tracking-widest mb-3">Agora atendendo</div>
        {serving.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-white/30 text-3xl">
            Nenhum atendimento em andamento
          </div>
        ) : (
          <div className={`grid gap-4 ${serving.length <= 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3'}`}>
            {serving.map((a) => (
              <div key={a.id} className="rounded-2xl px-8 py-6 bg-white/5 border border-emerald-400/30 backdrop-blur">
                <div className="text-5xl md:text-6xl font-extrabold leading-tight">{tvDisplayName(a.clientName)}</div>
                <div className="mt-3 text-2xl text-emerald-300">com <b>{a.professionalName || '—'}</b></div>
                {a.serviceName && <div className="mt-1 text-xl text-white/50">{a.serviceName}</div>}
              </div>
            ))}
          </div>
        )}

        {/* A SEGUIR */}
        {upNext.length > 0 && (
          <div className="mt-8 mb-6">
            <div className="text-pink-300 text-lg font-semibold uppercase tracking-widest mb-3">A seguir</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {upNext.map((a) => (
                <div key={a.id} className="rounded-xl px-4 py-3 bg-white/5 border border-white/10">
                  <div className="text-2xl font-bold tabular-nums text-white/90">{a.startTime || '--:--'}</div>
                  <div className="text-xl truncate">{tvDisplayName(a.clientName)}</div>
                  {a.professionalName && <div className="text-sm text-white/40 truncate">{a.professionalName}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* rodapé discreto */}
      <div className="px-8 py-3 text-white/25 text-sm flex items-center justify-between">
        <span>Atualiza automaticamente</span>
        <span className="flex items-center gap-1"><Maximize2 className="w-3 h-3" /> modo TV</span>
      </div>
    </div>
  );
}
