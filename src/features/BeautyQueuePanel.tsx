/**
 * BeautyQueuePanel (ADR-169 F37) — Página da FILA no celular do cliente.
 *
 * Aberta quando o cliente escaneia o QR que a recepção mostra na tela. Sem
 * login: os parâmetros `beautyQueue` (id do agendamento) + `exp` + `sig`
 * (assinatura HMAC) vêm na própria URL e autorizam o acesso à rota pública
 * `/api/public/beauty/queue/:id`. A página mostra a posição na fila e vira
 * "É A SUA VEZ!" no instante em que a recepção encerra o atendimento anterior
 * e chama o cliente — o mesmo gatilho da TV (F36), mas pessoal e discreto
 * (pra salão sem TV / público seletivo).
 *
 * Ao virar a vez: pulso visual + vibração (navigator.vibrate) + bipe (Web
 * Audio) + notificação do navegador (se o cliente permitir). Tudo best-effort:
 * se o navegador bloquear, o cartão grande "É a sua vez!" já avisa.
 *
 * Visual próprio: claro, mobile-first — é o telefone do cliente, não a TV do
 * salão. Não usa os tokens de tema do app (staff); é uma tela pública.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

type QueueStatus = {
  found: boolean;
  state: 'your_turn' | 'serving' | 'waiting' | 'done' | 'no_show' | 'cancelled' | 'not_found';
  clientName: string;
  serviceName: string | null;
  professionalName: string | null;
  startTime: string | null;
  position: number | null;
  peopleAhead: number | null;
  message: string;
  date: string;
};

function readParams(): { id: string; exp: string; sig: string } {
  try {
    const q = new URLSearchParams(window.location.search);
    return { id: q.get('beautyQueue') || '', exp: q.get('exp') || '', sig: q.get('sig') || '' };
  } catch { return { id: '', exp: '', sig: '' }; }
}

export default function BeautyQueuePanel() {
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const lastStateRef = useRef<string | null>(null);
  const paramsRef = useRef(readParams());

  const load = useCallback(async () => {
    const { id, exp, sig } = paramsRef.current;
    if (!id || !exp || !sig) { setLoaded(true); return; }
    try {
      const r = await fetch(`/api/public/beauty/queue/${encodeURIComponent(id)}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`);
      const j = await r.json().catch(() => null);
      if (j) setStatus(j);
    } catch { /* mantém o último estado numa falha momentânea */ }
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);
  // Poll a cada 8s pra a "sua vez" sair quase na hora.
  useEffect(() => { const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  // Alerta quando ENTRA em "your_turn" (transição de estado, não a cada poll).
  useEffect(() => {
    const st = status?.state || null;
    if (st === 'your_turn' && lastStateRef.current !== null && lastStateRef.current !== 'your_turn') {
      try { (navigator as any).vibrate?.([300, 120, 300, 120, 300]); } catch { /* noop */ }
      try {
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          [0, 0.6].forEach((offset) => {
            const osc = ctx.createOscillator(); const gain = ctx.createGain();
            osc.type = 'sine'; osc.frequency.value = 880;
            const t0 = ctx.currentTime + offset;
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(t0); osc.stop(t0 + 0.5);
          });
        }
      } catch { /* autoplay bloqueado — o cartão grande já avisa */ }
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('É a sua vez! 💜', { body: status?.message || 'Dirija-se à recepção.' });
        }
      } catch { /* noop */ }
    }
    lastStateRef.current = st;
  }, [status?.state, status?.message]);

  const askNotify = useCallback(async () => {
    try {
      if ('Notification' in window) {
        const p = await Notification.requestPermission();
        setNotifyOn(p === 'granted');
      }
    } catch { /* noop */ }
  }, []);

  const { id, exp, sig } = paramsRef.current;
  const invalid = !id || !exp || !sig;

  // Paleta por estado.
  const isTurn = status?.state === 'your_turn';
  const bg = isTurn
    ? 'linear-gradient(160deg, #db2777 0%, #9333ea 100%)'
    : 'linear-gradient(160deg, #fdf2f8 0%, #faf5ff 60%, #f5f3ff 100%)';
  const dark = isTurn;

  return (
    <div className="min-h-screen w-full flex flex-col items-center px-5 py-8"
      style={{ background: bg, color: dark ? '#fff' : '#3b0764' }}>
      <div className="w-full max-w-md flex-1 flex flex-col">
        {/* cabeçalho */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-2xl">💇‍♀️</span>
          <span className="text-lg font-semibold tracking-wide" style={{ opacity: 0.85 }}>Sua vez na fila</span>
        </div>

        {invalid ? (
          <Card dark={dark}>
            <div className="text-xl font-bold mb-1">Link inválido</div>
            <div className="opacity-70">Peça um novo QR na recepção do salão.</div>
          </Card>
        ) : !loaded ? (
          <Card dark={dark}><div className="opacity-60">Carregando…</div></Card>
        ) : !status || status.state === 'not_found' ? (
          <Card dark={dark}>
            <div className="text-xl font-bold mb-1">Atendimento não encontrado</div>
            <div className="opacity-70">O link pode ter expirado. Fale com a recepção.</div>
          </Card>
        ) : (
          <>
            <Card dark={dark}>
              <div className="text-sm uppercase tracking-widest mb-2" style={{ opacity: 0.7 }}>
                Olá, {status.clientName}
              </div>

              {status.state === 'your_turn' ? (
                <div className="text-center py-4">
                  <div className="text-5xl font-extrabold leading-tight mb-3 animate-pulse">É a sua vez! 🎉</div>
                  <div className="text-lg opacity-90">{status.message}</div>
                </div>
              ) : status.state === 'serving' ? (
                <div>
                  <div className="text-3xl font-extrabold mb-2">Em atendimento</div>
                  <div className="opacity-80">{status.message}</div>
                </div>
              ) : status.state === 'waiting' ? (
                <div>
                  <div className="text-sm mb-1" style={{ opacity: 0.7 }}>Sua posição</div>
                  <div className="flex items-baseline gap-2 mb-3">
                    <span className="text-6xl font-extrabold tabular-nums">{status.position}</span>
                    <span className="text-xl" style={{ opacity: 0.7 }}>na fila</span>
                  </div>
                  <div className="opacity-80">{status.message}</div>
                </div>
              ) : (
                <div>
                  <div className="text-2xl font-bold mb-1">
                    {status.state === 'done' ? 'Concluído 💜' : status.state === 'no_show' ? 'Você não compareceu' : 'Cancelado'}
                  </div>
                  <div className="opacity-80">{status.message}</div>
                </div>
              )}
            </Card>

            {/* detalhes do atendimento */}
            <Card dark={dark} className="mt-4">
              <Row dark={dark} label="Serviço" value={status.serviceName || '—'} />
              <Row dark={dark} label="Profissional" value={status.professionalName || '—'} />
              <Row dark={dark} label="Horário" value={status.startTime || '—'} />
            </Card>

            {/* avisar por notificação (opt-in do cliente) */}
            {!isTurn && status.state === 'waiting' && 'Notification' in window && !notifyOn && (
              <button onClick={askNotify}
                className="mt-4 w-full rounded-2xl px-5 py-3 font-semibold"
                style={{ background: dark ? 'rgba(255,255,255,0.15)' : '#7c3aed', color: '#fff' }}>
                🔔 Me avisar quando for a minha vez
              </button>
            )}
            {notifyOn && !isTurn && (
              <div className="mt-3 text-center text-sm" style={{ opacity: 0.65 }}>
                Deixe esta página aberta — a gente te avisa. ✨
              </div>
            )}
          </>
        )}

        <div className="mt-auto pt-8 text-center text-xs" style={{ opacity: 0.5 }}>
          Atualiza automaticamente
        </div>
      </div>
    </div>
  );
}

function Card({ children, dark, className = '' }: { children: React.ReactNode; dark: boolean; className?: string }) {
  return (
    <div className={`rounded-3xl px-6 py-6 ${className}`}
      style={{
        background: dark ? 'rgba(255,255,255,0.12)' : '#fff',
        boxShadow: dark ? 'none' : '0 10px 30px -12px rgba(124,58,237,0.35)',
        border: dark ? '1px solid rgba(255,255,255,0.25)' : '1px solid rgba(124,58,237,0.10)',
      }}>
      {children}
    </div>
  );
}

function Row({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 text-base"
      style={{ borderBottom: dark ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(124,58,237,0.08)' }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span className="font-semibold text-right">{value}</span>
    </div>
  );
}
