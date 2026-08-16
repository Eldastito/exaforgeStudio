/**
 * BeautyReceptionPanel (ADR-169 F34) — Painel da Recepção.
 *
 * Superfície de fácil acesso pra recepção do salão, respondendo às 4 perguntas
 * do dono: buscar cliente antes de cadastrar, buscar profissional (agenda +
 * horários vagos), ver a agenda do dia em TEMPO REAL (quem atende quem) e quem
 * está trabalhando. Consome as rotas `/api/beauty/reception/*` (F34).
 *
 * Auto-refresh a cada 20s pra "tempo real" (quem entrou/saiu de atendimento).
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Search, Users, Clock, RefreshCw, CheckCircle2, PlayCircle, User, Tv, QrCode, X } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

// F36 — abre o Painel de TV numa JANELA SEPARADA (mesma sessão) pra arrastar
// pro monitor extra. NÃO sequestra a tela da recepção (era o problema do F35).
function openTvWindow() {
  const url = `${window.location.pathname}?beautyTv=1`;
  window.open(url, 'beautyTvSalao', 'width=1400,height=800,menubar=no,toolbar=no');
}

type Appt = {
  id: string; startTime: string | null; endTime: string | null;
  clientName: string; serviceName: string | null;
  professionalId: string | null; professionalName: string | null;
  status: string; statusLabel: string;
};
type Pro = { id: string; name: string; specialty: string | null; working: boolean; bookedToday: number; serving: Appt | null };
type Board = {
  date: string; appointments: Appt[]; nowServing: Appt[]; professionals: Pro[];
  counts: { total: number; waiting: number; inProgress: number; done: number; noShow: number };
};
type ClientHit = { id: string; name: string; phone: string | null; hasProfile: boolean };

const STATUS_COLOR: Record<string, string> = {
  in_progress: 'text-emerald-500 bg-emerald-500/10',
  completed: 'text-slate-400 bg-slate-500/10',
  confirmed: 'text-blue-500 bg-blue-500/10',
  pending: 'text-amber-500 bg-amber-500/10',
  no_show: 'text-red-500 bg-red-500/10',
};

export default function BeautyReceptionPanel() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Busca de cliente
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);

  // Profissional selecionado
  const [proDay, setProDay] = useState<{ professional: { name: string } | null; appointments: Appt[]; freeSlots: string[] } | null>(null);

  // F37 — QR da fila virtual (aviso "é a sua vez" no celular do cliente)
  const [qrModal, setQrModal] = useState<{ appt: Appt; url: string; qr: string | null } | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  async function openQr(appt: Appt) {
    setQrLoading(true);
    setQrModal({ appt, url: '', qr: null });
    try {
      const r = await apiFetch(`/api/beauty/reception/appointments/${appt.id}/queue-link`);
      if (r.ok) { const d = await r.json(); setQrModal({ appt, url: d.url || '', qr: d.qr || null }); }
      else setQrModal(null);
    } catch { setQrModal(null); }
    finally { setQrLoading(false); }
  }

  const loadBoard = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/beauty/reception/today');
      if (r.ok) setBoard(await r.json());
      else setErr('Falha ao carregar a agenda do dia.');
    } catch { setErr('Falha ao carregar a agenda do dia.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadBoard(); }, [loadBoard]);
  // tempo real: recarrega a cada 20s
  useEffect(() => {
    const t = setInterval(loadBoard, 20000);
    return () => clearInterval(t);
  }, [loadBoard]);

  // busca de cliente com debounce simples
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/beauty/reception/clients?q=${encodeURIComponent(term)}`);
        if (r.ok) { const d = await r.json(); setHits(Array.isArray(d?.clients) ? d.clients : []); }
      } catch { /* silencioso */ }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function openPro(id: string) {
    try {
      const r = await apiFetch(`/api/beauty/reception/professional/${id}`);
      if (r.ok) setProDay(await r.json());
    } catch { /* noop */ }
  }

  async function setStatus(apptId: string, status: string) {
    try {
      const r = await apiFetch(`/api/beauty/reception/appointments/${apptId}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      if (r.ok) await loadBoard();
    } catch { /* noop */ }
  }

  const badge = (s: string, label: string) => (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLOR[s] || 'text-slate-400 bg-slate-500/10'}`}>{label}</span>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2"><Users className="w-4 h-4" /> Painel da Recepção</h2>
        <div className="flex items-center gap-3">
          <button onClick={openTvWindow} title="Abre numa janela separada pra arrastar pro monitor do salão"
            className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-pink-500/15 text-pink-500 hover:bg-pink-500/25">
            <Tv className="w-3 h-3" /> Abrir Modo TV
          </button>
          <button onClick={loadBoard} disabled={loading} className="text-xs flex items-center gap-1 text-slate-500 hover:text-pink-500 disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </div>
      </div>
      {err && <div className="text-xs text-red-500">{err}</div>}

      {/* Contadores do dia */}
      {board && (
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { n: board.counts.total, l: 'Agendados' },
            { n: board.counts.inProgress, l: 'Em atendimento', c: 'text-emerald-500' },
            { n: board.counts.waiting, l: 'Aguardando', c: 'text-amber-500' },
            { n: board.counts.done, l: 'Finalizados', c: 'text-slate-400' },
          ].map((x, i) => (
            <div key={i} className="p-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <div className={`text-xl font-bold ${x.c || ''}`}>{x.n}</div>
              <div className="text-[10px] text-slate-500">{x.l}</div>
            </div>
          ))}
        </div>
      )}

      {/* Q1 — Buscar cliente antes de cadastrar */}
      <div>
        <label className="text-xs text-slate-500 flex items-center gap-1"><Search className="w-3 h-3" /> Buscar cliente (nome ou telefone)</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Digite pra ver se já tem cadastro…"
          className="w-full mt-1 p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }} />
        {q.trim() && (
          <div className="mt-1 rounded border divide-y max-h-48 overflow-y-auto" style={{ borderColor: 'var(--color-border)' }}>
            {hits.length === 0 && <div className="p-2 text-xs text-slate-500">Nenhuma cliente encontrada — pode cadastrar como nova.</div>}
            {hits.map((c) => (
              <div key={c.id} className="p-2 flex items-center justify-between text-sm">
                <span className="flex items-center gap-2"><User className="w-3 h-3 text-slate-400" /> {c.name} {c.phone && <span className="text-xs text-slate-500">· {c.phone}</span>}</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">já cadastrada{c.hasProfile ? ' · com ficha' : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Q3 — Agora atendendo (tempo real) */}
      {board && board.nowServing.length > 0 && (
        <div>
          <p className="text-xs font-medium text-emerald-500 mb-1">Em atendimento agora</p>
          <div className="space-y-1">
            {board.nowServing.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-sm">
                <span><b>{a.clientName}</b> <span className="text-slate-500">· {a.serviceName || 'atendimento'}</span> <span className="text-emerald-500">com {a.professionalName || '—'}</span></span>
                <button onClick={() => setStatus(a.id, 'completed')} className="text-xs flex items-center gap-1 text-slate-500 hover:text-pink-500">
                  <CheckCircle2 className="w-3 h-3" /> Finalizar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Q4 — Profissionais do dia (clique → agenda + horários vagos) */}
      {board && (
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1">Profissionais</p>
          <div className="flex flex-wrap gap-2">
            {board.professionals.map((p) => (
              <button key={p.id} onClick={() => openPro(p.id)}
                className={`px-3 py-1.5 rounded-lg border text-sm flex items-center gap-2 hover:bg-pink-500/5 ${p.serving ? 'border-emerald-500/40' : ''}`}
                style={{ borderColor: p.serving ? undefined : 'var(--color-border)' }}>
                <span className={`w-2 h-2 rounded-full ${p.working ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                {p.name}
                <span className="text-[10px] text-slate-500">{p.working ? `${p.bookedToday} hoje` : 'sem agenda'}</span>
              </button>
            ))}
            {board.professionals.length === 0 && <span className="text-xs text-slate-500">Nenhum profissional cadastrado.</span>}
          </div>
        </div>
      )}

      {/* Q2 — Detalhe do profissional selecionado */}
      {proDay?.professional && (
        <div className="p-3 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">{proDay.professional.name} — hoje</p>
            <button onClick={() => setProDay(null)} className="text-xs text-slate-500 hover:text-pink-500">fechar</button>
          </div>
          <div className="space-y-1 mb-2">
            {proDay.appointments.length === 0 && <p className="text-xs text-slate-500">Sem agendamentos hoje.</p>}
            {proDay.appointments.map((a) => (
              <div key={a.id} className="flex items-center justify-between text-sm">
                <span><span className="text-slate-500">{a.startTime}</span> · {a.clientName} <span className="text-slate-500">· {a.serviceName}</span></span>
                <span className="flex items-center gap-2">
                  {badge(a.status, a.statusLabel)}
                  {(a.status === 'pending' || a.status === 'confirmed') && (
                    <button onClick={() => setStatus(a.id, 'in_progress')} title="Iniciar atendimento" className="text-emerald-500 hover:opacity-70"><PlayCircle className="w-4 h-4" /></button>
                  )}
                  {a.status === 'in_progress' && (
                    <button onClick={() => setStatus(a.id, 'completed')} title="Finalizar" className="text-slate-400 hover:opacity-70"><CheckCircle2 className="w-4 h-4" /></button>
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Horários vagos:</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {proDay.freeSlots.length === 0 && <span className="text-xs text-slate-500">Sem horário vago hoje.</span>}
            {proDay.freeSlots.map((s) => (
              <span key={s} className="px-2 py-0.5 rounded-full border text-[10px]" style={{ borderColor: 'var(--color-border)' }}>{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* Agenda completa do dia */}
      {board && (
        <div>
          <p className="text-xs font-medium text-slate-500 mb-1">Agenda de hoje ({board.date})</p>
          <div className="rounded border divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {board.appointments.length === 0 && <div className="p-2 text-xs text-slate-500">Nenhum agendamento hoje.</div>}
            {board.appointments.map((a) => (
              <div key={a.id} className="p-2 flex items-center justify-between text-sm gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-slate-500">{a.startTime}</span> · <b>{a.clientName}</b>
                  <span className="text-slate-500"> · {a.serviceName}</span>
                  {a.professionalName && <span className="text-slate-500"> · {a.professionalName}</span>}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {badge(a.status, a.statusLabel)}
                  {a.status !== 'completed' && a.status !== 'no_show' && (
                    <button onClick={() => openQr(a)} title="QR da fila — avisar o cliente no celular" className="text-fuchsia-500 hover:opacity-70"><QrCode className="w-4 h-4" /></button>
                  )}
                  {(a.status === 'pending' || a.status === 'confirmed') && (
                    <button onClick={() => setStatus(a.id, 'in_progress')} title="Iniciar atendimento" className="text-emerald-500 hover:opacity-70"><PlayCircle className="w-4 h-4" /></button>
                  )}
                  {a.status === 'in_progress' && (
                    <button onClick={() => setStatus(a.id, 'completed')} title="Finalizar" className="text-slate-400 hover:opacity-70"><CheckCircle2 className="w-4 h-4" /></button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* F37 — Modal do QR da fila: o cliente escaneia e acompanha a vez no celular */}
      {qrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setQrModal(null)}>
          <div className="w-full max-w-sm rounded-2xl p-6 text-center" style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold flex items-center gap-1"><QrCode className="w-4 h-4 text-fuchsia-500" /> Fila no celular</span>
              <button onClick={() => setQrModal(null)} className="text-slate-400 hover:text-pink-500"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3"><b>{qrModal.appt.clientName}</b> aponta a câmera do celular pra este QR e acompanha a vez — o celular avisa quando for a hora.</p>
            {qrLoading || !qrModal.qr ? (
              <div className="h-64 flex items-center justify-center text-xs text-slate-500">{qrLoading ? 'Gerando QR…' : 'Não foi possível gerar o QR.'}</div>
            ) : (
              <img src={qrModal.qr} alt="QR da fila" className="mx-auto rounded-lg bg-white p-2" style={{ width: 256, height: 256 }} />
            )}
            {qrModal.url && (
              <p className="mt-3 text-[10px] text-slate-500 break-all">{qrModal.url}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
