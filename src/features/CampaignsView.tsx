import React, { useEffect, useState } from 'react';
import { Megaphone, Plus, X, Play, Pause, Users, AlertTriangle, Send } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { EmptyState } from '@/src/components/EmptyState';
import { toast } from '@/src/lib/toast';

type Campaign = {
  id: string; name: string; message: string; status: string;
  total_targets: number; sent_count: number; failed_count: number; created_at: string;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'bg-zinc-600/10 text-zinc-400 border-zinc-600/30' },
  running: { label: 'Enviando', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  paused: { label: 'Pausada', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  completed: { label: 'Concluída', cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
  cancelled: { label: 'Cancelada', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
};

const SEGMENTS = [
  { id: 'todos', label: 'Todos os contatos', seg: {} },
  { id: 'score', label: '🎯 Lead score alto (≥70)', seg: { minLeadScore: 70 } },
  { id: 'quentes', label: '🔥 Leads quentes', seg: { temperature: 'quente' } },
  { id: 'inativos', label: 'Inativos +60 dias (reativação)', seg: { inactiveDays: 60 } },
  { id: 'top', label: 'Top 10 compradores', seg: { topBuyers: 10 } },
];

export function CampaignsView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('Olá {nome}! ');
  const [segId, setSegId] = useState('inativos');
  const [preview, setPreview] = useState<{ total: number; sample: string[] } | null>(null);
  const [creating, setCreating] = useState(false);

  const [auto, setAuto] = useState<{ enabled: boolean; days: number; message: string } | null>(null);

  const load = () => apiFetch('/api/campaigns').then(r => r.json()).then(d => setCampaigns(Array.isArray(d) ? d : [])).catch(() => {});
  const loadAuto = () => apiFetch('/api/campaigns/settings').then(r => r.json()).then(setAuto).catch(() => {});
  useEffect(() => { load(); loadAuto(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  const saveAuto = async (patch: Partial<{ enabled: boolean; days: number; message: string }>) => {
    const next = { enabled: auto?.enabled || false, days: auto?.days || 60, message: auto?.message || '', ...patch };
    setAuto(next);
    await apiFetch('/api/campaigns/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    }).catch(() => {});
  };

  const seg = () => SEGMENTS.find(s => s.id === segId)?.seg || {};

  const doPreview = async () => {
    const res = await apiFetch('/api/campaigns/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment: seg() }),
    });
    setPreview(await res.json().catch(() => null));
  };
  useEffect(() => { if (showModal) doPreview(); /* eslint-disable-next-line */ }, [segId, showModal]);

  const create = async () => {
    if (!name.trim() || !message.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message, segment: seg() }),
      });
      const d = await res.json();
      if (res.ok) { setShowModal(false); setName(''); setMessage('Olá {nome}! '); load(); }
      else toast.error(d.error || 'Erro ao criar campanha');
    } catch (e) { toast.error('Erro ao criar campanha'); }
    finally { setCreating(false); }
  };

  const start = async (id: string) => {
    const res = await apiFetch(`/api/campaigns/${id}/start`, { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao iniciar'); }
    load();
  };
  const pause = async (id: string) => { await apiFetch(`/api/campaigns/${id}/pause`, { method: 'POST' }); load(); };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-indigo-400" /> Campanhas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Mensagens ativas: reativação de inativos e ofertas para quem mais compra</p>
        </div>
        <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={() => setShowModal(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nova Campanha
        </Button>
      </div>

      {/* Aviso de boas práticas */}
      <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
        <div className="text-xs text-amber-200/80">
          <strong className="text-amber-300">Use com responsabilidade.</strong> Mensagens em massa não solicitadas podem fazer o WhatsApp <strong>banir seu número</strong>.
          O sistema já envia com intervalo entre mensagens, respeita quem pede para sair ("sair"/"parar") e tem limite diário.
          Envie só para quem tem relação com seu negócio e ofereça valor real.
        </div>
      </div>

      {/* Reativação automática (cron) */}
      {auto && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">🔁 Reativação automática</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Toda semana, envia automaticamente para clientes com compra inativos há mais de{' '}
                <input type="number" min="7" value={auto.days}
                  onChange={e => setAuto({ ...auto, days: parseInt(e.target.value, 10) || 60 })}
                  onBlur={e => saveAuto({ days: parseInt(e.target.value, 10) || 60 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-zinc-200 text-center" /> dias.
              </p>
            </div>
            <button onClick={() => saveAuto({ enabled: !auto.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${auto.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${auto.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {auto.enabled && (
            <textarea
              className="mt-3 w-full h-16 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
              placeholder="Mensagem (use {nome}). Ex.: Olá {nome}! Sentimos sua falta..."
              value={auto.message}
              onChange={e => setAuto({ ...auto, message: e.target.value })}
              onBlur={e => saveAuto({ message: e.target.value })}
            />
          )}
        </div>
      )}

      <div className="space-y-3">
        {campaigns.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="w-6 h-6" />}
            title="Nenhuma campanha ainda"
            description="Crie campanhas de WhatsApp para reativar clientes inativos ou ofertar para quem mais compra. O envio tem intervalo anti-ban e respeita quem pediu para sair."
            actionLabel="Criar primeira campanha"
            onAction={() => setShowModal(true)}
          />
        ) : campaigns.map(c => {
          const st = STATUS[c.status] || STATUS.draft;
          const done = c.sent_count + c.failed_count;
          const pct = c.total_targets ? Math.round((done / c.total_targets) * 100) : 0;
          return (
            <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-100">{c.name}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                  </div>
                  <p className="text-sm text-zinc-400 mt-1 line-clamp-2">{c.message}</p>
                  <p className="text-xs text-zinc-500 mt-2 flex items-center gap-1"><Users className="w-3 h-3" /> {c.total_targets} destinatário(s)</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {(c.status === 'draft' || c.status === 'paused') && (
                    <button onClick={() => start(c.id)} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">
                      <Play className="w-3.5 h-3.5" /> {c.status === 'paused' ? 'Retomar' : 'Iniciar'}
                    </button>
                  )}
                  {c.status === 'running' && (
                    <button onClick={() => pause(c.id)} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-300 hover:bg-amber-500/10">
                      <Pause className="w-3.5 h-3.5" /> Pausar
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-3">
                <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-zinc-500 mt-1">
                  <span>{c.sent_count} enviadas{c.failed_count > 0 ? ` · ${c.failed_count} falhas` : ''}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal nova campanha */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[520px] max-h-[90vh] overflow-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">Nova Campanha</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowModal(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Nome (interno)</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                  value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Reativação maio" />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Público</label>
                <select className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                  value={segId} onChange={e => setSegId(e.target.value)}>
                  {SEGMENTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                {preview && (
                  <p className="text-xs text-indigo-300 mt-1">
                    {preview.total} contato(s) serão atingidos{preview.sample.length ? ` (ex.: ${preview.sample.join(', ')})` : ''}.
                  </p>
                )}
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Mensagem <span className="text-zinc-600">— use {'{nome}'} para personalizar</span></label>
                <textarea className="w-full h-28 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
                  value={message} onChange={e => setMessage(e.target.value)}
                  placeholder="Olá {nome}! Estamos com uma oferta especial só para você..." />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
                <Button onClick={create} disabled={creating || !name.trim() || !message.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Send className="w-4 h-4 mr-1" /> {creating ? 'Criando...' : 'Criar campanha'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
