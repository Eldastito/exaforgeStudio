import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Edit3, CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, Save, X, Zap } from 'lucide-react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { confirmDialog } from '@/src/lib/toast';

type Step = { id?: string; delayHours: number; message: string };

type Cadence = {
  id: string;
  name: string;
  trigger_stage: string;
  active: number;
  min_lead_score?: number;
  steps: { id: string; step_order: number; delay_hours: number; message: string }[];
};

const STAGE_LABELS: Record<string, string> = {
  novo_lead: 'Novo Lead',
  ia_atendendo: 'IA Atendendo',
  proposta: 'Proposta Enviada',
  aguardando_pagamento: 'Aguardando Pagamento',
  em_atendimento: 'Em Atendimento',
  qualificado: 'Qualificado',
  agendado: 'Agendado',
  fechado: 'Fechado',
};

const STAGES = Object.keys(STAGE_LABELS);

const DEFAULT_STEPS: Step[] = [
  { delayHours: 2, message: 'Olá {nome}! Passando para ver se você recebeu nossa proposta. Posso esclarecer alguma dúvida? 😊' },
  { delayHours: 24, message: 'Oi {nome}! Ainda disponível para te ajudar. Que tal conversarmos rapidinho?' },
  { delayHours: 72, message: 'Olá {nome}! Última mensagem por aqui — fico à disposição quando precisar. 🙌' },
];

