import React, { useEffect, useState, useCallback } from 'react';
import { Target, Plus, Loader2, Trash2, Megaphone, Crosshair, X } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type Icp = { id: string; name: string; vertical?: string; criteria?: any; created_at: string };
type Campaign = { id: string; name: string; icp_id?: string; icp_name?: string; objective: string; status: string; created_at: string };

const OBJECTIVES: { id: string; label: string }[] = [
  { id: 'reuniao', label: 'Agendar reunião' },
  { id: 'diagnostico', label: 'Diagnóstico / Auditoria' },
  { id: 'evento', label: 'Convite para evento' },
  { id: 'proposta', label: 'Enviar proposta' },
];
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
  active: { label: 'Ativa', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  paused: { label: 'Pausada', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  completed: { label: 'Concluída', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
};

export function ProspectView() {
  const [icps, setIcps] = useState<Icp[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [newIcp, setNewIcp] = useState(false);
  const [newCamp, setNewCamp] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/prospect/icps').then(r => r.json()).then(d => setIcps(Array.isArray(d) ? d : [])).catch(() => {}),
      apiFetch('/api/prospect/campaigns').then(r => r.json()).then(d => setCampaigns(Array.isArray(d) ? d : [])).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const archiveIcp = async (id: string) => {
    try { const r = await apiFetch(`/api/prospect/icps/${id}`, { method: 'DELETE' }); if (!r.ok) throw new Error(); toast.success('ICP arquivado.'); load(); }
    catch { toast.error('Não foi possível arquivar.'); }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-5">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <Target className="w-6 h-6 text-cyan-400" /> Prospect AI
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Encontre contas com aderência, organize evidências e prospecte com método — sem spam.</p>
        <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-1.5 text-xs text-cyan-200">
          <Crosshair className="w-3.5 h-3.5" /> Fase 0 — defina o <b>ICP</b> (perfil de cliente ideal) e crie campanhas em <b>rascunho</b>. Descoberta, evidências e abordagem chegam nas próximas etapas.
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ICPs */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Crosshair className="w-4 h-4 text-cyan-400" /> Perfis de cliente ideal (ICP)</h3>
            <Button onClick={() => setNewIcp(true)} className="bg-cyan-600 hover:bg-cyan-700 text-white h-8 px-2.5 text-xs"><Plus className="w-3.5 h-3.5 mr-1" /> Novo ICP</Button>
          </div>
          {loading ? <Spinner /> : icps.length === 0 ? (
            <Empty text="Nenhum ICP ainda. Comece descrevendo o cliente ideal (segmento, região, dor, oferta)." />
          ) : (
            <div className="space-y-2">
              {icps.map(i => (
                <div key={i.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{i.name}</p>
                      <p className="text-[11px] text-zinc-500">{i.vertical || 'sem vertical'}{i.criteria?.regiao ? ` · ${i.criteria.regiao}` : ''}</p>
                      {i.criteria?.dor && <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-1">Dor: {i.criteria.dor}</p>}
                    </div>
                    <button onClick={() => archiveIcp(i.id)} title="Arquivar" className="text-zinc-600 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Campanhas */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Megaphone className="w-4 h-4 text-cyan-400" /> Campanhas de prospecção</h3>
            <Button onClick={() => { if (!icps.length) { toast.error('Crie um ICP primeiro.'); return; } setNewCamp(true); }} className="bg-cyan-600 hover:bg-cyan-700 text-white h-8 px-2.5 text-xs"><Plus className="w-3.5 h-3.5 mr-1" /> Nova campanha</Button>
          </div>
          {loading ? <Spinner /> : campaigns.length === 0 ? (
            <Empty text="Nenhuma campanha. Crie uma (nasce em rascunho) ligada a um ICP." />
          ) : (
            <div className="space-y-2">
              {campaigns.map(c => {
                const b = STATUS_BADGE[c.status] || STATUS_BADGE.draft;
                const obj = OBJECTIVES.find(o => o.id === c.objective)?.label || c.objective;
                return (
                  <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${b.cls}`}>{b.label}</span>
                      <span className="text-sm font-medium text-zinc-100">{c.name}</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">{obj}{c.icp_name ? ` · ICP: ${c.icp_name}` : ''}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {newIcp && <IcpModal onClose={() => setNewIcp(false)} onSaved={() => { setNewIcp(false); load(); }} />}
      {newCamp && <CampaignModal icps={icps} onClose={() => setNewCamp(false)} onSaved={() => { setNewCamp(false); load(); }} />}
    </div>
  );
}

const Spinner = () => <div className="flex items-center gap-2 text-zinc-500 text-sm py-6"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
const Empty = ({ text }: { text: string }) => <p className="text-[12px] text-zinc-600 py-6 text-center">{text}</p>;

function IcpModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [vertical, setVertical] = useState('');
  const [regiao, setRegiao] = useState('');
  const [sinais, setSinais] = useState('');
  const [dor, setDor] = useState('');
  const [oferta, setOferta] = useState('');
  const [cta, setCta] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error('Dê um nome ao ICP.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/prospect/icps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, vertical, criteria: { regiao, sinais, dor, oferta, cta } }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success('ICP criado! 🎯'); onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const field = (label: string, val: string, set: (v: string) => void, ph: string, area = false) => (
    <div>
      <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
      {area
        ? <textarea value={val} onChange={e => set(e.target.value)} placeholder={ph} className="w-full h-16 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 resize-none outline-none focus:border-cyan-500" />
        : <input value={val} onChange={e => set(e.target.value)} placeholder={ph} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-cyan-500" />}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[460px] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Crosshair className="w-5 h-5 text-cyan-400" /> Novo ICP</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          {field('Nome do ICP *', name, setName, 'Ex.: Hotéis e pousadas independentes')}
          {field('Vertical', vertical, setVertical, 'Ex.: Hotelaria')}
          {field('Região', regiao, setRegiao, 'Ex.: Rio de Janeiro — Zona Sul e Barra')}
          {field('Sinais de aderência', sinais, setSinais, 'Ex.: atende por WhatsApp, reservas diretas, eventos', true)}
          {field('Dor prioritária', dor, setDor, 'Ex.: reservas e orçamentos sem follow-up', true)}
          {field('Oferta', oferta, setOferta, 'Ex.: Auditoria-trial de 14 dias do RIC')}
          {field('CTA desejado', cta, setCta, 'Ex.: diagnóstico executivo de oportunidades em risco')}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy} className="bg-cyan-600 hover:bg-cyan-700 text-white">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}Criar ICP
          </Button>
        </div>
      </div>
    </div>
  );
}

function CampaignModal({ icps, onClose, onSaved }: { icps: Icp[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [icpId, setIcpId] = useState(icps[0]?.id || '');
  const [objective, setObjective] = useState('reuniao');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) { toast.error('Dê um nome à campanha.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/prospect/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, icpId: icpId || null, objective }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success('Campanha criada (rascunho). 📣'); onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Megaphone className="w-5 h-5 text-cyan-400" /> Nova campanha</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <label className="text-xs text-zinc-400 mb-1 block">Nome *</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Hotéis RJ — Q3" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 mb-3 outline-none focus:border-cyan-500" />
        <label className="text-xs text-zinc-400 mb-1 block">ICP</label>
        <select value={icpId} onChange={e => setIcpId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 mb-3 outline-none focus:border-cyan-500">
          {icps.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <label className="text-xs text-zinc-400 mb-1 block">Objetivo</label>
        <select value={objective} onChange={e => setObjective(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 mb-4 outline-none focus:border-cyan-500">
          {OBJECTIVES.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={submit} disabled={busy} className="bg-cyan-600 hover:bg-cyan-700 text-white">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}Criar (rascunho)
          </Button>
        </div>
        <p className="mt-3 text-[10px] text-zinc-600">A campanha nasce em rascunho. Descoberta de contas e abordagem entram nas próximas etapas.</p>
      </div>
    </div>
  );
}
