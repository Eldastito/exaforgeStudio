import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stethoscope, Clock, DoorOpen, ShieldCheck, Timer, Printer, AlertTriangle, Loader2, CalendarDays,
} from 'lucide-react';

// Página pública do Portal do Profissional (Fase D2). Standalone: sem login,
// sem AuthContext/useStore, sem apiFetch. Consulta apenas /api/public/clinic/*
// (que NÃO recebe o token do painel). READ-ONLY — o profissional só consulta a
// sua agenda do dia.

// ---- Tipos (espelham o contrato de /api/public/clinic/portal/:token) ----
type OverrunState = 'idle' | 'on_time' | 'near_end' | 'over_time' | 'done';
type ContinuationStatus = 'pending' | 'continue' | 'finish' | 'reschedule' | null;
type ApptStatus = 'confirmed' | 'arrived' | 'in_care' | 'completed' | 'cancelled' | 'no_show';

type PortalAppointment = {
  id: string;
  time: string; // ISO
  patient_name: string;
  room: string | null;
  procedure: string | null;
  plan: string | null;
  status: ApptStatus;
  duration_minutes: number | null;
  effective_end: string | null; // ISO | null
  overrun_state: OverrunState;
  warning_minutes: number | null;
  checkin_at: string | null;
  care_started_at: string | null;
  continuation_status: ContinuationStatus;
};

type PortalPayload = {
  professional: { name: string; specialty: string | null; color: string | null };
  date: string;
  appointments: PortalAppointment[];
};

// ---- Helpers ----
const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtTime = (iso?: string | null) => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Data ISO (YYYY-MM-DD) -> "sexta-feira, 11 de julho de 2026".
const fmtDateLong = (dateISO: string) => {
  const [y, m, d] = dateISO.split('-').map(Number);
  if (!y || !m || !d) return dateISO;
  const dt = new Date(y, m - 1, d);
  try {
    return dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return dateISO;
  }
};