export function CadencesView() {
  const { token } = useAuth();
  const [cadences, setCadences] = useState<Cadence[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string; triggerStage: string; minLeadScore: number; steps: Step[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/cadences', { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      setCadences(Array.isArray(data) ? data : []);
    } catch (e) { /* noop */ } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => setEditing({ id: null, name: '', triggerStage: 'proposta', minLeadScore: 0, steps: DEFAULT_STEPS });

  const openEdit = (c: Cadence) => setEditing({
    id: c.id,
    name: c.name,
    triggerStage: c.trigger_stage,
    minLeadScore: c.min_lead_score || 0,
    steps: c.steps.map(s => ({ delayHours: s.delay_hours, message: s.message })),
  });

  const closeEdit = () => { setEditing(null); setError(''); };

  const save = async () => {
    if (!editing) return;
    setSaving(true); setError('');
    try {
      const body = { name: editing.name, triggerStage: editing.triggerStage, minLeadScore: editing.minLeadScore, steps: editing.steps };
      const url = editing.id ? `/api/cadences/${editing.id}` : '/api/cadences';
      const method = editing.id ? 'PUT' : 'POST';
      const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) { setError(data.error || 'Erro ao salvar'); return; }
      closeEdit();
      load();
    } catch (e: any) { setError(e.message || 'Erro de rede'); } finally { setSaving(false); }
  };

  const toggle = async (c: Cadence) => {
    await fetch(`/api/cadences/${c.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ active: !c.active }),
    });
    load();
  };

  const remove = async (id: string) => {
    if (!(await confirmDialog('Remover esta cadência? As sequências ativas serão canceladas.', { danger: true, confirmText: 'Remover' }))) return;
    await fetch(`/api/cadences/${id}`, { method: 'DELETE', headers });
    load();
  };

  const addStep = () => setEditing(e => e ? { ...e, steps: [...e.steps, { delayHours: 24, message: '' }] } : e);
  const removeStep = (i: number) => setEditing(e => e ? { ...e, steps: e.steps.filter((_, idx) => idx !== i) } : e);
  const updateStep = (i: number, field: keyof Step, val: any) =>
    setEditing(e => e ? { ...e, steps: e.steps.map((s, idx) => idx === i ? { ...s, [field]: val } : s) } : e);

  return (
    <div className="flex-1 overflow-auto bg-zinc-950 p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-zinc-100">Cadências de Follow-up</h2>
            <p className="text-sm text-zinc-400 mt-0.5">
              Sequências automáticas enviadas quando o contato não responde após atingir um estágio.
            </p>
          </div>
          <button
            onClick={openNew}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> Nova Cadência
          </button>
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1">
                  <Skeleton className="h-5 w-9 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-8 w-8 rounded-lg" />
              </div>
            ))}
          </div>
        ) : cadences.length === 0 ? (
          <div className="text-center py-20 text-zinc-500">
            <Zap className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Nenhuma cadência configurada</p>
            <p className="text-sm mt-1">Crie uma para automatizar o follow-up dos seus leads.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {cadences.map(c => (
              <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
                <div className="flex items-center justify-between p-4 cursor-pointer" onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <button
                      onClick={e => { e.stopPropagation(); toggle(c); }}
                      title={c.active ? 'Ativa — clique para pausar' : 'Pausada — clique para ativar'}
                    >
                      {c.active
                        ? <CheckCircle className="w-5 h-5 text-emerald-400" />
                        : <XCircle className="w-5 h-5 text-zinc-500" />}
                    </button>
                    <div className="min-w-0">
                      <p className="font-semibold text-zinc-100 truncate">{c.name}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Gatilho: <span className="text-indigo-400">{STAGE_LABELS[c.trigger_stage] || c.trigger_stage}</span>
                        {' · '}{c.steps.length} etapa{c.steps.length !== 1 ? 's' : ''}
                        {(c.min_lead_score || 0) > 0 && <> · <span className="text-emerald-400">score ≥ {c.min_lead_score}</span></>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 pl-3">
                    <button onClick={e => { e.stopPropagation(); openEdit(c); }} className="p-1.5 text-zinc-400 hover:text-zinc-100 transition-colors">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); remove(c.id); }} className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {expandedId === c.id ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
                  </div>
                </div>

                {expandedId === c.id && (
                  <div className="border-t border-zinc-800 px-4 pb-4 pt-3 space-y-2">
                    {c.steps.map((s, i) => (
                      <div key={s.id} className="flex gap-3 items-start">
                        <div className="flex flex-col items-center pt-1">
                          <div className="w-6 h-6 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-xs text-indigo-400 font-bold">{i + 1}</div>
                          {i < c.steps.length - 1 && <div className="w-px h-full mt-1 bg-zinc-700" />}
                        </div>
                        <div className="flex-1 bg-zinc-800/50 rounded-lg p-3">
                          <div className="flex items-center gap-1.5 mb-1 text-xs text-zinc-400">
                            <Clock className="w-3 h-3" />
                            Aguarda <span className="text-zinc-200 font-medium">{s.delay_hours}h</span> sem resposta
                          </div>
                          <p className="text-sm text-zinc-200">{s.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-zinc-800">
              <h3 className="font-bold text-zinc-100 text-lg">{editing.id ? 'Editar Cadência' : 'Nova Cadência'}</h3>
              <button onClick={closeEdit} className="text-zinc-400 hover:text-zinc-100"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {error && <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg p-3">{error}</p>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Nome</label>
                  <input
                    value={editing.name}
                    onChange={e => setEditing(ed => ed ? { ...ed, name: e.target.value } : ed)}
                    placeholder="Ex.: Follow-up Proposta"
                    className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">Estágio Gatilho</label>
                  <select
                    value={editing.triggerStage}
                    onChange={e => setEditing(ed => ed ? { ...ed, triggerStage: e.target.value } : ed)}
                    className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                  >
                    {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5 uppercase tracking-wider">
                  Lead Score Mínimo
                  <span className="ml-2 font-normal text-zinc-500 normal-case tracking-normal">— só dispara se o lead score do contato for ≥ este valor (0 = todos)</span>
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={0} max={100} step={5}
                    value={editing.minLeadScore}
                    onChange={e => setEditing(ed => ed ? { ...ed, minLeadScore: parseInt(e.target.value, 10) } : ed)}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="w-12 text-right text-sm font-semibold text-indigo-400">{editing.minLeadScore}</span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Etapas</label>
                  <button onClick={addStep} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-medium">
                    <Plus className="w-3.5 h-3.5" /> Adicionar etapa
                  </button>
                </div>
                <p className="text-xs text-zinc-500 mb-3">Use <code className="text-indigo-400">{'{nome}'}</code> para personalizar com o primeiro nome do contato.</p>

                <div className="space-y-3">
                  {editing.steps.map((step, i) => (
                    <div key={i} className="bg-zinc-800/60 rounded-xl p-4 border border-zinc-700/50">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider">Etapa {i + 1}</span>
                        {editing.steps.length > 1 && (
                          <button onClick={() => removeStep(i)} className="text-zinc-500 hover:text-red-400 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-[auto_1fr] gap-3 items-start">
                        <div>
                          <label className="block text-xs text-zinc-500 mb-1">Aguardar (horas)</label>
                          <input
                            type="number"
                            min="0.5"
                            step="0.5"
                            value={step.delayHours}
                            onChange={e => updateStep(i, 'delayHours', parseFloat(e.target.value) || 1)}
                            className="w-24 rounded-lg bg-zinc-700 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-zinc-500 mb-1">Mensagem</label>
                          <textarea
                            rows={3}
                            value={step.message}
                            onChange={e => updateStep(i, 'message', e.target.value)}
                            placeholder="Mensagem que será enviada automaticamente..."
                            className="w-full rounded-lg bg-zinc-700 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 resize-none"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 p-5 border-t border-zinc-800">
              <button onClick={closeEdit} className="px-4 py-2 rounded-lg text-sm text-zinc-300 hover:bg-zinc-800 transition-colors">Cancelar</button>
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
