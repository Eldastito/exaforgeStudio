import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { toast } from '@/src/lib/toast';

// Painel do consultor (Radar — Fase 3, ADR-014). Cross-tenant DE PROPÓSITO —
// mostra sessões de TODAS as organizações. Segurança real é 100% no backend
// (server.ts monta /api/radar-consultant atrás de requireMasterAdmin, mesmo
// gate do Admin Master); a checagem de e-mail na Sidebar é só cosmética
// (esconder o item de menu), igual ao padrão já usado pelo AdminMasterView.

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  in_progress: { label: 'Em andamento', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  needs_information: { label: 'Falta info', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  awaiting_review: { label: 'Aguardando revisão', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  completed: { label: 'Concluído', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
};

const PILLAR_LABEL: Record<string, string> = {
  estrategia: 'Estratégia e liderança', receita: 'Receita e atendimento', processos: 'Processos operacionais',
  dados: 'Dados e integração', pessoas: 'Pessoas e capacitação', governanca: 'Governança e segurança', metricas: 'Métricas e ROI',
};

type Session = {
  id: string; status: string; company_name: string | null; org_business_name: string;
  overall_maturity_score: number | null; maturity_level: string | null; updated_at: string; next_action: string | null;
};

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/radar-consultant${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

export function RadarConsultantView() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [detail, setDetail] = useState<any | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const q = statusFilter ? `?status=${statusFilter}` : '';
    api(`/sessions${q}`).then((d) => setSessions(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const openSession = async (id: string) => {
    try {
      const s = await api(`/sessions/${id}`);
      setDetail(s);
      setNote(s.next_action || '');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível abrir essa sessão.');
    }
  };

  const saveNote = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const updated = await api(`/sessions/${detail.id}/note`, { method: 'PATCH', body: JSON.stringify({ note }) });
      setDetail(updated);
      toast.success('Nota do consultor salva.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const updated = await api(`/sessions/${detail.id}/approve`, { method: 'POST' });
      setDetail(updated);
      toast.success('Diagnóstico aprovado.');
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (detail) {
    const st = STATUS_LABEL[detail.status] || { label: detail.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
    return (
      <div className="flex-1 overflow-auto p-6 bg-zinc-950 text-white">
        <div className="max-w-3xl mx-auto">
          <button onClick={() => setDetail(null)} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
            <ArrowLeft size={14} /> Voltar para a lista
          </button>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-xl font-bold">{detail.company_name || 'Diagnóstico sem nome'}</h2>
              <p className="text-sm text-white/50 mt-0.5">{detail.org_business_name}</p>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
          </div>

          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-6">
            <div className="text-4xl font-bold tabular-nums text-teal-400">
              {detail.overall_maturity_score != null ? Math.round(detail.overall_maturity_score) : '—'}
            </div>
            <div>
              <div className="font-semibold">{detail.maturity_level || 'Sem dados suficientes'}</div>
              <div className="text-xs text-white/40">Índice de maturidade (0-100)</div>
            </div>
          </div>

          <h3 className="mt-6 text-sm font-semibold text-white/50 uppercase tracking-wide">Os 7 pilares</h3>
          <div className="mt-3 space-y-2">
            {(detail.pillarScores || []).map((p: any) => (
              <div key={p.pillar} className="flex justify-between text-sm">
                <span className="text-white/70">{PILLAR_LABEL[p.pillar] || p.pillar}</span>
                <span className="text-white/40 tabular-nums">{p.score != null ? Math.round(p.score) : '—'}</span>
              </div>
            ))}
          </div>

          {(detail.respondents || []).length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-semibold text-white/50 uppercase tracking-wide">Respondentes</h3>
              <div className="mt-3 space-y-1.5">
                {detail.respondents.map((r: any) => (
                  <div key={r.id} className="text-sm text-white/70">
                    {r.name} {r.role_title ? `· ${r.role_title}` : ''} {r.area ? `· ${r.area}` : ''}
                  </div>
                ))}
              </div>
            </>
          )}

          <h3 className="mt-6 text-sm font-semibold text-white/50 uppercase tracking-wide">Nota do consultor</h3>
          <textarea
            className="mt-2 w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/40 min-h-[100px]"
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Anotações internas sobre este diagnóstico, próximos passos combinados com o cliente..."
          />

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveNote} disabled={saving}
              className="rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-50"
            >
              {saving ? <Loader2 className="animate-spin inline" size={16} /> : 'Salvar nota'}
            </button>
            {detail.status === 'awaiting_review' && (
              <button
                onClick={approve} disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-[#0b0f12] hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--color-zf-teal)' }}
              >
                <CheckCircle2 size={16} /> Aprovar revisão
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 text-white">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <ShieldCheck size={20} style={{ color: 'var(--color-zf-teal)' }} /> Radar — Painel do Consultor
            </h1>
            <p className="text-sm text-white/50 mt-1">Diagnósticos de todos os clientes ZappFlow, para dar suporte consultivo.</p>
          </div>
          <select
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white outline-none"
            style={{ colorScheme: 'dark' }}
            value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Todos os status</option>
            <option value="awaiting_review">Aguardando revisão</option>
            <option value="approved">Aprovado</option>
            <option value="completed">Concluído</option>
            <option value="in_progress">Em andamento</option>
          </select>
        </div>

        {loading ? (
          <div className="text-sm text-white/40">Carregando...</div>
        ) : sessions.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/50">Nenhum diagnóstico encontrado.</div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => {
              const st = STATUS_LABEL[s.status] || { label: s.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
              return (
                <button
                  key={s.id}
                  onClick={() => openSession(s.id)}
                  className="w-full flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3.5 text-left hover:border-white/25 transition"
                >
                  <div>
                    <div className="font-medium text-sm">{s.company_name || 'Diagnóstico sem nome'}</div>
                    <div className="text-xs text-white/40 mt-0.5">{s.org_business_name} · atualizado em {new Date(s.updated_at.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR')}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {s.overall_maturity_score != null && <div className="text-sm tabular-nums text-white/70">{Math.round(s.overall_maturity_score)}/100</div>}
                    <span className={`text-xs px-2 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
