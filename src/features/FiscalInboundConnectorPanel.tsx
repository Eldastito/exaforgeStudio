import React, { useState, useEffect, useCallback } from 'react';
import { FileText, RefreshCw, Plug, PlugZap, AlertTriangle, ShieldCheck, Play } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

// ============================================================================
// Entrada Automática de NF-e (ADR-200, Fase 3 PR 4) — conexão fiscal por CNPJ
// com o provedor (Nuvem Fiscal). Cola credenciais CIFRADAS no servidor; elas
// NUNCA voltam pela API. A conexão nasce DESLIGADA e só liga após um probe real.
// O painel inteiro some quando o flag `fiscal_inbound_enabled` da org está off
// (a API responde 404) — feature não existe pro tenant.
// ============================================================================

type Conn = {
  id: string; environment: string; cnpj: string; storeId: string | null;
  state: string; manifestationPolicy: string; enabled: boolean;
  ultNsu: string; maxNsu: string | null; lastSuccessAt: string | null;
  lastErrorCode: string | null; lastProbeAt: string | null; blockedUntil: string | null;
};

// Situação honesta da conexão — cor + rótulo em português claro.
function stateBadge(c: Conn): { label: string; cls: string } {
  if (c.blockedUntil && new Date(c.blockedUntil).getTime() > Date.now()) return { label: 'Em espera (limite do provedor)', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' };
  switch (c.state) {
    case 'connected': return { label: 'Conectada ✅', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' };
    case 'error': return { label: `Erro${c.lastErrorCode ? ` (${c.lastErrorCode})` : ''}`, cls: 'bg-rose-500/10 text-rose-400 border-rose-500/30' };
    case 'disconnected': case 'disabled': return { label: 'Desconectada', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
    default: return { label: 'Aguardando teste', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' };
  }
}

const POLICY_LABEL: Record<string, string> = {
  manual_only: 'Manual (você manifesta)',
  auto_awareness: 'Ciência automática (libera o XML completo)',
  provider_managed: 'Gerida pelo provedor',
};

export function FiscalInboundConnectorPanel() {
  const [available, setAvailable] = useState<boolean | null>(null); // null = carregando
  const [conns, setConns] = useState<Conn[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ environment: 'homologation', cnpj: '', storeId: '', clientId: '', clientSecret: '', manifestationPolicy: 'manual_only' });

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/fiscal/inbound/connections');
      if (r.status === 404) { setAvailable(false); return; } // flag off pro tenant
      if (!r.ok) { setAvailable(false); return; }
      const d = await r.json().catch(() => ({}));
      setAvailable(true);
      setConns(Array.isArray(d.connections) ? d.connections : []);
    } catch { setAvailable(false); }
  }, []);

  const loadStores = useCallback(async () => {
    try {
      const r = await apiFetch('/api/fiscal/inbound/stores');
      if (!r.ok) return;
      const d = await r.json().catch(() => ({}));
      setStores(Array.isArray(d.stores) ? d.stores : []);
    } catch { /* opcional */ }
  }, []);

  useEffect(() => { load(); loadStores(); }, [load, loadStores]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/fiscal/inbound/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          environment: form.environment, cnpj: form.cnpj, storeId: form.storeId || null,
          clientId: form.clientId, clientSecret: form.clientSecret, manifestationPolicy: form.manifestationPolicy,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        const reason = d.reason || d.error || 'Falha ao criar a conexão.';
        if (reason === 'encryption_key_required') {
          toast.error('Falta a ENCRYPTION_KEY dedicada no servidor (produção exige, por segurança). Configure a variável de ambiente e tente de novo.');
        } else {
          toast.error(reason);
        }
        return;
      }
      toast.success('Conexão criada. Agora clique em "Testar" para validar as credenciais e ligar.');
      setForm({ environment: 'homologation', cnpj: '', storeId: '', clientId: '', clientSecret: '', manifestationPolicy: 'manual_only' });
      setShowForm(false);
      load();
    } catch { toast.error('Falha ao criar a conexão.'); }
    finally { setSaving(false); }
  };

  const probe = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/fiscal/inbound/connections/${id}/probe`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.connected) toast.success('Credenciais válidas — conexão LIGADA. ✅');
      else toast.error(`Não conectou${d.errorCode ? `: ${d.errorCode}` : ''}. Confira client_id/secret e o escopo distribuicao-nfe.`);
      load();
    } catch { toast.error('Falha ao testar a conexão.'); }
    finally { setBusyId(null); }
  };

  const sync = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/fiscal/inbound/connections/${id}/sync`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) toast.success('Sincronização enfileirada — os documentos aparecem em "Notas de Entrada" em instantes.');
      else toast.error(d.error || 'Falha ao sincronizar.');
      setTimeout(load, 4000); // dá tempo do job rodar e o cursor avançar
    } catch { toast.error('Falha ao sincronizar.'); }
    finally { setBusyId(null); }
  };

  const disconnect = async (id: string) => {
    if (!(await confirmDialog('Desconectar esta conexão fiscal? O sync automático para; o cursor e o histórico são preservados.', { danger: true, confirmText: 'Desconectar' }))) return;
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/fiscal/inbound/connections/${id}/disconnect`, { method: 'POST' });
      if (res.ok) { toast.success('Conexão desconectada.'); load(); }
      else toast.error('Falha ao desconectar.');
    } catch { toast.error('Falha ao desconectar.'); }
    finally { setBusyId(null); }
  };

  // Feature off pro tenant, ou ainda carregando → não renderiza nada.
  if (available !== true) return null;

  return (
    <div className="mb-6 p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-3">
          <FileText className="w-6 h-6" style={{ color: 'var(--color-flow)' }} />
          <div>
            <h3 className="font-semibold text-zinc-100">Entrada Automática de NF-e (Nuvem Fiscal)</h3>
            <p className="text-sm text-zinc-400">Captura as notas emitidas contra o seu CNPJ pela Distribuição DF-e. As credenciais ficam cifradas no servidor e nunca voltam pela tela.</p>
          </div>
        </div>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)} className="bg-cyan-600 hover:bg-cyan-700">
            <Plug className="w-4 h-4 mr-2" /> Conectar CNPJ
          </Button>
        )}
      </div>

      {/* Lista de conexões */}
      <div className="space-y-2">
        {conns.length === 0 && !showForm && (
          <p className="text-sm text-zinc-500 text-center py-4">Nenhuma conexão fiscal ainda. Clique em "Conectar CNPJ".</p>
        )}
        {conns.map((c) => {
          const b = stateBadge(c);
          return (
            <div key={c.id} className="p-3 rounded-lg border border-zinc-800 bg-zinc-950/40">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-200 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-zinc-500" /> CNPJ {c.cnpj}
                    <span className="text-[11px] text-zinc-500">· {c.environment === 'production' ? 'Produção' : 'Homologação'}</span>
                  </p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">
                    Cursor NSU {c.ultNsu}{c.maxNsu ? `/${c.maxNsu}` : ''} · Manifestação: {POLICY_LABEL[c.manifestationPolicy] || c.manifestationPolicy}
                    {c.lastSuccessAt ? ` · Último sync: ${new Date(c.lastSuccessAt).toLocaleString('pt-BR')}` : ''}
                  </p>
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded border ${b.cls}`}>{b.label}</span>
              </div>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => probe(c.id)} disabled={busyId === c.id} className="border-zinc-700 text-zinc-200">
                  {busyId === c.id ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <PlugZap className="w-4 h-4 mr-1" />} Testar
                </Button>
                <Button variant="outline" size="sm" onClick={() => sync(c.id)} disabled={busyId === c.id || c.state !== 'connected'} className="border-zinc-700 text-zinc-200" title={c.state !== 'connected' ? 'Teste a conexão primeiro' : ''}>
                  {busyId === c.id ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />} Sincronizar agora
                </Button>
                {c.state !== 'disconnected' && (
                  <Button variant="ghost" size="sm" onClick={() => disconnect(c.id)} disabled={busyId === c.id} className="text-rose-400 hover:text-rose-300">Desconectar</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Formulário de nova conexão */}
      {showForm && (
        <form onSubmit={create} className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400">Ambiente
              <select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100">
                <option value="homologation">Homologação (teste)</option>
                <option value="production">Produção</option>
              </select>
            </label>
            <label className="text-xs text-zinc-400">CNPJ
              <input required value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: e.target.value })}
                placeholder="00.000.000/0000-00"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Client ID (Nuvem Fiscal)
              <input required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                autoComplete="off"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Client Secret
              <input required type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                autoComplete="new-password"
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Loja padrão (opcional)
              <select value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100">
                <option value="">— sem loja padrão —</option>
                {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.cnpj ? ` (${s.cnpj})` : ''}</option>)}
              </select>
            </label>
            <label className="text-xs text-zinc-400">Manifestação
              <select value={form.manifestationPolicy} onChange={(e) => setForm({ ...form, manifestationPolicy: e.target.value })}
                className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100">
                <option value="manual_only">Manual (você manifesta)</option>
                <option value="auto_awareness">Ciência automática (libera o XML completo)</option>
                <option value="provider_managed">Gerida pelo provedor</option>
              </select>
            </label>
          </div>

          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
            <p className="text-[11px] text-cyan-200/80">
              As credenciais são cifradas no servidor (AES-256-GCM) e nunca voltam pela tela. A conexão nasce <strong>desligada</strong> — só liga depois do <strong>Testar</strong>. Em produção, o servidor exige uma <code>ENCRYPTION_KEY</code> dedicada.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving} className="bg-cyan-600 hover:bg-cyan-700 text-white">
              {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Criar conexão
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

export default FiscalInboundConnectorPanel;
