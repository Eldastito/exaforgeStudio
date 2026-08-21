import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stethoscope, Loader2, AlertTriangle, CalendarDays, Wallet, Clock, CheckCircle2, XCircle,
  Building2, PawPrint, User, Plus, Trash2, Save, Search,
} from 'lucide-react';

/**
 * Página pública do WEBAPP DO PROFISSIONAL (ADR-180 F7b). Standalone: sem login de painel,
 * sem AuthContext/useStore. O acesso é o magic-link `/profissional/:token`, trocado por uma
 * SESSÃO escopada (professional_portal) que vai como Bearer em cada chamada a
 * `/api/public/professional/*` (excluídas do injetor do token de staff). COM escrita:
 * o profissional gere a própria disponibilidade e aceita/recusa agendamentos.
 */

type Professional = { id: string; name: string; council: string; registrationNumber: string; specialties: string[] };
type ClinicLink = { organizationId: string; clinicName: string | null; relationshipId: string; status: string };
type Appt = { id: string; relationshipId: string; clinicName: string | null; start: string; end: string | null; status: string; title: string; contactName: string | null; petName: string | null };
type Totals = { count: number; gross: number | null; professionalAmount: number | null; clinicAmount: number | null; taxAmount: number | null; netProfessional: number | null; missingPrice: number };
type Finance = { currency: string; byClinic: Array<{ clinicName: string | null; relationshipId: string; realized: Totals; expected: Totals }>; totals: { realized: Totals; expected: Totals } };
type Window = { id?: string; dayOfWeek: number; start: string; end: string; bufferMin: number };

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const brl = (n: number | null | undefined) => (n == null ? '—' : `R$ ${Number(n).toFixed(2).replace('.', ',')}`);
const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--';
  try { return d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
};

function readToken(): string | null {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || last === 'profissional') return null;
  return decodeURIComponent(last);
}

