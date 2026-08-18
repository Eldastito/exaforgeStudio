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
import { Search, Users, Clock, RefreshCw, CheckCircle2, PlayCircle, User, Tv, QrCode, X, CalendarPlus } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import { useAuth } from '@/src/contexts/AuthContext';

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
  const { user } = useAuth();
  const { isMasterAdmin } = useStore();
  const isManager = isMasterAdmin || user?.role === 'owner' || user?.role === 'admin';
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

  // F38 — Agendar (criar a fila): cliente + profissional + serviço + horário
  const [showBook, setShowBook] = useState(false);
  const [services, setServices] = useState<{ id: string; name: string; durationMinutes: number | null }[]>([]);
  const [bkClientQ, setBkClientQ] = useState('');
  const [bkClientHits, setBkClientHits] = useState<ClientHit[]>([]);
  const [bkClient, setBkClient] = useState<ClientHit | null>(null);
  const [bkProId, setBkProId] = useState('');
  const [bkServiceId, setBkServiceId] = useState('');
  const [bkDate, setBkDate] = useState('');
  const [bkSlots, setBkSlots] = useState<string[]>([]);
  const [bkSlotsLoading, setBkSlotsLoading] = useState(false);
  const [bkSlot, setBkSlot] = useState('');
  const [bkBusy, setBkBusy] = useState(false);
  const [bkMsg, setBkMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  // Carrega os slots vagos do profissional na data escolhida (reusa Q2).
  const loadBkSlots = useCallback(async (proId: string, date: string) => {
    if (!proId || !date) { setBkSlots([]); return; }
    setBkSlotsLoading(true); setBkSlot('');
    try {
      const r = await apiFetch(`/api/beauty/reception/professional/${proId}?date=${encodeURIComponent(date)}`);
      if (r.ok) { const d = await r.json(); setBkSlots(Array.isArray(d?.freeSlots) ? d.freeSlots : []); }
      else setBkSlots([]);
    } catch { setBkSlots([]); }
    finally { setBkSlotsLoading(false); }
  }, []);

  async function doBook() {
    if (!bkClient || !bkProId || !bkSlot || !bkDate) { setBkMsg({ ok: false, text: 'Escolha cliente, profissional e horário.' }); return; }
    setBkBusy(true); setBkMsg(null);
    try {
      const startISO = `${bkDate}T${bkSlot}:00-03:00`; // BRT (UTC-3)
      const r = await apiFetch('/api/beauty/reception/appointments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: bkClient.id, professionalId: bkProId, serviceId: bkServiceId || undefined, startISO }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.ok) {
        setBkMsg({ ok: true, text: `Agendado: ${bkClient.name} às ${d.startTime} com ${d.professionalName}.` });
        setBkClient(null); setBkClientQ(''); setBkSlot('');
        await loadBoard();
        await loadBkSlots(bkProId, bkDate); // remove o slot recém-ocupado
      } else {
        setBkMsg({ ok: false, text: d?.error || 'Não foi possível agendar.' });
      }
    } catch { setBkMsg({ ok: false, text: 'Falha de rede ao agendar.' }); }
    finally { setBkBusy(false); }
  }

  // F38 — Equipe do salão (profissionais). Sem equipe cadastrada, não há quem
  // agendar; por isso o cadastro vive aqui na recepção (a "Agenda Clínica"
  // fica escondida pra beleza).
  const [team, setTeam] = useState<{ id: string; name: string; specialty: string | null }[]>([]);
  const [newProName, setNewProName] = useState('');
  const [newProSpec, setNewProSpec] = useState('');
  const [addingPro, setAddingPro] = useState(false);

  const loadTeam = useCallback(async () => {
    try {
      const r = await apiFetch('/api/beauty/reception/team');
      if (r.ok) { const d = await r.json(); setTeam(Array.isArray(d?.team) ? d.team : []); }
    } catch { /* silencioso */ }
  }, []);

  async function addPro() {
    const name = newProName.trim();
    if (!name) return;
    setAddingPro(true); setBkMsg(null);
    try {
      const r = await apiFetch('/api/beauty/reception/professionals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, specialty: newProSpec.trim() || undefined }),
      });
      const d = await r.json().catch(() => null);
      if (r.ok && d?.ok) { setNewProName(''); setNewProSpec(''); await loadTeam(); await loadBoard(); }
      else setBkMsg({ ok: false, text: d?.error || 'Não foi possível cadastrar o profissional.' });
    } catch { setBkMsg({ ok: false, text: 'Falha de rede ao cadastrar.' }); }
    finally { setAddingPro(false); }
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

  // F38 — serviços do salão (dropdown do agendamento), uma vez.
  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch('/api/beauty/reception/services');
        if (r.ok) { const d = await r.json(); setServices(Array.isArray(d?.services) ? d.services : []); }
      } catch { /* silencioso */ }
    })();
  }, []);
  // data default do agendamento = dia do board
  useEffect(() => { if (board?.date && !bkDate) setBkDate(board.date); }, [board?.date, bkDate]);
  // busca do cliente no agendamento (debounce)
  useEffect(() => {
    const term = bkClientQ.trim();
    if (!term || bkClient) { setBkClientHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await apiFetch(`/api/beauty/reception/clients?q=${encodeURIComponent(term)}`);
        if (r.ok) { const d = await r.json(); setBkClientHits(Array.isArray(d?.clients) ? d.clients : []); }
      } catch { /* silencioso */ }
    }, 300);
    return () => clearTimeout(t);
  }, [bkClientQ, bkClient]);
  // recarrega horários vagos quando muda profissional/data
  useEffect(() => { if (showBook && bkProId && bkDate) loadBkSlots(bkProId, bkDate); }, [showBook, bkProId, bkDate, loadBkSlots]);
  // equipe do salão (uma vez)
  useEffect(() => { loadTeam(); }, [loadTeam]);

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
          <button onClick={() => { setShowBook((v) => !v); setBkMsg(null); }} title="Agendar um atendimento (cria a fila)"
            className={`text-xs flex items-center gap-1 px-2 py-1 rounded ${showBook ? 'bg-fuchsia-500 text-white' : 'bg-fuchsia-500/15 text-fuchsia-500 hover:bg-fuchsia-500/25'}`}>
            <CalendarPlus className="w-3 h-3" /> Agendar
          </button>
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

      {/* F38 — Agendar atendimento (cria a fila) */}
      {showBook && (
        <div className="p-3 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}>
          <p className="text-sm font-medium mb-2 flex items-center gap-1"><CalendarPlus className="w-4 h-4 text-fuchsia-500" /> Agendar atendimento</p>

          {/* Equipe do salão — cadastrar profissional (dono/admin) */}
          <div className="mb-3 p-2 rounded border" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-xs font-medium text-slate-500 flex items-center gap-1"><Users className="w-3 h-3" /> Equipe do salão ({team.length})</span>
            {team.length > 0 ? (
              <div className="flex flex-wrap gap-1 mt-1">
                {team.map((p) => (
                  <span key={p.id} className="px-2 py-0.5 rounded-full border text-[10px]" style={{ borderColor: 'var(--color-border)' }}>
                    {p.name}{p.specialty ? ` · ${p.specialty}` : ''}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 mt-1">Nenhum profissional cadastrado ainda{isManager ? ' — adicione abaixo.' : '. Peça ao dono pra cadastrar.'}</div>
            )}
            {isManager && (
              <div className="flex gap-1 mt-2">
                <input value={newProName} onChange={(e) => setNewProName(e.target.value)} placeholder="Nome do profissional"
                  className="flex-1 min-w-0 p-1.5 rounded border bg-transparent text-xs" style={{ borderColor: 'var(--color-border)' }} />
                <input value={newProSpec} onChange={(e) => setNewProSpec(e.target.value)} placeholder="Especialidade (opcional)"
                  className="flex-1 min-w-0 p-1.5 rounded border bg-transparent text-xs" style={{ borderColor: 'var(--color-border)' }} />
                <button onClick={addPro} disabled={addingPro || !newProName.trim()}
                  className="px-3 rounded bg-fuchsia-500 text-white text-xs font-semibold disabled:opacity-40">{addingPro ? '…' : 'Adicionar'}</button>
              </div>
            )}
          </div>

          {/* cliente */}
          <label className="text-xs text-slate-500">Cliente</label>
          {bkClient ? (
            <div className="mt-1 flex items-center justify-between p-2 rounded border text-sm" style={{ borderColor: 'var(--color-border)' }}>
              <span className="flex items-center gap-2"><User className="w-3 h-3 text-slate-400" /> {bkClient.name}</span>
              <button onClick={() => { setBkClient(null); setBkClientQ(''); }} className="text-xs text-slate-500 hover:text-pink-500">trocar</button>
            </div>
          ) : (
            <>
              <input value={bkClientQ} onChange={(e) => setBkClientQ(e.target.value)} placeholder="Buscar cliente por nome/telefone…"
                className="w-full mt-1 p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }} />
              {bkClientQ.trim() && bkClientHits.length > 0 && (
                <div className="mt-1 rounded border divide-y max-h-32 overflow-y-auto" style={{ borderColor: 'var(--color-border)' }}>
                  {bkClientHits.map((c) => (
                    <button key={c.id} onClick={() => { setBkClient(c); setBkClientHits([]); }} className="w-full text-left p-2 text-sm hover:bg-pink-500/5">
                      {c.name}{c.phone && <span className="text-xs text-slate-500"> · {c.phone}</span>}
                    </button>
                  ))}
                </div>
              )}
              {bkClientQ.trim() && bkClientHits.length === 0 && (
                <div className="mt-1 text-xs text-slate-500">Nenhuma cliente encontrada — cadastre em "Nova cliente" (aba Consulta) antes.</div>
              )}
            </>
          )}

          {/* profissional + serviço */}
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="text-xs text-slate-500">Profissional</label>
              <select value={bkProId} onChange={(e) => setBkProId(e.target.value)} className="w-full mt-1 p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}>
                <option value="">Escolher…</option>
                {team.map((p) => <option key={p.id} value={p.id}>{p.name}{p.specialty ? ` · ${p.specialty}` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Serviço (opcional)</label>
              <select value={bkServiceId} onChange={(e) => setBkServiceId(e.target.value)} className="w-full mt-1 p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}>
                <option value="">— sem serviço —</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}{s.durationMinutes ? ` (${s.durationMinutes}min)` : ''}</option>)}
              </select>
            </div>
          </div>

          {/* data */}
          <div className="mt-2">
            <label className="text-xs text-slate-500">Data</label>
            <input type="date" value={bkDate} onChange={(e) => setBkDate(e.target.value)} className="w-full mt-1 p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }} />
          </div>

          {/* horários vagos */}
          <div className="mt-2">
            <label className="text-xs text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" /> Horário</label>
            {!bkProId ? <div className="text-xs text-slate-500 mt-1">Escolha um profissional pra ver os horários vagos.</div>
              : bkSlotsLoading ? <div className="text-xs text-slate-500 mt-1">Carregando horários…</div>
              : bkSlots.length === 0 ? <div className="text-xs text-slate-500 mt-1">Sem horário vago nesse dia.</div>
              : (
              <div className="flex flex-wrap gap-1 mt-1">
                {bkSlots.map((s) => (
                  <button key={s} onClick={() => setBkSlot(s)}
                    className={`px-2 py-1 rounded-full border text-xs ${bkSlot === s ? 'bg-fuchsia-500 text-white border-fuchsia-500' : ''}`}
                    style={{ borderColor: bkSlot === s ? undefined : 'var(--color-border)' }}>{s}</button>
                ))}
              </div>
            )}
          </div>

          {bkMsg && <div className={`text-xs mt-2 ${bkMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>{bkMsg.text}</div>}
          <button onClick={doBook} disabled={bkBusy || !bkClient || !bkProId || !bkSlot}
            className="mt-3 w-full rounded-lg px-3 py-2 text-sm font-semibold bg-fuchsia-500 text-white disabled:opacity-40">
            {bkBusy ? 'Agendando…' : 'Agendar e adicionar à fila'}
          </button>
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
