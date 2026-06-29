import React, { useEffect, useState, useCallback } from 'react';
import { Target, Plus, Loader2, Trash2, Megaphone, Crosshair, X, Upload, Building2, Mail, Phone, Sparkles, Check, Gauge, Send, Inbox, PenLine, Trophy, TrendingUp, Lightbulb, Radar, MapPin, Play } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type Icp = { id: string; name: string; vertical?: string; criteria?: any; created_at: string };
type Campaign = { id: string; name: string; icp_id?: string; icp_name?: string; objective: string; status: string; created_at: string; discovery_enabled?: number; discovery_address?: string; discovery_radius_km?: number; discovery_categories?: string; discovery_last_run?: string };
type Account = { id: string; display_name: string; domain?: string; website_url?: string; industry?: string; city?: string; state?: string; account_status: string; contacts_count?: number; contacts?: any[] };

// Parser CSV mínimo (campos com aspas, vírgulas e quebras de linha).
function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const TARGET_FIELDS: { key: string; label: string; guess: RegExp }[] = [
  { key: 'company', label: 'Empresa *', guess: /empresa|company|raz[aã]o|fantasia|neg[oó]cio/i },
  { key: 'website', label: 'Site', guess: /site|website|url|web/i },
  { key: 'domain', label: 'Domínio', guess: /dom[ií]nio|domain/i },
  { key: 'cnpj', label: 'CNPJ', guess: /cnpj/i },
  { key: 'industry', label: 'Segmento', guess: /segmento|setor|industry|categoria|ramo/i },
  { key: 'city', label: 'Cidade', guess: /cidade|city|munic/i },
  { key: 'state', label: 'UF', guess: /estado|uf|state/i },
  { key: 'contactName', label: 'Contato (nome)', guess: /contato|respons|nome|name/i },
  { key: 'role', label: 'Cargo', guess: /cargo|fun[cç][aã]o|role|title/i },
  { key: 'email', label: 'E-mail', guess: /e-?mail/i },
  { key: 'phone', label: 'Telefone', guess: /telefone|phone|whats|celular|fone|tel/i },
];

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
const ACCOUNT_STATUS: Record<string, string> = {
  discovered: 'Descoberta', researching: 'Pesquisando', qualified: 'Qualificada',
  disqualified: 'Desqualificada', contacted: 'Contatada', converted: 'Convertida',
};
const brl = (n: number) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const OUT_CHANNELS: { id: string; label: string }[] = [
  { id: 'email', label: 'E-mail' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'call', label: 'Ligação (roteiro)' },
  { id: 'linkedin_manual', label: 'LinkedIn (manual)' },
];
const OUT_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-slate-300 bg-slate-500/10 border-slate-500/30' },
  pending_approval: { label: 'Em aprovação', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  sent: { label: 'Enviada', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  rejected: { label: 'Descartada', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
};

export function ProspectView() {
  const [icps, setIcps] = useState<Icp[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [newIcp, setNewIcp] = useState(false);
  const [newCamp, setNewCamp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [attr, setAttr] = useState<any>(null);
  const [discoveryCamp, setDiscoveryCamp] = useState<Campaign | null>(null);
  const [runs, setRuns] = useState<any[]>([]);

  const loadAccounts = useCallback(() => apiFetch('/api/prospect/accounts').then(r => r.json()).then(d => setAccounts(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadQueue = useCallback(() => apiFetch('/api/prospect/approval-queue').then(r => r.json()).then(d => setQueue(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadAttr = useCallback(() => apiFetch('/api/prospect/attribution').then(r => r.json()).then(d => setAttr(d && typeof d === 'object' ? d : null)).catch(() => {}), []);
  const loadRuns = useCallback(() => apiFetch('/api/prospect/discovery/runs').then(r => r.json()).then(d => setRuns(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadCampaigns = useCallback(() => apiFetch('/api/prospect/campaigns').then(r => r.json()).then(d => setCampaigns(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/prospect/icps').then(r => r.json()).then(d => setIcps(Array.isArray(d) ? d : [])).catch(() => {}),
      loadCampaigns(),
      loadAccounts(),
      loadQueue(),
      loadAttr(),
      loadRuns(),
    ]).finally(() => setLoading(false));
  }, [loadAccounts, loadQueue, loadAttr, loadRuns, loadCampaigns]);
  useEffect(() => { load(); }, [load]);

  const openDiscovery = () => {
    if (!icps.length) { toast.error('Crie um ICP primeiro (descreve quem você quer prospectar).'); setNewIcp(true); return; }
    if (!campaigns.length) { toast.error('Crie uma campanha primeiro — é nela que você define a região da busca.'); setNewCamp(true); return; }
    setDiscoveryCamp(campaigns[0]);
  };

  const queueAction = async (oid: string, status: string) => {
    try {
      const r = await apiFetch(`/api/prospect/outreach/${oid}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success(status === 'approved' ? 'Abordagem aprovada. ✅' : status === 'sent' ? 'Marcada como enviada. 📨' : 'Voltou para rascunho.');
      loadQueue(); loadAccounts();
    } catch (e: any) { toast.error(e.message); }
  };

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
          <Crosshair className="w-3.5 h-3.5" /> Defina o <b>ICP</b>, importe contas, registre <b>evidências</b>, gere hipóteses e <b>abordagens</b> com IA — tudo revisado por um humano antes de sair. Sem scraping, sem spam.
        </div>
      </div>

      {/* Receita originada pela prospecção (atribuição) */}
      <div className="mb-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/80"><Trophy className="w-3.5 h-3.5" /> Receita originada</div>
          <div className="text-2xl font-semibold text-emerald-300 mt-1 tabular-nums">{brl(attr?.totalWon || 0)}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">{attr?.wonCount || 0} conta(s) ganha(s)</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400"><Building2 className="w-3.5 h-3.5" /> Em pipeline</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">{attr?.pipelineCount ?? 0}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">contas em aberto</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400"><TrendingUp className="w-3.5 h-3.5" /> Taxa de ganho</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">{attr?.winRate ?? 0}%</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">ganhas ÷ (ganhas + perdidas)</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400"><Gauge className="w-3.5 h-3.5" /> Ticket médio</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1 tabular-nums">{brl(attr?.avgDeal || 0)}</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">por conta ganha</div>
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
                      {c.discovery_enabled ? <span className="text-[9px] px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-300 inline-flex items-center gap-1"><Radar className="w-2.5 h-2.5" /> auto</span> : null}
                      <button onClick={() => setDiscoveryCamp(c)} className="ml-auto text-[11px] text-violet-300 hover:text-violet-200 inline-flex items-center gap-1"><Radar className="w-3 h-3" /> Descoberta</button>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">{obj}{c.icp_name ? ` · ICP: ${c.icp_name}` : ''}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Contas */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Building2 className="w-4 h-4 text-cyan-400" /> Contas ({accounts.length})</h3>
          <div className="flex items-center gap-2">
            <Button onClick={openDiscovery} className="bg-violet-600 hover:bg-violet-700 text-white h-8 px-2.5 text-xs"><Radar className="w-3.5 h-3.5 mr-1" /> Descobrir com IA</Button>
            <Button onClick={() => setImporting(true)} variant="ghost" className="text-zinc-300 h-8 px-2.5 text-xs"><Upload className="w-3.5 h-3.5 mr-1" /> Importar CSV</Button>
          </div>
        </div>
        {loading ? <Spinner /> : accounts.length === 0 ? (
          <div className="py-8 text-center">
            <Radar className="w-8 h-8 text-violet-400/70 mx-auto mb-2" />
            <p className="text-sm text-zinc-300 font-medium">Deixe a IA encontrar empresas pra você</p>
            <p className="text-[12px] text-zinc-600 mt-1 max-w-md mx-auto">Informe um endereço/CEP + raio e a IA busca empresas da região (fontes públicas, sem custo) — ou importe uma planilha CSV. Tudo para na sua revisão.</p>
            <div className="flex items-center justify-center gap-2 mt-3">
              <Button onClick={openDiscovery} className="bg-violet-600 hover:bg-violet-700 text-white h-8 px-3 text-xs"><Radar className="w-3.5 h-3.5 mr-1" /> Descobrir com IA</Button>
              <Button onClick={() => setImporting(true)} variant="ghost" className="text-zinc-400 h-8 px-3 text-xs"><Upload className="w-3.5 h-3.5 mr-1" /> Importar CSV</Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="text-zinc-500 text-xs border-b border-zinc-800">
                <tr><th className="py-2 pr-3 font-medium">Empresa</th><th className="py-2 pr-3 font-medium">Domínio</th><th className="py-2 pr-3 font-medium">Local</th><th className="py-2 pr-3 font-medium">Contatos</th><th className="py-2 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {accounts.map(a => (
                  <tr key={a.id} onClick={() => setDetailId(a.id)} className="cursor-pointer hover:bg-zinc-800/20">
                    <td className="py-2 pr-3 text-zinc-200">{a.display_name}</td>
                    <td className="py-2 pr-3 text-zinc-500">{a.domain || '—'}</td>
                    <td className="py-2 pr-3 text-zinc-500">{[a.city, a.state].filter(Boolean).join('/') || '—'}</td>
                    <td className="py-2 pr-3 text-zinc-400">{a.contacts_count ?? 0}</td>
                    <td className="py-2"><span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">{ACCOUNT_STATUS[a.account_status] || a.account_status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Descoberta automática — rodadas recentes (resumo da noite) */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Radar className="w-4 h-4 text-violet-400" /> Descoberta automática</h3>
          <span className="text-[11px] text-zinc-600">A IA varre a região (19h–6h) e deixa as contas prontas pra você revisar.</span>
        </div>
        {loading ? <Spinner /> : runs.length === 0 ? (
          <Empty text="Nenhuma rodada ainda. Abra uma campanha em “Descoberta”, informe o endereço/CEP + raio e ative — ou rode agora pra testar." />
        ) : (
          <div className="space-y-2">
            {runs.slice(0, 8).map(r => (
              <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${r.status === 'done' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : r.status === 'error' ? 'text-red-300 bg-red-500/10 border-red-500/30' : 'text-amber-300 bg-amber-500/10 border-amber-500/30'}`}>{r.status === 'done' ? 'Concluída' : r.status === 'error' ? 'Erro' : 'Rodando'}</span>
                  <span className="text-xs text-zinc-300 inline-flex items-center gap-1"><MapPin className="w-3 h-3 text-zinc-500" /> {r.area}</span>
                  <span className="text-[10px] text-zinc-500">{r.trigger === 'manual' ? 'manual' : 'automática'}</span>
                  <span className="ml-auto text-[11px] text-zinc-400">+{r.created_count} nova(s) · {r.found_count} achada(s)</span>
                </div>
                {r.summary && <p className="text-[11px] text-zinc-400 mt-1">{r.summary}</p>}
                {r.error && <p className="text-[11px] text-red-400 mt-1">{r.error}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fila de aprovação */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Inbox className="w-4 h-4 text-cyan-400" /> Fila de aprovação ({queue.length})</h3>
          <span className="text-[11px] text-zinc-600">Toda abordagem é revisada por um humano antes de sair.</span>
        </div>
        {loading ? <Spinner /> : queue.length === 0 ? (
          <Empty text="Nenhuma abordagem aguardando aprovação. Gere um rascunho dentro de uma conta e envie para aprovação." />
        ) : (
          <div className="space-y-2">
            {queue.map(o => (
              <div key={o.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">{OUT_CHANNELS.find(c => c.id === o.channel)?.label || o.channel}</span>
                      <button onClick={() => setDetailId(o.prospect_account_id)} className="text-sm font-medium text-zinc-100 hover:text-cyan-300 truncate">{o.account_name}</button>
                      {o.contact_name && <span className="text-[11px] text-zinc-500">→ {o.contact_name}</span>}
                    </div>
                    {o.subject && <p className="text-xs text-zinc-300 mt-1 truncate"><span className="text-zinc-500">Assunto:</span> {o.subject}</p>}
                    <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2 whitespace-pre-wrap">{o.body}</p>
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button onClick={() => queueAction(o.id, 'approved')} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white inline-flex items-center gap-1"><Check className="w-3 h-3" /> Aprovar</button>
                    <button onClick={() => queueAction(o.id, 'draft')} className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">Editar</button>
                    <button onClick={() => queueAction(o.id, 'rejected')} className="text-[11px] px-2 py-1 rounded-lg text-zinc-500 hover:text-red-400">Descartar</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {newIcp && <IcpModal onClose={() => setNewIcp(false)} onSaved={() => { setNewIcp(false); load(); }} />}
      {newCamp && <CampaignModal icps={icps} onClose={() => setNewCamp(false)} onSaved={() => { setNewCamp(false); load(); }} />}
      {discoveryCamp && <DiscoveryModal campaign={discoveryCamp} onClose={() => setDiscoveryCamp(null)} onChanged={() => { loadCampaigns(); loadRuns(); loadAccounts(); }} />}
      {importing && <ImportModal campaigns={campaigns} onClose={() => setImporting(false)} onDone={() => { setImporting(false); loadAccounts(); }} />}
      {detailId && <AccountDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={() => { loadAccounts(); loadQueue(); loadAttr(); }} />}
    </div>
  );
}

const Spinner = () => <div className="flex items-center gap-2 text-zinc-500 text-sm py-6"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
const Empty = ({ text }: { text: string }) => <p className="text-[12px] text-zinc-600 py-6 text-center">{text}</p>;

function ImportModal({ campaigns, onClose, onDone }: { campaigns: Campaign[]; onClose: () => void; onDone: () => void }) {
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const onFile = async (f: File | null) => {
    if (!f) return;
    setFileName(f.name);
    const text = await f.text();
    const parsed = parseCSV(text);
    if (!parsed.length) { toast.error('CSV vazio ou ilegível.'); return; }
    const hdr = parsed[0].map(h => h.trim());
    setHeaders(hdr); setRows(parsed.slice(1));
    // Auto-mapeia por palavra-chave no cabeçalho.
    const guess: Record<string, number> = {};
    for (const tf of TARGET_FIELDS) {
      const idx = hdr.findIndex(h => tf.guess.test(h));
      if (idx >= 0) guess[tf.key] = idx;
    }
    setMapping(guess);
  };

  const buildRecords = () => rows.map(r => {
    const rec: any = {};
    for (const tf of TARGET_FIELDS) { const i = mapping[tf.key]; if (i !== undefined && i >= 0) rec[tf.key] = (r[i] || '').trim(); }
    return rec;
  }).filter(rec => (rec.company || '').trim() || (rec.domain || rec.website || rec.email || '').trim());

  const doImport = async () => {
    if (mapping.company === undefined) { toast.error('Mapeie ao menos a coluna "Empresa".'); return; }
    const records = buildRecords();
    if (!records.length) { toast.error('Nenhuma linha válida para importar.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/prospect/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records, sourceRef: fileName, campaignId: campaignId || null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao importar.');
      setResult(d);
      toast.success(`Importado: ${d.accountsCreated} contas, ${d.contactsCreated} contatos.`);
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[560px] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Upload className="w-5 h-5 text-cyan-400" /> Importar contas (CSV)</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        {result ? (
          <div className="text-sm text-zinc-300 space-y-2">
            <p className="text-emerald-400 font-medium">Importação concluída ✅</p>
            <ul className="text-xs text-zinc-400 space-y-1">
              <li>• Contas criadas: <b className="text-zinc-200">{result.accountsCreated}</b></li>
              <li>• Contas já existentes (mescladas): <b className="text-zinc-200">{result.accountsMerged}</b></li>
              <li>• Contatos criados: <b className="text-zinc-200">{result.contactsCreated}</b></li>
              <li>• Contatos duplicados (ignorados): <b className="text-zinc-200">{result.contactsSkipped}</b></li>
              <li>• Linhas processadas: {result.total}</li>
            </ul>
            <div className="flex justify-end pt-2"><Button onClick={onDone} className="bg-cyan-600 hover:bg-cyan-700 text-white">Concluir</Button></div>
          </div>
        ) : !headers.length ? (
          <>
            <label className="flex items-center justify-center gap-2 w-full cursor-pointer rounded-lg border border-dashed border-zinc-700 bg-zinc-950 py-8 text-sm text-zinc-400 hover:border-cyan-500/50 hover:text-zinc-200 transition-colors">
              <Upload className="w-4 h-4" /> Selecionar arquivo .csv
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => onFile(e.target.files?.[0] || null)} />
            </label>
            <p className="mt-3 text-[11px] text-zinc-600">Use uma planilha com suas empresas/contatos (1 linha por contato). A origem é registrada e os duplicados são mesclados por domínio/e-mail. Sem scraping.</p>
          </>
        ) : (
          <>
            <p className="text-xs text-zinc-500 mb-3">{fileName} · {rows.length} linha(s). Confira o mapeamento das colunas:</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {TARGET_FIELDS.map(tf => (
                <div key={tf.key}>
                  <label className="text-[11px] text-zinc-400 mb-0.5 block">{tf.label}</label>
                  <select value={mapping[tf.key] ?? -1} onChange={e => setMapping(m => ({ ...m, [tf.key]: parseInt(e.target.value, 10) }))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500">
                    <option value={-1}>— ignorar —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `coluna ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <label className="text-[11px] text-zinc-400 mb-0.5 block">Vincular à campanha (opcional)</label>
            <select value={campaignId} onChange={e => setCampaignId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-cyan-500 mb-4">
              <option value="">Nenhuma</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setHeaders([]); setRows([]); setFileName(''); }} disabled={busy}>Trocar arquivo</Button>
              <Button onClick={doImport} disabled={busy} className="bg-cyan-600 hover:bg-cyan-700 text-white">
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}Importar {buildRecords().length} linha(s)
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const SIGNAL_TYPES: { id: string; label: string }[] = [
  { id: 'cobertura_digital', label: 'Cobertura digital' },
  { id: 'complexidade_operacional', label: 'Complexidade operacional' },
  { id: 'oferta', label: 'Oferta / serviços' },
  { id: 'crescimento', label: 'Crescimento' },
  { id: 'conteudo_proprio', label: 'Conteúdo próprio' },
  { id: 'resposta_comercial', label: 'Resposta comercial' },
  { id: 'outro', label: 'Outro' },
];

function AccountDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [acc, setAcc] = useState<Account | any>(null);
  const [sigType, setSigType] = useState('cobertura_digital');
  const [sigObs, setSigObs] = useState('');
  const [sigRef, setSigRef] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [scoreBusy, setScoreBusy] = useState(false);
  const [outChannel, setOutChannel] = useState('email');
  const [outContact, setOutContact] = useState('');
  const [outBusy, setOutBusy] = useState(false);
  const [copilot, setCopilot] = useState('');
  const [copilotBusy, setCopilotBusy] = useState(false);
  const [wonValue, setWonValue] = useState('');
  const [lostReason, setLostReason] = useState('');
  const [outcomeMode, setOutcomeMode] = useState<'' | 'won' | 'lost'>('');

  const refresh = () => apiFetch(`/api/prospect/accounts/${id}`).then(r => r.json()).then(d => { if (d && d.id) setAcc(d); }).catch(() => {});
  useEffect(() => { refresh(); }, [id]);
  const apply = (d: any) => { if (d && d.id) setAcc(d); onChanged(); };

  const setStatus = async (status: string) => {
    try {
      const r = await apiFetch(`/api/prospect/accounts/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error();
      setAcc((a: any) => a ? { ...a, account_status: status } : a); onChanged();
    } catch { toast.error('Não foi possível atualizar o status.'); }
  };
  const addSignal = async () => {
    if (!sigObs.trim()) { toast.error('Descreva o dado observado.'); return; }
    try {
      const r = await apiFetch(`/api/prospect/accounts/${id}/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signalType: sigType, observation: sigObs, evidenceReference: sigRef }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); setSigObs(''); setSigRef('');
    } catch (e: any) { toast.error(e.message); }
  };
  const removeSignal = async (sid: string) => {
    try { const r = await apiFetch(`/api/prospect/accounts/${id}/signals/${sid}`, { method: 'DELETE' }); const d = await r.json(); if (!r.ok) throw new Error(); apply(d); } catch { toast.error('Falha ao remover.'); }
  };
  const genHyp = async () => {
    setGenBusy(true);
    try {
      const r = await apiFetch(`/api/prospect/accounts/${id}/hypotheses`, { method: 'POST' });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d);
      toast.success('Hipóteses geradas. Revise e aprove. 💡');
    } catch (e: any) { toast.error(e.message); } finally { setGenBusy(false); }
  };
  const setHyp = async (hid: string, status: string) => {
    try { const r = await apiFetch(`/api/prospect/accounts/${id}/hypotheses/${hid}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); const d = await r.json(); if (!r.ok) throw new Error(); apply(d); } catch { toast.error('Falha.'); }
  };
  const recompute = async () => {
    setScoreBusy(true);
    try { const r = await apiFetch(`/api/prospect/accounts/${id}/score`, { method: 'POST' }); if (!r.ok) throw new Error(); await refresh(); toast.success('Score recalculado.'); }
    catch { toast.error('Falha ao calcular o score.'); } finally { setScoreBusy(false); }
  };
  const compose = async () => {
    setOutBusy(true);
    try {
      const r = await apiFetch(`/api/prospect/accounts/${id}/outreach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: outChannel, contactId: outContact || null }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d);
      toast.success('Rascunho gerado. Revise e envie para aprovação. ✍️');
    } catch (e: any) { toast.error(e.message); } finally { setOutBusy(false); }
  };
  const saveOutreach = async (oid: string, patch: { subject?: string; body?: string }) => {
    try { const r = await apiFetch(`/api/prospect/outreach/${oid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); toast.success('Abordagem salva.'); }
    catch (e: any) { toast.error(e.message); }
  };
  const outStatus = async (oid: string, status: string) => {
    try { const r = await apiFetch(`/api/prospect/outreach/${oid}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d); }
    catch (e: any) { toast.error(e.message); }
  };
  const askCopilot = async () => {
    setCopilotBusy(true);
    try { const r = await apiFetch(`/api/prospect/accounts/${id}/copilot`, { method: 'POST' }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); setCopilot(d.advice || ''); }
    catch (e: any) { toast.error(e.message); } finally { setCopilotBusy(false); }
  };
  const recordOutcome = async (outcome: string, body: any = {}) => {
    try {
      const r = await apiFetch(`/api/prospect/accounts/${id}/outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome, ...body }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha'); apply(d);
      setOutcomeMode(''); setWonValue(''); setLostReason('');
      toast.success(outcome === 'won' ? 'Conta marcada como ganha. 🏆' : outcome === 'lost' ? 'Conta marcada como perdida.' : 'Conta reaberta.');
    } catch (e: any) { toast.error(e.message); }
  };

  const sc = acc?.score;
  let icpMatch: boolean | null = null;
  try { if (sc?.explanation_json) icpMatch = JSON.parse(sc.explanation_json).icpMatch ?? null; } catch { /* ignore */ }
  const ScoreBar = ({ label, v }: { label: string; v: number }) => (
    <div><div className="flex justify-between text-[10px] text-zinc-500"><span>{label}</span><span className="text-zinc-300">{Math.round(v || 0)}</span></div>
      <div className="h-1.5 rounded-full bg-zinc-800 mt-0.5"><div className="h-1.5 rounded-full bg-cyan-500" style={{ width: `${Math.max(0, Math.min(100, v || 0))}%` }} /></div></div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-[460px] bg-zinc-900 border-l border-zinc-800 overflow-auto p-5" onClick={e => e.stopPropagation()}>
        {!acc ? <Spinner /> : (
          <>
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-zinc-100 truncate">{acc.display_name}</h3>
                {acc.domain && <a href={`https://${acc.domain}`} target="_blank" rel="noreferrer" className="text-xs text-cyan-400 hover:text-cyan-300">{acc.domain}</a>}
              </div>
              <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400 mb-3">
              {acc.industry && <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2"><span className="text-zinc-500 block">Segmento</span>{acc.industry}</div>}
              {(acc.city || acc.state) && <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2"><span className="text-zinc-500 block">Local</span>{[acc.city, acc.state].filter(Boolean).join('/')}</div>}
            </div>

            <label className="text-[11px] text-zinc-500 mb-1 block">Status da conta</label>
            <select value={acc.account_status} onChange={e => setStatus(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-cyan-500 mb-3">
              {Object.entries(ACCOUNT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>

            {/* Desfecho (atribuição de receita) */}
            {acc.account_status === 'converted' ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 mb-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-emerald-300 inline-flex items-center gap-1"><Trophy className="w-3.5 h-3.5" /> Ganha · {brl(acc.won_value || 0)}</span>
                  <button onClick={() => recordOutcome('reopen')} className="text-[10px] text-zinc-500 hover:text-zinc-300">reabrir</button>
                </div>
              </div>
            ) : acc.account_status === 'disqualified' ? (
              <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3 mb-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-zinc-400 truncate">Perdida{acc.lost_reason ? ` · ${acc.lost_reason}` : ''}</span>
                  <button onClick={() => recordOutcome('reopen')} className="text-[10px] text-zinc-500 hover:text-zinc-300 shrink-0">reabrir</button>
                </div>
              </div>
            ) : outcomeMode === 'won' ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 mb-4 space-y-2">
                <label className="text-[11px] text-emerald-300 block">Valor fechado (receita originada)</label>
                <input value={wonValue} onChange={e => setWonValue(e.target.value.replace(/[^\d.,]/g, ''))} inputMode="decimal" placeholder="Ex.: 4500" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setOutcomeMode('')} className="text-[11px] text-zinc-500 hover:text-zinc-300">cancelar</button>
                  <button onClick={() => recordOutcome('won', { wonValue: parseFloat(wonValue.replace(/\./g, '').replace(',', '.')) || 0 })} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">Confirmar ganho</button>
                </div>
              </div>
            ) : outcomeMode === 'lost' ? (
              <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3 mb-4 space-y-2">
                <label className="text-[11px] text-zinc-400 block">Motivo da perda (opcional)</label>
                <input value={lostReason} onChange={e => setLostReason(e.target.value)} placeholder="Ex.: sem orçamento agora" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-cyan-500" />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setOutcomeMode('')} className="text-[11px] text-zinc-500 hover:text-zinc-300">cancelar</button>
                  <button onClick={() => recordOutcome('lost', { lostReason })} className="text-[11px] px-2 py-1 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-100">Marcar perdida</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2 mb-4">
                <button onClick={() => setOutcomeMode('won')} className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white inline-flex items-center justify-center gap-1"><Trophy className="w-3.5 h-3.5" /> Marcar como ganha</button>
                <button onClick={() => setOutcomeMode('lost')} className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300">Marcar como perdida</button>
              </div>
            )}

            {/* Copiloto do SDR */}
            <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-3 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-violet-300 flex items-center gap-1"><Lightbulb className="w-3.5 h-3.5" /> Copiloto do SDR</span>
                <button onClick={askCopilot} disabled={copilotBusy} className="text-[11px] text-violet-300 hover:text-violet-200 inline-flex items-center gap-1">{copilotBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} {copilot ? 'Atualizar' : 'Próxima melhor ação'}</button>
              </div>
              {copilot
                ? <p className="text-xs text-zinc-200 whitespace-pre-wrap mt-2">{copilot}</p>
                : <p className="text-[11px] text-zinc-500 mt-1">A IA sugere o próximo passo com base nas evidências, score e abordagens — sem inventar dados.</p>}
            </div>

            {/* Score */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1 flex-wrap"><Gauge className="w-3.5 h-3.5 text-cyan-400" /> Score{sc ? <span className="ml-1 text-cyan-300">· Prioridade {Math.round(sc.priority)}</span> : ''}{icpMatch === false ? <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300 normal-case">fora do perfil</span> : icpMatch === true ? <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 normal-case">no perfil</span> : null}</span>
                <button onClick={recompute} disabled={scoreBusy} className="text-[11px] text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">{scoreBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Gauge className="w-3 h-3" />} {sc ? 'Recalcular' : 'Calcular'}</button>
              </div>
              {sc ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <ScoreBar label="Aderência" v={sc.account_fit} />
                  <ScoreBar label="Evidência de dor" v={sc.pain_evidence} />
                  <ScoreBar label="Contatabilidade" v={sc.reachability} />
                  <ScoreBar label="Confiança do dado" v={sc.data_confidence} />
                  <ScoreBar label="Conformidade" v={sc.compliance} />
                </div>
              ) : <p className="text-[11px] text-zinc-600">Calcule o score a partir dos dados, contatos e evidências.</p>}
            </div>

            {/* Evidências */}
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Evidências ({acc.signals?.length || 0})</p>
            <div className="space-y-1.5 mb-2">
              {(acc.signals || []).length === 0 && <p className="text-[11px] text-zinc-600">Nenhuma evidência. Registre o que você observou (site, materiais, resposta do prospect).</p>}
              {(acc.signals || []).map((s: any) => (
                <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs">
                  <div className="flex items-start gap-2">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300 shrink-0">{SIGNAL_TYPES.find(t => t.id === s.signal_type)?.label || s.signal_type}</span>
                    <span className="flex-1 text-zinc-200">{s.observation}</span>
                    <button onClick={() => removeSignal(s.id)} className="text-zinc-600 hover:text-red-400 shrink-0"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  {s.evidence_reference && <p className="text-[10px] text-zinc-500 mt-0.5 truncate">fonte: {s.evidence_reference}</p>}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              <select value={sigType} onChange={e => setSigType(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none">
                {SIGNAL_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              <input value={sigObs} onChange={e => setSigObs(e.target.value)} placeholder="O que você observou" className="flex-1 min-w-[120px] bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500" />
              <input value={sigRef} onChange={e => setSigRef(e.target.value)} placeholder="fonte/URL (opc.)" className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none" />
              <button onClick={addSignal} className="px-2 py-1 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700"><Plus className="w-3.5 h-3.5" /></button>
            </div>

            {/* Hipóteses de dor */}
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Hipóteses de dor ({acc.hypotheses?.length || 0})</p>
              <button onClick={genHyp} disabled={genBusy} className="text-[11px] text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">{genBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Gerar com IA</button>
            </div>
            <div className="space-y-2 mb-3">
              {(acc.hypotheses || []).length === 0 && <p className="text-[11px] text-zinc-600">Adicione evidências e gere hipóteses (linguagem probabilística, com base só nas evidências).</p>}
              {(acc.hypotheses || []).map((h: any) => (
                <div key={h.id} className={`rounded-lg border p-2.5 ${h.status === 'approved' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-950'}`}>
                  <p className="text-xs text-zinc-200">{h.hypothesis}</p>
                  {h.recommended_question && <p className="text-[11px] text-cyan-300 mt-1">❓ {h.recommended_question}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">confiança: {h.confidence}</span>
                    {h.status === 'approved'
                      ? <span className="text-[10px] text-emerald-400 inline-flex items-center gap-1"><Check className="w-3 h-3" /> aprovada</span>
                      : <button onClick={() => setHyp(h.id, 'approved')} className="text-[10px] text-emerald-400 hover:text-emerald-300">aprovar</button>}
                    <button onClick={() => setHyp(h.id, 'rejected')} className="text-[10px] text-zinc-500 hover:text-red-400">descartar</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Contatos */}
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Contatos ({acc.contacts?.length || 0})</p>
            <div className="space-y-2 mb-4">
              {(acc.contacts || []).length === 0 && <p className="text-[11px] text-zinc-600">Nenhum contato.</p>}
              {(acc.contacts || []).map((c: any) => (
                <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
                  <p className="text-sm text-zinc-200">{c.full_name || '(sem nome)'}{c.role_title ? <span className="text-zinc-500"> · {c.role_title}</span> : ''}</p>
                  {c.email && <p className="text-[11px] text-zinc-400 inline-flex items-center gap-1 mt-0.5"><Mail className="w-3 h-3" /> {c.email}</p>}
                  {c.phone && <p className="text-[11px] text-zinc-400 inline-flex items-center gap-1 mt-0.5 ml-3"><Phone className="w-3 h-3" /> {c.phone}</p>}
                </div>
              ))}
            </div>

            {/* Abordagem (composer IA + aprovação) */}
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1"><PenLine className="w-3.5 h-3.5 text-cyan-400" /> Abordagem ({(acc.outreach || []).length})</p>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 mb-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <select value={outChannel} onChange={e => setOutChannel(e.target.value)} className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none">
                  {OUT_CHANNELS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <select value={outContact} onChange={e => setOutContact(e.target.value)} className="flex-1 min-w-[120px] bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none">
                  <option value="">Sem contato específico</option>
                  {(acc.contacts || []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name || c.email || '(contato)'}</option>)}
                </select>
                <button onClick={compose} disabled={outBusy} className="px-2.5 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white text-xs inline-flex items-center gap-1 disabled:opacity-60">
                  {outBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Gerar rascunho
                </button>
              </div>
              <p className="text-[10px] text-zinc-600 mt-1.5">A IA escreve a partir das evidências e hipóteses aprovadas — sem inventar dados. Nada é enviado sem aprovação humana.</p>
            </div>
            <div className="space-y-2">
              {(acc.outreach || []).length === 0 && <p className="text-[11px] text-zinc-600">Nenhuma abordagem ainda. Gere um rascunho acima.</p>}
              {(acc.outreach || []).map((o: any) => (
                <OutreachCard key={o.id} o={o} onSave={saveOutreach} onStatus={outStatus} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OutreachCard({ o, onSave, onStatus }: { o: any; onSave: (oid: string, patch: { subject?: string; body?: string }) => void; onStatus: (oid: string, status: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(o.subject || '');
  const [body, setBody] = useState(o.body || '');
  const b = OUT_STATUS[o.status] || OUT_STATUS.draft;
  const dirty = subject !== (o.subject || '') || body !== (o.body || '');
  const editable = o.status === 'draft';
  const isEmail = o.channel === 'email';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[9px] px-1.5 py-0.5 rounded border ${b.cls}`}>{b.label}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">{OUT_CHANNELS.find(c => c.id === o.channel)?.label || o.channel}</span>
        </div>
        {editable && !editing && <button onClick={() => setEditing(true)} className="text-[11px] text-zinc-400 hover:text-cyan-300 inline-flex items-center gap-1"><PenLine className="w-3 h-3" /> editar</button>}
      </div>

      {editing ? (
        <div className="space-y-1.5">
          {isEmail && <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Assunto" className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500" />}
          <textarea value={body} onChange={e => setBody(e.target.value)} className="w-full h-32 bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-xs text-zinc-100 resize-none outline-none focus:border-cyan-500" />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setSubject(o.subject || ''); setBody(o.body || ''); setEditing(false); }} className="text-[11px] text-zinc-500 hover:text-zinc-300">cancelar</button>
            <button onClick={() => { onSave(o.id, { subject, body }); setEditing(false); }} disabled={!dirty} className="text-[11px] px-2 py-1 rounded-lg bg-cyan-600 hover:bg-cyan-700 text-white disabled:opacity-50">Salvar</button>
          </div>
        </div>
      ) : (
        <>
          {o.subject && <p className="text-xs text-zinc-200 mb-1"><span className="text-zinc-500">Assunto:</span> {o.subject}</p>}
          <p className="text-xs text-zinc-300 whitespace-pre-wrap">{o.body}</p>
        </>
      )}

      {!editing && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {o.status === 'draft' && <button onClick={() => onStatus(o.id, 'pending_approval')} className="text-[11px] px-2 py-1 rounded-lg bg-amber-600/90 hover:bg-amber-600 text-white inline-flex items-center gap-1"><Send className="w-3 h-3" /> Enviar p/ aprovação</button>}
          {o.status === 'pending_approval' && <>
            <button onClick={() => onStatus(o.id, 'approved')} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white inline-flex items-center gap-1"><Check className="w-3 h-3" /> Aprovar</button>
            <button onClick={() => onStatus(o.id, 'draft')} className="text-[11px] text-zinc-500 hover:text-zinc-300">voltar p/ rascunho</button>
          </>}
          {o.status === 'approved' && <button onClick={() => onStatus(o.id, 'sent')} className="text-[11px] px-2 py-1 rounded-lg bg-sky-600/90 hover:bg-sky-600 text-white inline-flex items-center gap-1"><Send className="w-3 h-3" /> Marcar como enviada</button>}
          {o.status === 'sent' && o.sent_at && <span className="text-[10px] text-zinc-500">enviada</span>}
          {o.status !== 'sent' && <button onClick={() => onStatus(o.id, 'rejected')} className="text-[11px] text-zinc-500 hover:text-red-400 ml-auto">descartar</button>}
        </div>
      )}
    </div>
  );
}

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

function DiscoveryModal({ campaign, onClose, onChanged }: { campaign: Campaign; onClose: () => void; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(!!campaign.discovery_enabled);
  const [address, setAddress] = useState(campaign.discovery_address || '');
  const [radius, setRadius] = useState(String(campaign.discovery_radius_km || 1));
  const [categories, setCategories] = useState(campaign.discovery_categories || '');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<any[]>([]);

  const loadRuns = useCallback(() => apiFetch(`/api/prospect/discovery/runs?campaignId=${campaign.id}`).then(r => r.json()).then(d => setRuns(Array.isArray(d) ? d : [])).catch(() => {}), [campaign.id]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const save = async () => {
    if (enabled && !address.trim()) { toast.error('Informe o endereço ou CEP de referência.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/prospect/campaigns/${campaign.id}/discovery`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoveryEnabled: enabled, address, radiusKm: parseFloat(radius.replace(',', '.')) || 1, categories }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success('Descoberta automática salva. 🛰'); onChanged();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  const runNow = async () => {
    if (!address.trim()) { toast.error('Informe o endereço/CEP e salve antes de rodar.'); return; }
    setRunning(true);
    try {
      const r = await apiFetch(`/api/prospect/campaigns/${campaign.id}/discovery/run`, { method: 'POST' });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Falha');
      toast.success(`Rodada concluída: +${d.created_count} nova(s).`); loadRuns(); onChanged();
    } catch (e: any) { toast.error(e.message); } finally { setRunning(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[520px] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Radar className="w-5 h-5 text-violet-400" /> Descoberta automática</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Campanha: <b className="text-zinc-300">{campaign.name}</b>. A IA busca empresas por região em fontes públicas (OpenStreetMap), de madrugada (19h–6h), e deixa tudo pronto pra você revisar. Sem scraping, sem custo de API.</p>

        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="accent-violet-500 w-4 h-4" />
          <span className="text-sm text-zinc-200">Ativar varredura automática noturna</span>
        </label>

        <label className="text-[11px] text-zinc-400 mb-0.5 block">Endereço ou CEP de referência *</label>
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="w-4 h-4 text-zinc-500 shrink-0" />
          <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Ex.: Av. Paulista, 1000, São Paulo — ou 01310-100" className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-violet-500" />
        </div>

        <label className="text-[11px] text-zinc-400 mb-0.5 block">Raio de busca: <b className="text-zinc-200">{radius} km</b></label>
        <input type="range" min="0.5" max="10" step="0.5" value={radius} onChange={e => setRadius(e.target.value)} className="w-full accent-violet-500 mb-3" />

        <label className="text-[11px] text-zinc-400 mb-0.5 block">Tipo de negócio (opcional)</label>
        <input value={categories} onChange={e => setCategories(e.target.value)} placeholder="Ex.: clínicas, restaurantes, petshop, academia, escritórios" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-violet-500 mb-1" />
        <p className="text-[10px] text-zinc-600 mb-4">Escreva em português normal (separe por vírgula). <b>Deixe vazio</b> para buscar todos os tipos de comércio/serviço da região.</p>

        <div className="flex justify-between gap-2 mb-4">
          <Button variant="ghost" onClick={runNow} disabled={running || busy} className="text-violet-300 hover:text-violet-200">
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}Rodar agora
          </Button>
          <Button onClick={save} disabled={busy} className="bg-violet-600 hover:bg-violet-700 text-white">
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}Salvar
          </Button>
        </div>

        <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Rodadas desta campanha</p>
        {runs.length === 0 ? <p className="text-[11px] text-zinc-600">Nenhuma rodada ainda. Use “Rodar agora” pra testar a área.</p> : (
          <div className="space-y-1.5">
            {runs.slice(0, 6).map(r => (
              <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
                <div className="flex items-center gap-2 flex-wrap text-[11px]">
                  <span className={r.status === 'done' ? 'text-emerald-400' : r.status === 'error' ? 'text-red-400' : 'text-amber-400'}>{r.status === 'done' ? '✓ concluída' : r.status === 'error' ? '✕ erro' : '… rodando'}</span>
                  <span className="text-zinc-500">{r.trigger === 'manual' ? 'manual' : 'auto'}</span>
                  <span className="ml-auto text-zinc-400">+{r.created_count} nova(s) · {r.found_count} achada(s)</span>
                </div>
                {r.summary && <p className="text-[11px] text-zinc-400 mt-0.5">{r.summary}</p>}
                {r.error && <p className="text-[11px] text-red-400 mt-0.5">{r.error}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