export function ProfessionalPortalPage() {
  const token = useMemo(readToken, []);
  const [session, setSession] = useState<string | null>(null);
  const [prof, setProf] = useState<Professional | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [tab, setTab] = useState<'agenda' | 'finance' | 'availability' | 'discover'>('agenda');

  // Troca o magic-link por sessão.
  useEffect(() => {
    (async () => {
      if (!token) { setInvalid(true); setLoading(false); return; }
      try {
        const res = await fetch('/api/public/professional/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.session) { setInvalid(true); return; }
        setSession(json.session); setProf(json.professional);
      } catch { setInvalid(true); } finally { setLoading(false); }
    })();
  }, [token]);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api/public/professional${path}`, {
      ...init,
      headers: { ...(init?.headers || {}), Authorization: `Bearer ${session}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
    return json;
  }, [session]);

  if (loading) return <div className="min-h-screen bg-zinc-950 flex items-center justify-center"><Loader2 className="w-7 h-7 animate-spin text-violet-400" /></div>;
  if (invalid || !session || !prof) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-5">
        <div className="max-w-md text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4"><AlertTriangle className="w-6 h-6 text-amber-400" /></div>
          <h1 className="text-lg font-semibold text-zinc-100">Link inválido ou expirado</h1>
          <p className="mt-2 text-sm text-zinc-400">Este acesso não é mais válido. Peça um novo link à clínica.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <header className="mb-5">
          <p className="text-[11px] uppercase tracking-wide text-violet-400/80 flex items-center gap-1.5"><Stethoscope className="w-3.5 h-3.5" /> Meu ZapFlow</p>
          <h1 className="mt-1 text-2xl font-bold">{prof.name}</h1>
          <p className="mt-0.5 text-sm text-zinc-400">{prof.council} {prof.registrationNumber}{prof.specialties?.length ? ` · ${prof.specialties.join(', ')}` : ''}</p>
        </header>

        <nav className="flex gap-1.5 mb-5 border-b border-zinc-800">
          {([['agenda', 'Agenda', CalendarDays], ['finance', 'A receber', Wallet], ['availability', 'Disponibilidade', Clock], ['discover', 'Descobrir', Search]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm inline-flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${tab === k ? 'border-violet-500 text-violet-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </nav>

        {tab === 'agenda' && <AgendaTab api={api} />}
        {tab === 'finance' && <FinanceTab api={api} />}
        {tab === 'availability' && <AvailabilityTab api={api} />}
        {tab === 'discover' && <DiscoverTab api={api} />}

        <footer className="mt-10 pt-5 border-t border-zinc-800 text-[11px] text-zinc-600">
          Seu acesso à agenda e aos repasses das clínicas onde você atende. As alterações valem só pra sua disponibilidade.
        </footer>
      </div>
    </div>
  );
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

function AgendaTab({ api }: { api: Api }) {
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
      const d = await api(`/agenda?from=${from}&to=${to}`);
      setAppts(Array.isArray(d?.appointments) ? d.appointments : []); setErr(null);
    } catch (e: any) { setErr(e?.message || 'Falha ao carregar.'); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, verb: 'accept' | 'decline') => {
    if (verb === 'decline' && !window.confirm('Recusar este atendimento? A clínica é avisada para remarcar.')) return;
    setBusyId(id);
    try { await api(`/appointments/${id}/${verb}`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e: any) { setErr(e?.message || 'Falha.'); } finally { setBusyId(null); }
  };

  if (err) return <ErrBox msg={err} />;
  if (!appts) return <Spin />;
  if (!appts.length) return <Empty icon={CalendarDays} msg="Nenhum atendimento nos próximos dias." />;
  return (
    <div className="space-y-2.5">
      {appts.map((a) => (
        <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm"><Clock className="w-3.5 h-3.5 text-zinc-500" /><span className="font-mono text-zinc-200">{fmtDateTime(a.start)}</span><StatusChip status={a.status} /></div>
              <h3 className="mt-1 font-semibold text-zinc-100">{a.title || 'Atendimento'}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
                <span className="inline-flex items-center gap-1"><Building2 className="w-3.5 h-3.5 text-zinc-500" /> {a.clinicName || 'Clínica'}</span>
                {a.petName && <span className="inline-flex items-center gap-1"><PawPrint className="w-3.5 h-3.5 text-zinc-500" /> {a.petName}</span>}
                {a.contactName && <span className="inline-flex items-center gap-1"><User className="w-3.5 h-3.5 text-zinc-500" /> {a.contactName}</span>}
              </div>
            </div>
            {a.status === 'confirmed' && (
              <div className="flex gap-1.5 shrink-0">
                <button disabled={busyId === a.id} onClick={() => act(a.id, 'accept')} className="text-[11px] px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Confirmar</button>
                <button disabled={busyId === a.id} onClick={() => act(a.id, 'decline')} className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-rose-600/80 text-zinc-300 hover:text-white inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> Recusar</button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FinanceTab({ api }: { api: Api }) {
  const [fin, setFin] = useState<Finance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { (async () => { try { setFin(await api('/finance')); } catch (e: any) { setErr(e?.message || 'Falha.'); } })(); }, [api]);
  if (err) return <ErrBox msg={err} />;
  if (!fin) return <Spin />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <TotalsCard title="Já recebido" tone="emerald" t={fin.totals.realized} />
        <TotalsCard title="A receber" tone="violet" t={fin.totals.expected} />
      </div>
      {fin.byClinic.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">Por clínica</div>
          {fin.byClinic.map((c) => (
            <div key={c.relationshipId} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-300 inline-flex items-center gap-1.5"><Building2 className="w-4 h-4 text-zinc-500" /> {c.clinicName || 'Clínica'}</span>
              <span className="text-xs text-zinc-400">recebido <span className="text-emerald-300">{brl(c.realized.netProfessional)}</span> · a receber <span className="text-violet-300">{brl(c.expected.netProfessional)}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TotalsCard({ title, tone, t }: { title: string; tone: 'emerald' | 'violet'; t: Totals }) {
  const ring = tone === 'emerald' ? 'border-emerald-700/40' : 'border-violet-700/40';
  const val = tone === 'emerald' ? 'text-emerald-300' : 'text-violet-300';
  return (
    <div className={`rounded-xl border ${ring} bg-zinc-950/50 p-3`}>
      <div className="text-xs text-zinc-400">{title} <span className="text-zinc-600">· {t.count}</span></div>
      <div className={`mt-1 text-xl font-bold ${val}`}>{brl(t.netProfessional)}</div>
      {t.missingPrice > 0 && <div className="mt-1 text-[10px] text-amber-400/80">{t.missingPrice} sem preço combinado</div>}
    </div>
  );
}

function AvailabilityTab({ api }: { api: Api }) {
  const [clinics, setClinics] = useState<ClinicLink[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { (async () => { try { const d = await api('/overview'); setClinics(Array.isArray(d?.clinics) ? d.clinics : []); } catch (e: any) { setErr(e?.message || 'Falha.'); } })(); }, [api]);
  if (err) return <ErrBox msg={err} />;
  if (!clinics) return <Spin />;
  if (!clinics.length) return <Empty icon={Clock} msg="Nenhuma clínica ativa ainda." />;
  return <div className="space-y-4">{clinics.map((c) => <div key={c.relationshipId}><ClinicWindows api={api} clinic={c} /></div>)}</div>;
}

function ClinicWindows({ api, clinic }: { api: Api; clinic: ClinicLink }) {
  const [windows, setWindows] = useState<Window[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const d = await api(`/relationships/${clinic.relationshipId}/windows`); setWindows((Array.isArray(d) ? d : []).map((w: any) => ({ id: w.id, dayOfWeek: w.dayOfWeek, start: w.start, end: w.end, bufferMin: w.bufferMin || 0 }))); }
    catch { setWindows([]); }
  }, [api, clinic.relationshipId]);
  useEffect(() => { load(); }, [load]);

  const addRow = () => setWindows((w) => [...(w || []), { dayOfWeek: 1, start: '09:00', end: '12:00', bufferMin: 0 }]);
  const setRow = (i: number, patch: Partial<Window>) => setWindows((w) => (w || []).map((row, idx) => idx === i ? { ...row, ...patch } : row));
  const rmRow = (i: number) => setWindows((w) => (w || []).filter((_, idx) => idx !== i));
  const save = async () => {
    setBusy(true); setMsg(null);
    try { await api(`/relationships/${clinic.relationshipId}/windows`, { method: 'PUT', body: JSON.stringify({ windows: (windows || []).map((w) => ({ dayOfWeek: w.dayOfWeek, start: w.start, end: w.end, bufferMin: w.bufferMin })) }) }); setMsg('Disponibilidade salva.'); load(); }
    catch (e: any) { setMsg(e?.message === 'window_range_invalid' ? 'Horário inválido (início < fim).' : (e?.message || 'Falha ao salvar.')); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5 mb-3"><Building2 className="w-4 h-4 text-zinc-500" /> {clinic.clinicName || 'Clínica'}</div>
      {windows === null ? <Spin /> : (
        <div className="space-y-2">
          {windows.length === 0 && <div className="text-xs text-zinc-600">Sem janelas — você não recebe agendamentos aqui até definir.</div>}
          {windows.map((w, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap">
              <select value={w.dayOfWeek} onChange={(e) => setRow(i, { dayOfWeek: Number(e.target.value) })} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm">
                {DOW.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
              </select>
              <input type="time" value={w.start} onChange={(e) => setRow(i, { start: e.target.value })} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
              <span className="text-zinc-600 text-xs">até</span>
              <input type="time" value={w.end} onChange={(e) => setRow(i, { end: e.target.value })} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
              <input type="number" min={0} value={w.bufferMin} onChange={(e) => setRow(i, { bufferMin: Number(e.target.value) })} title="intervalo (min)" className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
              <button onClick={() => rmRow(i)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={addRow} className="text-xs text-zinc-300 hover:text-white inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Janela</button>
            <div className="flex items-center gap-2">
              {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
              <button onClick={save} disabled={busy} className="text-xs px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center gap-1">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Descobrir (F10b) — visibilidade + clínicas que procuram minha especialidade ──
type ClinicMatch = { organizationId: string; businessName: string | null; city: string | null; state: string | null; matchedSpecialties: string[]; distanceKm: number | null };
function DiscoverTab({ api }: { api: Api }) {
  const [profile, setProfile] = useState<{ discoverable: boolean; baseCity: string | null; baseState: string | null; specialties: string[] } | null>(null);
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [clinics, setClinics] = useState<ClinicMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, boolean>>({});

  const loadProfile = useCallback(async () => {
    try { const p = await api('/discovery-profile'); setProfile(p); setCity(p.baseCity || ''); setState(p.baseState || ''); }
    catch (e: any) { setErr(e?.message || 'Falha.'); }
  }, [api]);
  useEffect(() => { loadProfile(); }, [loadProfile]);

  const saveProfile = async (discoverable: boolean) => {
    setBusy(true);
    try { const p = await api('/discovery-profile', { method: 'PUT', body: JSON.stringify({ discoverable, baseCity: city.trim() || null, baseState: state.trim() || null }) }); setProfile(p); }
    catch (e: any) { setErr(e?.message || 'Falha.'); } finally { setBusy(false); }
  };
  const search = async () => {
    setBusy(true); setErr(null);
    try { const d = await api('/discovery/clinics'); setClinics(Array.isArray(d) ? d : []); }
    catch (e: any) { setErr(e?.message || 'Falha.'); setClinics([]); } finally { setBusy(false); }
  };
  const request = async (orgId: string) => {
    try { await api(`/discovery/clinics/${orgId}/request`, { method: 'POST', body: JSON.stringify({}) }); setRequested((r) => ({ ...r, [orgId]: true })); }
    catch (e: any) { setErr(e?.message || 'Falha.'); }
  };

  if (!profile) return err ? <ErrBox msg={err} /> : <Spin />;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
        <div className="text-sm font-semibold text-zinc-200">Minha visibilidade na rede</div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={profile.discoverable} onChange={(e) => saveProfile(e.target.checked)} disabled={busy} className="accent-violet-500" />
          Deixar clínicas me encontrarem pela minha especialidade
        </label>
        <div className="flex items-end gap-2 text-xs">
          <label className="flex flex-col gap-1"><span className="text-zinc-500">Cidade</span><input value={city} onChange={(e) => setCity(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" /></label>
          <label className="flex flex-col gap-1"><span className="text-zinc-500">UF</span><input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" /></label>
          <button onClick={() => saveProfile(profile.discoverable)} disabled={busy} className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 inline-flex items-center gap-1"><Save className="w-3.5 h-3.5" /> Salvar região</button>
        </div>
        {profile.specialties?.length ? <div className="text-[11px] text-zinc-500">Suas especialidades: <span className="text-zinc-300">{profile.specialties.join(', ')}</span></div> : <div className="text-[11px] text-amber-400/80">Cadastre suas especialidades pra aparecer no match.</div>}
      </div>

      <button onClick={search} disabled={busy} className="w-full text-sm px-3 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center justify-center gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Clínicas que procuram minha especialidade</button>
      {err && <ErrBox msg={err} />}
      {clinics && (
        clinics.length === 0 ? <Empty icon={Building2} msg="Nenhuma clínica descobrível procura sua especialidade na região." /> : (
          <div className="space-y-2">
            {clinics.map((c) => (
              <div key={c.organizationId} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-zinc-100 inline-flex items-center gap-1.5"><Building2 className="w-4 h-4 text-zinc-500" /> {c.businessName || 'Clínica'}</h3>
                  <div className="mt-1 text-[12px] text-zinc-400">{[c.city, c.state].filter(Boolean).join('/')}{c.distanceKm != null ? ` · ${c.distanceKm} km` : ''}</div>
                  <div className="mt-0.5 text-[12px] text-violet-300/80">Procura: {c.matchedSpecialties.join(', ')}</div>
                </div>
                {requested[c.organizationId] ? (
                  <span className="text-[11px] px-2 py-1 rounded bg-emerald-600/20 text-emerald-300 shrink-0">Interesse enviado</span>
                ) : (
                  <button onClick={() => request(c.organizationId)} className="text-[11px] px-2 py-1 rounded bg-violet-600/80 hover:bg-violet-500 text-white shrink-0">Tenho interesse</button>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ── átomos ──
function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = { confirmed: 'text-sky-300 bg-sky-500/10 border-sky-500/30', completed: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', cancelled: 'text-zinc-500 bg-zinc-500/10 border-zinc-700' };
  const label: Record<string, string> = { confirmed: 'Agendado', completed: 'Atendido', cancelled: 'Cancelado' };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${map[status] || map.confirmed}`}>{label[status] || status}</span>;
}
function Spin() { return <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>; }
function ErrBox({ msg }: { msg: string }) { return <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-red-400 shrink-0" /><span className="text-sm text-red-200">{msg}</span></div>; }
function Empty({ icon: Icon, msg }: { icon: any; msg: string }) { return <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40"><Icon className="w-8 h-8 text-violet-400/70 mx-auto mb-2" /><p className="text-sm text-zinc-300">{msg}</p></div>; }

export default ProfessionalPortalPage;