const STATUS_BADGE: Record<ApptStatus, { label: string; cls: string }> = {
  confirmed: { label: 'Confirmado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30 print:text-black print:bg-transparent print:border-black/30' },
  arrived: { label: 'Chegou', cls: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30 print:text-black print:bg-transparent print:border-black/30' },
  in_care: { label: 'Em atendimento', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30 print:text-black print:bg-transparent print:border-black/30' },
  completed: { label: 'Finalizado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30 print:text-black print:bg-transparent print:border-black/30' },
  cancelled: { label: 'Cancelado', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-700 print:text-black print:bg-transparent print:border-black/30' },
  no_show: { label: 'Não compareceu', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30 print:text-black print:bg-transparent print:border-black/30' },
};

const OVERRUN_BADGE: Record<OverrunState, { label: string; cls: string; dot: string }> = {
  idle: { label: 'Aguardando', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700', dot: 'bg-zinc-500' },
  on_time: { label: 'No horário', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
  near_end: { label: 'Próximo do fim', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400' },
  over_time: { label: 'Excedeu o tempo', cls: 'text-red-300 bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
  done: { label: 'Finalizado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700', dot: 'bg-zinc-500' },
};

// Recalcula o estado de permanência no cliente a partir de effective_end +
// warning_minutes (mesma regra da ClinicAgendaView / ADR-080 D3).
function computeOverrun(a: PortalAppointment, now: number): OverrunState {
  if (a.status === 'completed' || a.overrun_state === 'done') return 'done';
  if (!a.care_started_at || !a.effective_end) return a.overrun_state || 'idle';
  const end = new Date(a.effective_end).getTime();
  if (isNaN(end)) return a.overrun_state || 'on_time';
  const warnMs = Math.max(0, a.warning_minutes || 0) * 60000;
  if (now >= end) return 'over_time';
  if (now >= end - warnMs) return 'near_end';
  return 'on_time';
}

// Lê o token do path /clinic/professional/:token (último segmento).
function readToken(): string | null {
  const parts = window.location.pathname.split('/').filter(Boolean); // ["clinic","professional",":token"]
  const last = parts[parts.length - 1];
  if (!last || last === 'professional' || last === 'clinic') return null;
  return decodeURIComponent(last);
}

export function ClinicPortalPage() {
  const token = useMemo(readToken, []);
  const [date, setDate] = useState<string>(todayISO());
  const [data, setData] = useState<PortalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(Date.now());

  const load = useCallback(async () => {
    if (!token) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/clinic/portal/${encodeURIComponent(token)}?date=${date}`);
      if (res.status === 404) {
        setNotFound(true);
        setData(null);
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
      setNotFound(false);
      setData(json);
    } catch (e: any) {
      setError(e?.message || 'Não foi possível carregar a agenda.');
    } finally {
      setLoading(false);
    }
  }, [token, date]);

  useEffect(() => { load(); }, [load]);

  // Recalcula a permanência a cada 30s (igual ao painel).
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo<PortalAppointment[]>(() => {
    const list = data?.appointments || [];
    return [...list].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  }, [data]);

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <Loader2 className="w-7 h-7 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-5">
        <div className="max-w-md text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
          </div>
          <h1 className="text-lg font-semibold text-zinc-100">Link inválido ou expirado</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Este link de acesso não é mais válido. Peça um novo link à recepção.
          </p>
        </div>
      </div>
    );
  }

  const prof = data?.professional;
  const color = prof?.color || '#34d399';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 print:bg-white print:text-black">
      <div className="max-w-3xl mx-auto px-5 py-8">
        {/* Cabeçalho */}
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-emerald-400/80 print:text-emerald-700 flex items-center gap-1.5">
              <Stethoscope className="w-3.5 h-3.5" /> Portal do Profissional
            </p>
            <h1 className="mt-1 text-2xl font-bold flex items-center gap-2.5">
              <span className="inline-block w-3 h-3 rounded-full border border-zinc-600 shrink-0" style={{ backgroundColor: color }} />
              <span className="truncate">{prof?.name || 'Profissional'}</span>
            </h1>
            {prof?.specialty && <p className="mt-0.5 text-sm text-zinc-400 print:text-zinc-600">{prof.specialty}</p>}
            <p className="mt-2 text-sm text-zinc-300 print:text-black inline-flex items-center gap-1.5">
              <CalendarDays className="w-4 h-4 text-zinc-500" /> {fmtDateLong(data?.date || date)}
            </p>
          </div>

          {/* Controles — ocultos na impressão */}
          <div className="flex items-end gap-3 print:hidden">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">Data</span>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value || todayISO())}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500"
              />
            </label>
            <button
              onClick={() => window.print()}
              className="h-[38px] inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 text-sm text-zinc-100"
            >
              <Printer className="w-4 h-4" /> Imprimir
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-center gap-2 print:hidden">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-sm text-red-200">{error}</span>
          </div>
        )}

        <div className="mt-2 text-[11px] text-zinc-600 print:text-zinc-500">{rows.length} agendamento(s)</div>

        {/* Lista */}
        <div className="mt-4 space-y-3">
          {rows.length === 0 ? (
            <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40 print:border-black/20 print:bg-transparent">
              <Stethoscope className="w-8 h-8 text-emerald-400/70 mx-auto mb-2 print:text-zinc-400" />
              <p className="text-sm text-zinc-300 font-medium print:text-black">Nenhum agendamento para esta data</p>
              <p className="text-[12px] text-zinc-600 mt-1 print:text-zinc-500">Selecione outra data para consultar.</p>
            </div>
          ) : (
            rows.map(a => {
              const overrun = computeOverrun(a, tick);
              const st = STATUS_BADGE[a.status] || STATUS_BADGE.confirmed;
              const ov = OVERRUN_BADGE[overrun] || OVERRUN_BADGE.idle;
              const borderCls =
                overrun === 'over_time' ? 'border-red-500/50' :
                overrun === 'near_end' ? 'border-amber-500/40' :
                'border-zinc-800';
              return (
                <div
                  key={a.id}
                  className={`rounded-xl border ${borderCls} bg-zinc-900/50 p-4 print:bg-white print:border-black/25`}
                  style={{ borderLeft: `3px solid ${color}` }}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm text-zinc-200 print:text-black inline-flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-zinc-500" /> {fmtTime(a.time)}
                        </span>
                        <h3 className="font-semibold text-zinc-100 print:text-black truncate">{a.patient_name || 'Paciente'}</h3>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400 print:text-zinc-700">
                        {a.room && <span className="inline-flex items-center gap-1"><DoorOpen className="w-3.5 h-3.5 text-zinc-500" /> {a.room}</span>}
                        {a.plan && <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-zinc-500" /> {a.plan}</span>}
                        {a.duration_minutes ? <span className="inline-flex items-center gap-1"><Timer className="w-3.5 h-3.5 text-zinc-500" /> {a.duration_minutes} min</span> : null}
                      </div>
                      {a.procedure && (
                        <p className="mt-1 text-[12px] text-zinc-500 print:text-zinc-700">
                          Procedimento: <span className="text-zinc-300 print:text-black">{a.procedure}</span>
                        </p>
                      )}
                    </div>

                    {/* Chips */}
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 print:text-black print:bg-transparent print:border-black/30 ${ov.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${ov.dot} print:hidden`} /> {ov.label}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer className="mt-10 pt-5 border-t border-zinc-800 print:border-black/20 text-[11px] text-zinc-600 print:text-zinc-500">
          Consulta somente leitura da sua agenda. Para alterações, fale com a recepção.
        </footer>
      </div>
    </div>
  );
}
