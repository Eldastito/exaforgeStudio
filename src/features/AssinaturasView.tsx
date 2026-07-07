import React, { useEffect, useState } from 'react';
import { RefreshCw, Plus, X, Check, Ban, Pause, Play, Package, FileText } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useStore } from '@/src/store/useStore';
import { EmptyState } from '@/src/components/EmptyState';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

const INP = 'w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500';
const INTERVAL_LABEL: Record<string, string> = { monthly: 'mensal', weekly: 'semanal', yearly: 'anual' };
const SUB_STATUS: Record<string, string> = { active: 'ativa', paused: 'pausada', past_due: 'em atraso', cancelled: 'cancelada' };
const INV_STATUS: Record<string, string> = { pending: 'pendente', paid: 'paga', overdue: 'vencida', cancelled: 'cancelada' };
const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

export function AssinaturasView() {
  const { contacts } = useStore();
  const [tab, setTab] = useState<'assinantes' | 'planos' | 'faturas'>('assinantes');
  const [plans, setPlans] = useState<any[]>([]);
  const [subs, setSubs] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  const [showSub, setShowSub] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/subscriptions/plans').then(r => r.json()).catch(() => []),
      apiFetch('/api/subscriptions').then(r => r.json()).catch(() => []),
      apiFetch('/api/subscriptions/invoices').then(r => r.json()).catch(() => []),
    ]).then(([p, s, i]) => {
      setPlans(Array.isArray(p) ? p : []);
      setSubs(Array.isArray(s) ? s : []);
      setInvoices(Array.isArray(i) ? i : []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const subStatus = async (id: string, status: string) => {
    try { await apiFetch(`/api/subscriptions/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); load(); }
    catch { toast.error('Falha ao atualizar.'); }
  };
  const chargeNow = async (id: string) => {
    try {
      const res = await apiFetch(`/api/subscriptions/${id}/invoice`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao gerar a fatura.'); return; }
      toast.success('Fatura gerada!'); load();
    } catch { toast.error('Falha ao gerar a fatura.'); }
  };
  const markPaid = async (invoiceId: string) => {
    try { await apiFetch(`/api/subscriptions/invoices/${invoiceId}/paid`, { method: 'POST' }); load(); }
    catch { toast.error('Falha ao marcar como paga.'); }
  };

  const TabBtn = ({ k, label }: { k: typeof tab; label: string }) => (
    <button onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-sm ${tab === k ? 'bg-emerald-500/10 text-emerald-400 font-medium' : 'text-zinc-400 hover:text-zinc-200'}`}>{label}</button>
  );

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <p className="zf-kicker mb-1">Receita Recorrente</p>
          <h2 className="zf-page-title flex items-center gap-2">
            <RefreshCw className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Assinaturas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Cobrança recorrente: mensalidades, planos e clubes.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-zinc-700 text-zinc-200" onClick={() => setShowPlan(true)}><Package className="w-4 h-4 mr-2" /> Novo plano</Button>
          <Button className="zf-button zf-button-primary" disabled={plans.length === 0} onClick={() => setShowSub(true)}><Plus className="w-4 h-4 mr-2" /> Nova assinatura</Button>
        </div>
      </div>

      <div className="flex gap-1 mb-4 border-b border-zinc-800 pb-2">
        <TabBtn k="assinantes" label="Assinantes" />
        <TabBtn k="planos" label="Planos" />
        <TabBtn k="faturas" label="Faturas" />
      </div>

      {loading ? (
        <div className="flex items-center text-zinc-500 py-10"><RefreshCw className="w-4 h-4 animate-spin mr-2" /> Carregando…</div>
      ) : tab === 'planos' ? (
        plans.length === 0 ? <EmptyState icon={<Package className="w-6 h-6" />} title="Nenhum plano" description="Crie um plano (ex.: Mensalidade R$ 99/mês) para começar a assinar clientes." />
        : <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plans.map(p => (
              <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <p className="text-sm font-semibold text-zinc-100">{p.name} {!p.active && <span className="text-xs text-zinc-500">(inativo)</span>}</p>
                {p.description && <p className="text-xs text-zinc-500 mt-0.5">{p.description}</p>}
                <p className="mt-2 text-sm font-bold text-emerald-400">{brl(p.amount)} <span className="text-xs font-normal text-zinc-500">/ {INTERVAL_LABEL[p.interval] || p.interval}</span></p>
              </div>
            ))}
          </div>
      ) : tab === 'faturas' ? (
        invoices.length === 0 ? <EmptyState icon={<FileText className="w-6 h-6" />} title="Nenhuma fatura" description="As faturas aparecem aqui quando você cobra uma assinatura (ou na cobrança automática)." />
        : <div className="space-y-2">
            {invoices.map(i => (
              <div key={i.id} className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
                <div>
                  <p className="text-sm text-zinc-100">{i.contact_name || 'Cliente'} · {i.plan_name || 'Plano'}</p>
                  <p className="text-xs text-zinc-500 font-mono">{brl(i.amount)} · venc. {i.due_date ? format(new Date(i.due_date), 'P', { locale: ptBR }) : '—'}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-semibold uppercase px-2 py-1 rounded ${i.status === 'paid' ? 'bg-emerald-500/15 text-emerald-400' : i.status === 'overdue' ? 'bg-rose-500/15 text-rose-400' : i.status === 'cancelled' ? 'bg-zinc-700 text-zinc-300' : 'bg-amber-500/15 text-amber-400'}`}>{INV_STATUS[i.status] || i.status}</span>
                  {i.status !== 'paid' && i.status !== 'cancelled' && (
                    <button onClick={() => markPaid(i.id)} title="Marcar como paga" className="text-zinc-400 hover:text-emerald-400"><Check className="w-4 h-4" /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
      ) : (
        subs.length === 0 ? <EmptyState icon={<RefreshCw className="w-6 h-6" />} title="Nenhuma assinatura" description="Crie um plano e atribua a um cliente para começar a cobrança recorrente." />
        : <div className="space-y-3">
            {subs.map(s => (
              <div key={s.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
                <div>
                  <h3 className="font-semibold text-zinc-100">{s.contact_name || 'Cliente'} · {s.plan_name || 'Plano'}</h3>
                  <p className="text-sm text-zinc-400">{brl(s.amount)} / {INTERVAL_LABEL[s.interval] || s.interval}</p>
                  <p className="text-xs text-zinc-500 font-mono mt-1">Próx. cobrança: {s.next_charge_at ? format(new Date(s.next_charge_at), 'P', { locale: ptBR }) : '—'}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`text-xs font-semibold uppercase px-2 py-1 rounded ${s.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : s.status === 'past_due' ? 'bg-rose-500/15 text-rose-400' : s.status === 'cancelled' ? 'bg-zinc-700 text-zinc-300' : 'bg-amber-500/15 text-amber-400'}`}>{SUB_STATUS[s.status] || s.status}</span>
                  {s.status !== 'cancelled' && (
                    <div className="flex items-center gap-2">
                      <button onClick={() => chargeNow(s.id)} title="Gerar fatura agora" className="text-zinc-400 hover:text-emerald-400"><FileText className="w-4 h-4" /></button>
                      {s.status === 'paused'
                        ? <button onClick={() => subStatus(s.id, 'active')} title="Retomar" className="text-zinc-400 hover:text-emerald-400"><Play className="w-4 h-4" /></button>
                        : <button onClick={() => subStatus(s.id, 'paused')} title="Pausar" className="text-zinc-400 hover:text-amber-400"><Pause className="w-4 h-4" /></button>}
                      <button onClick={() => subStatus(s.id, 'cancelled')} title="Cancelar" className="text-zinc-400 hover:text-rose-400"><Ban className="w-4 h-4" /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
      )}

      {showPlan && <PlanModal onClose={() => setShowPlan(false)} onSaved={() => { setShowPlan(false); load(); }} />}
      {showSub && <SubModal plans={plans.filter(p => p.active)} contacts={Object.values(contacts)} onClose={() => setShowSub(false)} onSaved={() => { setShowSub(false); load(); }} />}
    </div>
  );
}

function PlanModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', amount: '', interval: 'monthly' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/subscriptions/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name.trim(), description: form.description, amount: Number(form.amount) || 0, interval: form.interval }) });
      toast.success('Plano criado!'); onSaved();
    } catch { toast.error('Falha ao criar o plano.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Novo plano de assinatura" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nome (ex.: Mensalidade, Plano Black)"><input className={INP} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Descrição (opcional)"><input className={INP} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Valor"><input type="number" min="0" step="0.01" className={INP} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label="Ciclo"><select className={INP} value={form.interval} onChange={e => setForm({ ...form, interval: e.target.value })}>
            <option value="monthly">Mensal</option><option value="weekly">Semanal</option><option value="yearly">Anual</option>
          </select></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()} className="zf-button zf-button-primary">{saving ? 'Salvando…' : 'Criar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function SubModal({ plans, contacts, onClose, onSaved }: { plans: any[]; contacts: any[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ planId: plans[0]?.id || '', contactId: '', startDate: '' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.planId || !form.contactId) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: form.planId, contactId: form.contactId, startDate: form.startDate || undefined }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao criar.'); return; }
      toast.success('Assinatura criada!'); onSaved();
    } catch { toast.error('Falha ao criar a assinatura.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Nova assinatura" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Plano"><select className={INP} value={form.planId} onChange={e => setForm({ ...form, planId: e.target.value })}>
          {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></Field>
        <Field label="Cliente"><select className={INP} value={form.contactId} onChange={e => setForm({ ...form, contactId: e.target.value })}>
          <option value="">Selecione um contato</option>
          {contacts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></Field>
        <Field label="Início (opcional — padrão hoje)"><input type="date" className={INP} value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={saving || !form.planId || !form.contactId} className="zf-button zf-button-primary">{saving ? 'Salvando…' : 'Assinar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[440px] max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-sm text-zinc-400 mb-1 block">{label}</label>{children}</div>;
}
