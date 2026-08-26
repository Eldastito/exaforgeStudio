import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { Scale, Plus, X, Loader2, Calculator, CheckCircle2, RotateCcw, Ban, Gavel } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import { legalTerms, type LegalTerms } from '@/src/lib/legalTerms';

/**
 * AdvocaciaView (ADR-191 UI F13) — painel do escritório de advocacia.
 * Consome as rotas /api/advocacia/* (backend já em produção, F0–F12).
 * Só aparece pra vertical 'advocacia' (gate no Sidebar/App). Espelha os
 * padrões da ClinicAgendaView (apiFetch, tabs locais, toast, cards Tailwind).
 * Esta 1ª fatia cobre o núcleo operacional (Processos + Prazos) + o setup
 * (Áreas do direito + Advogados). Audiências/documentos/honorários: próxima fatia.
 */

function useLegalTerms(): LegalTerms {
  const vertical = useStore((s) => s.vertical);
  return legalTerms(vertical);
}

const CASE_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'Ativo', cls: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30' },
  on_hold: { label: 'Suspenso', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  closed: { label: 'Encerrado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  archived: { label: 'Arquivado', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/30' },
};
const DEADLINE_STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: 'Aberto', cls: 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30' },
  done: { label: 'Concluído', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  cancelled: { label: 'Cancelado', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/30' },
};

type Tab = 'cases' | 'deadlines' | 'config';

export function AdvocaciaView() {
  const terms = useLegalTerms();
  const [tab, setTab] = useState<Tab>('cases');

  const tabs: [Tab, string][] = [
    ['cases', terms.casePlural],
    ['deadlines', terms.deadlinePlural],
    ['config', 'Configuração'],
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5">
        <p className="zf-kicker mb-1">Advocacia</p>
        <h2 className="zf-page-title flex items-center gap-2">
          <Scale className="w-6 h-6 text-indigo-400" /> Escritório
        </h2>
      </div>

      <div className="mb-5 flex items-center gap-1 border-b border-zinc-800 overflow-x-auto">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors whitespace-nowrap ${
              tab === id ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'cases' && <CasesTab terms={terms} />}
      {tab === 'deadlines' && <DeadlinesTab terms={terms} />}
      {tab === 'config' && <ConfigTab terms={terms} />}
    </div>
  );
}

// ───────────────────────── Processos ─────────────────────────

function CasesTab({ terms }: { terms: LegalTerms }) {
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    return apiFetch('/api/advocacia/cases')
      .then((r) => r.json())
      .then((d) => setCases(Array.isArray(d?.cases) ? d.cases : []))
      .catch(() => setCases([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const action = async (path: string, okMsg: string, body?: any) => {
    try {
      const r = await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível concluir a ação.');
      toast.success(okMsg);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Erro.');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">{cases.length} {cases.length === 1 ? terms.caseLower : terms.casePlural.toLowerCase()}</p>
        <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}>
          <Plus className="w-4 h-4 mr-2" /> Novo {terms.caseLower}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : cases.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-500 text-sm">
          Nenhum {terms.caseLower} ainda. Crie o primeiro.
        </div>
      ) : (
        <div className="space-y-2">
          {cases.map((c) => {
            const st = CASE_STATUS[c.status] || CASE_STATUS.active;
            const live = c.status === 'active' || c.status === 'on_hold';
            return (
              <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4" style={{ borderLeft: '3px solid #6366f1' }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-100">{c.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                      {c.case_type && <span className="text-[10px] px-1.5 py-0.5 rounded border text-zinc-400 bg-zinc-500/10 border-zinc-500/30">{c.case_type}</span>}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 space-y-0.5">
                      {c.cnj_number && <div>CNJ {c.cnj_number}</div>}
                      {(c.court || c.comarca) && <div>{[c.court, c.comarca].filter(Boolean).join(' · ')}</div>}
                      {c.opposing_party && <div>Parte adversa: {c.opposing_party}</div>}
                      {c.phase && <div>Fase: {c.phase}</div>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {live ? (
                      <button
                        title={terms.closureVerb}
                        className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-300"
                        onClick={async () => {
                          const reason = window.prompt(`Motivo do ${terms.closure.toLowerCase()} (opcional):`) ?? undefined;
                          if (reason === undefined) return;
                          action(`/api/advocacia/cases/${c.id}/close`, `${terms.case} encerrado.`, { reason });
                        }}
                      >
                        <Ban className="w-4 h-4" />
                      </button>
                    ) : c.status === 'closed' ? (
                      <button
                        title="Reabrir"
                        className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-indigo-300"
                        onClick={() => action(`/api/advocacia/cases/${c.id}/reopen`, `${terms.case} reaberto.`)}
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewCaseModal
          terms={terms}
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

function NewCaseModal({ terms, onClose, onCreated }: { terms: LegalTerms; onClose: () => void; onCreated: () => void }) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [areas, setAreas] = useState<any[]>([]);
  const [lawyers, setLawyers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ contactId: '', practiceAreaId: '', responsibleLawyerId: '', title: '', cnjNumber: '', caseType: 'judicial', court: '', comarca: '', opposingParty: '', phase: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/api/contacts').then((r) => r.json()).then((d) => setContacts(Array.isArray(d) ? d : [])).catch(() => {});
    apiFetch('/api/advocacia/practice-areas').then((r) => r.json()).then((d) => setAreas(Array.isArray(d?.areas) ? d.areas : [])).catch(() => {});
    apiFetch('/api/advocacia/lawyers').then((r) => r.json()).then((d) => setLawyers(Array.isArray(d?.lawyers) ? d.lawyers : [])).catch(() => {});
  }, []);

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.contactId) return toast.error('Selecione o cliente.');
    if (!form.title.trim()) return toast.error('Dê um título ao processo.');
    setSaving(true);
    try {
      const r = await apiFetch('/api/advocacia/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, cnjNumber: form.cnjNumber.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível criar.');
      toast.success(`${terms.case} criado.`);
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || 'Erro.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Novo ${terms.caseLower}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={`${terms.client} *`}>
          <Select value={form.contactId} onChange={(v) => set('contactId', v)}>
            <option value="">Selecione…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Título *">
          <Input value={form.title} onChange={(v) => set('title', v)} placeholder="Ex.: Ação trabalhista X" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={terms.practiceArea}>
            <Select value={form.practiceAreaId} onChange={(v) => set('practiceAreaId', v)}>
              <option value="">—</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={`${terms.professional} responsável`}>
            <Select value={form.responsibleLawyerId} onChange={(v) => set('responsibleLawyerId', v)}>
              <option value="">—</option>
              {lawyers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <Select value={form.caseType} onChange={(v) => set('caseType', v)}>
              <option value="judicial">Judicial</option>
              <option value="consultivo">Consultivo</option>
              <option value="administrativo">Administrativo</option>
            </Select>
          </Field>
          <Field label="Número CNJ">
            <Input value={form.cnjNumber} onChange={(v) => set('cnjNumber', v)} placeholder="NNNNNNN-DD.AAAA.J.TR.OOOO" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tribunal"><Input value={form.court} onChange={(v) => set('court', v)} /></Field>
          <Field label="Comarca"><Input value={form.comarca} onChange={(v) => set('comarca', v)} /></Field>
        </div>
        <Field label="Parte adversa"><Input value={form.opposingParty} onChange={(v) => set('opposingParty', v)} /></Field>
      </div>
      <ModalActions onClose={onClose} onSubmit={submit} saving={saving} />
    </Modal>
  );
}

// ───────────────────────── Prazos ─────────────────────────

function DeadlinesTab({ terms }: { terms: LegalTerms }) {
  const [deadlines, setDeadlines] = useState<any[]>([]);
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    return apiFetch('/api/advocacia/deadlines')
      .then((r) => r.json())
      .then((d) => setDeadlines(Array.isArray(d?.deadlines) ? d.deadlines : []))
      .catch(() => setDeadlines([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    apiFetch('/api/advocacia/cases').then((r) => r.json()).then((d) => setCases(Array.isArray(d?.cases) ? d.cases : [])).catch(() => {});
  }, [load]);

  const action = async (path: string, okMsg: string) => {
    try {
      const r = await apiFetch(path, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Erro.');
      toast.success(okMsg);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Erro.');
    }
  };

  const caseTitle = (id: string) => cases.find((c) => c.id === id)?.title || '';

  return (
    <div>
      <DeadlineCalculator terms={terms} />

      <div className="flex items-center justify-between mb-4 mt-6">
        <p className="text-sm text-zinc-400">{deadlines.length} {deadlines.length === 1 ? terms.deadline.toLowerCase() : terms.deadlinePlural.toLowerCase()}</p>
        <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}>
          <Plus className="w-4 h-4 mr-2" /> Novo {terms.deadline.toLowerCase()}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : deadlines.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-500 text-sm">
          Nenhum {terms.deadline.toLowerCase()} cadastrado.
        </div>
      ) : (
        <div className="space-y-2">
          {deadlines.map((d) => {
            const st = DEADLINE_STATUS[d.status] || DEADLINE_STATUS.open;
            const overdue = d.status === 'open' && d.due_date < new Date().toISOString().slice(0, 10);
            return (
              <div key={d.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4" style={{ borderLeft: `3px solid ${d.is_fatal ? '#ef4444' : '#6366f1'}` }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-100">{d.title}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                      {d.is_fatal ? <span className="text-[10px] px-1.5 py-0.5 rounded border text-red-300 bg-red-500/10 border-red-500/30">Fatal</span> : null}
                      {overdue ? <span className="text-[10px] px-1.5 py-0.5 rounded border text-red-300 bg-red-500/10 border-red-500/30">Vencido</span> : null}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 space-y-0.5">
                      <div>Vence: <span className={overdue ? 'text-red-300' : 'text-zinc-300'}>{d.due_date}</span> ({d.counting_mode === 'calendar' ? 'corridos' : 'dias úteis'})</div>
                      {d.case_id && caseTitle(d.case_id) && <div>{terms.case}: {caseTitle(d.case_id)}</div>}
                      {!d.holidays_loaded && <div className="text-amber-400">⚠ Sem calendário de feriados no período — confira a contagem.</div>}
                    </div>
                  </div>
                  {d.status === 'open' && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button title="Concluir" className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-emerald-300" onClick={() => action(`/api/advocacia/deadlines/${d.id}/complete`, 'Prazo concluído.')}>
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                      <button title="Cancelar" className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-300" onClick={async () => { if (await confirmDialog('Cancelar este prazo?')) action(`/api/advocacia/deadlines/${d.id}/cancel`, 'Prazo cancelado.'); }}>
                        <Ban className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewDeadlineModal
          terms={terms}
          cases={cases}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load(); }}
        />
      )}
    </div>
  );
}

function DeadlineCalculator({ terms }: { terms: LegalTerms }) {
  const [pub, setPub] = useState('');
  const [days, setDays] = useState('15');
  const [mode, setMode] = useState<'business' | 'calendar'>('business');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const compute = async () => {
    if (!pub) return toast.error('Informe a data de publicação.');
    setBusy(true);
    try {
      const r = await apiFetch('/api/advocacia/deadlines/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicationDate: pub, termDays: Number(days), countingMode: mode }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Erro no cálculo.');
      setResult(d);
    } catch (e: any) {
      toast.error(e?.message || 'Erro.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-2 mb-3 text-sm text-zinc-300">
        <Calculator className="w-4 h-4 text-indigo-400" /> Calculadora de {terms.deadline.toLowerCase()}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
        <Field label="Publicação"><Input type="date" value={pub} onChange={setPub} /></Field>
        <Field label="Dias"><Input type="number" value={days} onChange={setDays} /></Field>
        <Field label="Contagem">
          <Select value={mode} onChange={(v) => setMode(v as any)}>
            <option value="business">Dias úteis</option>
            <option value="calendar">Corridos</option>
          </Select>
        </Field>
        <Button className="zf-button zf-button-secondary" onClick={compute} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Calcular'}
        </Button>
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <span className="text-zinc-400">Vencimento: </span>
          <span className="text-indigo-300 font-medium">{result.dueDate}</span>
          {!result.holidaysLoaded && <span className="text-amber-400 ml-2 text-xs">⚠ Sem feriados carregados no período — cadastre o calendário para maior precisão.</span>}
        </div>
      )}
    </div>
  );
}

function NewDeadlineModal({ terms, cases, onClose, onCreated }: { terms: LegalTerms; cases: any[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<any>({ caseId: '', title: '', publicationDate: '', termDays: '15', countingMode: 'business', isFatal: true });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.title.trim()) return toast.error('Descreva o prazo.');
    if (!form.publicationDate) return toast.error('Informe a data de publicação.');
    setSaving(true);
    try {
      const r = await apiFetch('/api/advocacia/deadlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, termDays: Number(form.termDays), caseId: form.caseId || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível criar.');
      toast.success('Prazo criado.');
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || 'Erro.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Novo ${terms.deadline.toLowerCase()}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Título *"><Input value={form.title} onChange={(v) => set('title', v)} placeholder="Ex.: Contestação" /></Field>
        <Field label={terms.case}>
          <Select value={form.caseId} onChange={(v) => set('caseId', v)}>
            <option value="">— (prazo avulso)</option>
            {cases.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Publicação *"><Input type="date" value={form.publicationDate} onChange={(v) => set('publicationDate', v)} /></Field>
          <Field label="Dias *"><Input type="number" value={form.termDays} onChange={(v) => set('termDays', v)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contagem">
            <Select value={form.countingMode} onChange={(v) => set('countingMode', v)}>
              <option value="business">Dias úteis</option>
              <option value="calendar">Corridos</option>
            </Select>
          </Field>
          <Field label="Prazo fatal?">
            <Select value={form.isFatal ? '1' : '0'} onChange={(v) => set('isFatal', v === '1')}>
              <option value="1">Sim (peremptório)</option>
              <option value="0">Não</option>
            </Select>
          </Field>
        </div>
      </div>
      <ModalActions onClose={onClose} onSubmit={submit} saving={saving} />
    </Modal>
  );
}

// ───────────────────────── Config (áreas + advogados) ─────────────────────────

function ConfigTab({ terms }: { terms: LegalTerms }) {
  const [areas, setAreas] = useState<any[]>([]);
  const [lawyers, setLawyers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAreas = useCallback(() => apiFetch('/api/advocacia/practice-areas').then((r) => r.json()).then((d) => setAreas(Array.isArray(d?.areas) ? d.areas : [])).catch(() => {}), []);
  const loadLawyers = useCallback(() => apiFetch('/api/advocacia/lawyers').then((r) => r.json()).then((d) => setLawyers(Array.isArray(d?.lawyers) ? d.lawyers : [])).catch(() => {}), []);

  useEffect(() => {
    Promise.all([loadAreas(), loadLawyers()]).finally(() => setLoading(false));
  }, [loadAreas, loadLawyers]);

  const [newArea, setNewArea] = useState('');
  const [newLawyer, setNewLawyer] = useState<any>({ name: '', oabUf: '', oabNumber: '' });

  const addArea = async () => {
    if (!newArea.trim()) return;
    try {
      const r = await apiFetch('/api/advocacia/practice-areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newArea.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Erro.');
      setNewArea('');
      await loadAreas();
    } catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  const seedAreas = async () => {
    try {
      const r = await apiFetch('/api/advocacia/practice-areas/seed-defaults', { method: 'POST' });
      if (!r.ok) throw new Error('Erro.');
      toast.success('Áreas padrão adicionadas.');
      await loadAreas();
    } catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  const addLawyer = async () => {
    if (!newLawyer.name.trim()) return toast.error('Informe o nome.');
    try {
      const r = await apiFetch('/api/advocacia/lawyers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newLawyer) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Erro.');
      setNewLawyer({ name: '', oabUf: '', oabNumber: '' });
      await loadLawyers();
    } catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  if (loading) return <div className="flex items-center gap-2 text-zinc-500 text-sm py-8 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Áreas do direito */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-200">{terms.practiceAreaPlural}</h3>
          {areas.length === 0 && <button className="text-xs text-indigo-300 hover:underline" onClick={seedAreas}>Adicionar padrão</button>}
        </div>
        <div className="space-y-1 mb-3">
          {areas.length === 0 ? <p className="text-xs text-zinc-500">Nenhuma área ainda.</p> : areas.map((a) => (
            <div key={a.id} className="text-sm text-zinc-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ background: a.color || '#6366f1' }} /> {a.name}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input value={newArea} onChange={setNewArea} placeholder="Nova área…" />
          <Button className="zf-button zf-button-secondary" onClick={addArea}><Plus className="w-4 h-4" /></Button>
        </div>
      </div>

      {/* Advogados */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gavel className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-medium text-zinc-200">{terms.professionalPlural}</h3>
        </div>
        <div className="space-y-1 mb-3">
          {lawyers.length === 0 ? <p className="text-xs text-zinc-500">Nenhum {terms.professionalLower} ainda.</p> : lawyers.map((l) => (
            <div key={l.id} className="text-sm text-zinc-300 flex items-center justify-between">
              <span>{l.name}</span>
              {l.registration_number && <span className="text-xs text-zinc-500">{l.registration_number}</span>}
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <Input value={newLawyer.name} onChange={(v) => setNewLawyer((f: any) => ({ ...f, name: v }))} placeholder={`Nome do ${terms.professionalLower}`} />
          <div className="grid grid-cols-2 gap-2">
            <Input value={newLawyer.oabUf} onChange={(v) => setNewLawyer((f: any) => ({ ...f, oabUf: v }))} placeholder="UF OAB (ex.: SP)" />
            <Input value={newLawyer.oabNumber} onChange={(v) => setNewLawyer((f: any) => ({ ...f, oabNumber: v }))} placeholder="Nº OAB" />
          </div>
          <Button className="zf-button zf-button-secondary w-full" onClick={addLawyer}><Plus className="w-4 h-4 mr-2" /> Adicionar</Button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── primitivos locais ─────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-medium text-zinc-100">{title}</h3>
          <button className="p-1 rounded hover:bg-zinc-800 text-zinc-400" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalActions({ onClose, onSubmit, saving }: { onClose: () => void; onSubmit: () => void; saving: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2 mt-5">
      <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
      <Button className="zf-button zf-button-primary" onClick={onSubmit} disabled={saving}>
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Input({ value, onChange, placeholder, type = 'text' }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
    />
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
    >
      {children}
    </select>
  );
}

export default AdvocaciaView;
