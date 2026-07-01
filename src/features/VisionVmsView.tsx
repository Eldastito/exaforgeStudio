import React, { useEffect, useState } from 'react';
import { Video, Plus, X, Loader2, Siren, Radio, Camera as CameraIcon, HardDrive, MapPin, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';
import { EmptyState } from '@/src/components/EmptyState';

// Tipos espelham o schema real de apps/vision-cloud/db.ts — ver
// docs/PRD-VISION-VMS-RECONCILIACAO.md para o estado de cada peça
// (nada de câmera/stream real ainda; isso é inventário + eventos técnicos +
// ocorrências, o que já está implementado e testado no backend).
type Site = { id: string; name: string; address: string | null; timezone: string | null };
type Gateway = { id: string; site_id: string; name: string; status: string; agent_version: string | null; last_heartbeat_at: string | null };
type Device = { id: string; site_id: string; gateway_id: string | null; device_type: string; vendor: string | null; model: string | null; compatibility_status: string };
type Camera = { id: string; site_id: string; device_id: string | null; gateway_id: string | null; name: string; area_name: string | null; status: string; is_enabled: number };
type VisionEvent = { id: string; site_id: string | null; gateway_id: string | null; event_type: string; severity: string; status: string; detected_at: string };
type Incident = { id: string; site_id: string | null; title: string; description: string | null; severity: string; status: string; is_panic: number; created_at: string };

type Tab = 'sites' | 'gateways' | 'devices' | 'cameras' | 'events' | 'incidents';

const inputClass = 'w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100';

async function apiJson(url: string, options: RequestInit = {}) {
  const res = await apiFetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// A API do Vision Cloud usa 403 { error: 'vision_role_required' } — traduz
// isso numa mensagem que faz sentido pra quem está clicando, não um JSON cru.
function errorMessage(status: number, body: any, fallback: string) {
  if (status === 403) return 'Você não tem o papel Vision necessário para esta ação (fale com o Vision Admin da sua organização).';
  return body?.error || fallback;
}

function SeverityBadge({ severity }: { severity: string }) {
  const styles: Record<string, string> = {
    baixa: 'border-zinc-700 text-zinc-400',
    media: 'border-amber-500/40 text-amber-300',
    alta: 'border-orange-500/40 text-orange-300',
    critica: 'border-rose-500/40 text-rose-300',
  };
  return <span className={`text-[11px] px-2 py-0.5 rounded border ${styles[severity] || styles.media}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    online: 'border-emerald-500/40 text-emerald-300',
    offline: 'border-rose-500/40 text-rose-300',
    pending: 'border-zinc-700 text-zinc-500',
    detected: 'border-amber-500/40 text-amber-300',
    acknowledged: 'border-sky-500/40 text-sky-300',
    resolved: 'border-emerald-500/40 text-emerald-300',
    escalated: 'border-orange-500/40 text-orange-300',
    false_positive: 'border-zinc-700 text-zinc-500',
    open: 'border-amber-500/40 text-amber-300',
  };
  return <span className={`text-[11px] px-2 py-0.5 rounded border ${styles[status] || 'border-zinc-700 text-zinc-400'}`}>{status}</span>;
}

export function VisionVmsView() {
  const [tab, setTab] = useState<Tab>('sites');
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [events, setEvents] = useState<VisionEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);

  const [showSiteModal, setShowSiteModal] = useState(false);
  const [showGatewayModal, setShowGatewayModal] = useState(false);
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [showCameraModal, setShowCameraModal] = useState(false);
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [gatewayKeyReveal, setGatewayKeyReveal] = useState<string | null>(null);

  const siteName = (id: string | null) => sites.find(s => s.id === id)?.name || '—';
  const gatewayName = (id: string | null) => gateways.find(g => g.id === id)?.name || '—';

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/vision/sites').then(r => r.json()).then(d => setSites(d.sites || [])).catch(() => setSites([])),
      apiFetch('/api/vision/gateways').then(r => r.json()).then(d => setGateways(d.gateways || [])).catch(() => setGateways([])),
      apiFetch('/api/vision/devices').then(r => r.json()).then(d => setDevices(d.devices || [])).catch(() => setDevices([])),
      apiFetch('/api/vision/cameras').then(r => r.json()).then(d => setCameras(d.cameras || [])).catch(() => setCameras([])),
      apiFetch('/api/vision/events').then(r => r.json()).then(d => setEvents(d.events || [])).catch(() => setEvents([])),
      apiFetch('/api/vision/incidents').then(r => r.json()).then(d => setIncidents(d.incidents || [])).catch(() => setIncidents([])),
    ]).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const triggerPanic = async () => {
    const confirmed = await confirmDialog(
      'Isso cria uma ocorrência crítica imediatamente e notifica a equipe. Use apenas em emergência real.',
      { title: '🚨 Acionar botão de pânico?', confirmText: 'Acionar pânico', danger: true }
    );
    if (!confirmed) return;
    const { ok, status, body } = await apiJson('/api/vision/panic', { method: 'POST', body: JSON.stringify({ site_id: sites[0]?.id || null }) });
    if (!ok) { toast.error(errorMessage(status, body, 'Falha ao acionar o pânico.')); return; }
    toast.success('Pânico acionado — ocorrência crítica aberta.');
    loadAll();
  };

  const reviewEvent = async (event: VisionEvent, action: 'acknowledge' | 'resolve' | 'false_positive' | 'escalate') => {
    const { ok, status, body } = await apiJson(`/api/vision/events/${event.id}/review`, { method: 'POST', body: JSON.stringify({ action }) });
    if (!ok) { toast.error(errorMessage(status, body, 'Falha ao revisar evento.')); return; }
    toast.success(action === 'escalate' ? 'Evento escalado para uma ocorrência.' : 'Evento atualizado.');
    loadAll();
  };

  const resolveIncident = async (incident: Incident) => {
    const { ok, status, body } = await apiJson(`/api/vision/incidents/${incident.id}/resolve`, { method: 'POST' });
    if (!ok) { toast.error(errorMessage(status, body, 'Falha ao resolver ocorrência.')); return; }
    toast.success('Ocorrência resolvida.');
    loadAll();
  };

  const toggleCamera = async (camera: Camera) => {
    const { ok, status, body } = await apiJson(`/api/vision/cameras/${camera.id}`, { method: 'PATCH', body: JSON.stringify({ is_enabled: !camera.is_enabled }) });
    if (!ok) { toast.error(errorMessage(status, body, 'Falha ao atualizar câmera.')); return; }
    loadAll();
  };

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: 'sites', label: 'Sites', count: sites.length },
    { key: 'gateways', label: 'Gateways', count: gateways.length },
    { key: 'devices', label: 'Dispositivos', count: devices.length },
    { key: 'cameras', label: 'Câmeras', count: cameras.length },
    { key: 'events', label: 'Eventos', count: events.filter(e => e.status === 'detected' || e.status === 'acknowledged').length },
    { key: 'incidents', label: 'Ocorrências', count: incidents.filter(i => i.status === 'open').length },
  ];

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
              <Video className="w-6 h-6 text-indigo-400" /> Vision VMS
            </h2>
            <p className="text-zinc-400 text-sm mt-1 max-w-2xl">
              Inventário de sites, gateways, dispositivos e câmeras, eventos técnicos e ocorrências. Live view, gravação e IA visual dependem do Vision Edge Gateway físico (ainda não conectado) — ver docs/PRD-VISION-VMS.md.
            </p>
          </div>
          <Button className="bg-rose-600 hover:bg-rose-700 text-white" onClick={triggerPanic}>
            <Siren className="w-4 h-4 mr-2" /> Acionar pânico
          </Button>
        </div>

        <div className="flex items-center gap-1 mb-5 border-b border-zinc-800 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${tab === t.key ? 'border-indigo-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
            >
              {t.label}{t.count > 0 ? ` (${t.count})` : ''}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-zinc-400 py-10 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>
        ) : (
          <>
            {tab === 'sites' && (
              <Section title="Sites" onNew={() => setShowSiteModal(true)} newLabel="Novo site">
                {sites.length === 0 ? (
                  <EmptyState icon={<MapPin className="w-6 h-6" />} title="Nenhum site ainda" description="Cadastre a primeira unidade (condomínio, loja, fábrica) para começar." actionLabel="Criar site" onAction={() => setShowSiteModal(true)} />
                ) : sites.map(s => (
                  <Row key={s.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{s.name}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{s.address || 'Sem endereço'}{s.timezone ? ` · ${s.timezone}` : ''}</p>
                    </div>
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'gateways' && (
              <Section title="Gateways" onNew={() => setShowGatewayModal(true)} newLabel="Registrar gateway" disabled={sites.length === 0} disabledHint="Crie um site primeiro.">
                {gateways.length === 0 ? (
                  <EmptyState icon={<Radio className="w-6 h-6" />} title="Nenhum gateway registrado" description="Um gateway representa o Vision Edge instalado em um site." actionLabel={sites.length ? 'Registrar gateway' : undefined} onAction={sites.length ? () => setShowGatewayModal(true) : undefined} />
                ) : gateways.map(g => (
                  <Row key={g.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{g.name}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{siteName(g.site_id)}{g.agent_version ? ` · v${g.agent_version}` : ''}{g.last_heartbeat_at ? ` · último heartbeat ${g.last_heartbeat_at}` : ' · nunca conectou'}</p>
                    </div>
                    <StatusBadge status={g.status} />
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'devices' && (
              <Section title="Dispositivos" onNew={() => setShowDeviceModal(true)} newLabel="Cadastrar dispositivo" disabled={sites.length === 0} disabledHint="Crie um site primeiro.">
                {devices.length === 0 ? (
                  <EmptyState icon={<HardDrive className="w-6 h-6" />} title="Nenhum dispositivo cadastrado" description="Câmeras avulsas, NVR/DVR ou encoders, classificados por compatibilidade." actionLabel={sites.length ? 'Cadastrar dispositivo' : undefined} onAction={sites.length ? () => setShowDeviceModal(true) : undefined} />
                ) : devices.map(d => (
                  <Row key={d.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{d.vendor || 'Fabricante não informado'} {d.model || ''}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{siteName(d.site_id)} · {d.device_type}{d.gateway_id ? ` · ${gatewayName(d.gateway_id)}` : ''}</p>
                    </div>
                    <span className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 whitespace-nowrap">{d.compatibility_status.replaceAll('_', ' ')}</span>
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'cameras' && (
              <Section title="Câmeras" onNew={() => setShowCameraModal(true)} newLabel="Nova câmera" disabled={sites.length === 0} disabledHint="Crie um site primeiro.">
                {cameras.length === 0 ? (
                  <EmptyState icon={<CameraIcon className="w-6 h-6" />} title="Nenhuma câmera cadastrada" description="Cadastro e nomeação — live view depende do Vision Edge físico." actionLabel={sites.length ? 'Nova câmera' : undefined} onAction={sites.length ? () => setShowCameraModal(true) : undefined} />
                ) : cameras.map(c => (
                  <Row key={c.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{c.name}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{siteName(c.site_id)}{c.area_name ? ` · ${c.area_name}` : ''}</p>
                    </div>
                    <button onClick={() => toggleCamera(c)} className={`text-xs px-2 py-1 rounded border ${c.is_enabled ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>
                      {c.is_enabled ? 'Habilitada' : 'Desabilitada'}
                    </button>
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'events' && (
              <Section title="Event Inbox">
                {events.length === 0 ? (
                  <EmptyState icon={<AlertTriangle className="w-6 h-6" />} title="Nenhum evento ainda" description="Eventos técnicos (ex.: gateway offline) aparecem aqui automaticamente." />
                ) : events.map(ev => (
                  <Row key={ev.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate">{ev.event_type.replaceAll('_', ' ')}</p>
                      <p className="text-[11px] text-zinc-500 truncate">{siteName(ev.site_id)}{ev.gateway_id ? ` · ${gatewayName(ev.gateway_id)}` : ''} · {ev.detected_at}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <SeverityBadge severity={ev.severity} />
                      <StatusBadge status={ev.status} />
                      {(ev.status === 'detected' || ev.status === 'acknowledged') && (
                        <div className="flex items-center gap-1">
                          {ev.status === 'detected' && <IconBtn title="Reconhecer" onClick={() => reviewEvent(ev, 'acknowledge')}><CheckCircle2 className="w-4 h-4" /></IconBtn>}
                          <IconBtn title="Escalar para ocorrência" onClick={() => reviewEvent(ev, 'escalate')}><ShieldAlert className="w-4 h-4" /></IconBtn>
                          <IconBtn title="Resolver" onClick={() => reviewEvent(ev, 'resolve')}><CheckCircle2 className="w-4 h-4" /></IconBtn>
                          <IconBtn title="Falso positivo" onClick={() => reviewEvent(ev, 'false_positive')}><X className="w-4 h-4" /></IconBtn>
                        </div>
                      )}
                    </div>
                  </Row>
                ))}
              </Section>
            )}

            {tab === 'incidents' && (
              <Section title="Ocorrências" onNew={() => setShowIncidentModal(true)} newLabel="Nova ocorrência">
                {incidents.length === 0 ? (
                  <EmptyState icon={<ShieldAlert className="w-6 h-6" />} title="Nenhuma ocorrência" description="Abertas manualmente, por escalonamento de evento, ou pelo botão de pânico." actionLabel="Nova ocorrência" onAction={() => setShowIncidentModal(true)} />
                ) : incidents.map(inc => (
                  <Row key={inc.id}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 truncate flex items-center gap-1.5">
                        {inc.is_panic ? <Siren className="w-3.5 h-3.5 text-rose-400" /> : null}{inc.title}
                      </p>
                      <p className="text-[11px] text-zinc-500 truncate">{siteName(inc.site_id)}{inc.description ? ` · ${inc.description}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <SeverityBadge severity={inc.severity} />
                      <StatusBadge status={inc.status} />
                      {inc.status !== 'resolved' && <IconBtn title="Resolver" onClick={() => resolveIncident(inc)}><CheckCircle2 className="w-4 h-4" /></IconBtn>}
                    </div>
                  </Row>
                ))}
              </Section>
            )}
          </>
        )}
      </div>

      {showSiteModal && <SiteModal onClose={() => setShowSiteModal(false)} onSaved={() => { setShowSiteModal(false); loadAll(); }} />}
      {showGatewayModal && (
        <GatewayModal
          sites={sites}
          onClose={() => setShowGatewayModal(false)}
          onSaved={(apiKey) => { setShowGatewayModal(false); setGatewayKeyReveal(apiKey); loadAll(); }}
        />
      )}
      {showDeviceModal && <DeviceModal sites={sites} gateways={gateways} onClose={() => setShowDeviceModal(false)} onSaved={() => { setShowDeviceModal(false); loadAll(); }} />}
      {showCameraModal && <CameraModal sites={sites} devices={devices} gateways={gateways} onClose={() => setShowCameraModal(false)} onSaved={() => { setShowCameraModal(false); loadAll(); }} />}
      {showIncidentModal && <IncidentModal onClose={() => setShowIncidentModal(false)} onSaved={() => { setShowIncidentModal(false); loadAll(); }} />}
      {gatewayKeyReveal && <GatewayKeyModal apiKey={gatewayKeyReveal} onClose={() => setGatewayKeyReveal(null)} />}
    </div>
  );
}

function Section({ title, onNew, newLabel, disabled, disabledHint, children }: { title: string; onNew?: () => void; newLabel?: string; disabled?: boolean; disabledHint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">{title}</h3>
        {onNew && (
          <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={onNew} disabled={disabled} title={disabled ? disabledHint : undefined}>
            <Plus className="w-4 h-4 mr-1.5" /> {newLabel}
          </Button>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 gap-3">{children}</div>;
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button title={title} onClick={onClick} className="text-zinc-400 hover:text-indigo-400 p-1">{children}</button>;
}

function ModalShell({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">{children}</div>
        <div className="mt-5 flex justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}

function SiteModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast.error('Informe o nome do site.'); return; }
    setSaving(true);
    const { ok, status, body } = await apiJson('/api/vision/sites', { method: 'POST', body: JSON.stringify({ name: name.trim(), address: address.trim() || null }) });
    setSaving(false);
    if (!ok) { toast.error(errorMessage(status, body, 'Erro ao criar site.')); return; }
    toast.success('Site criado.');
    onSaved();
  };

  return (
    <ModalShell title="Novo site" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar site'}</Button>
    </>}>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Nome</label>
        <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Condomínio Jardim das Flores" autoFocus />
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Endereço</label>
        <input className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="Opcional" />
      </div>
    </ModalShell>
  );
}

function GatewayModal({ sites, onClose, onSaved }: { sites: Site[]; onClose: () => void; onSaved: (apiKey: string) => void }) {
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!siteId || !name.trim()) { toast.error('Escolha o site e informe o nome do gateway.'); return; }
    setSaving(true);
    const { ok, status, body } = await apiJson('/api/vision/gateways/register', { method: 'POST', body: JSON.stringify({ site_id: siteId, name: name.trim() }) });
    setSaving(false);
    if (!ok) { toast.error(errorMessage(status, body, 'Erro ao registrar gateway.')); return; }
    onSaved(body.api_key);
  };

  return (
    <ModalShell title="Registrar Vision Edge Gateway" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Registrar'}</Button>
    </>}>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Site</label>
        <select className={inputClass} value={siteId} onChange={e => setSiteId(e.target.value)}>
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Nome do gateway</label>
        <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Gateway Portaria" autoFocus />
      </div>
      <p className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
        Uma chave de API será gerada e mostrada UMA ÚNICA VEZ na próxima tela — o Vision Edge físico usa essa chave para autenticar, não seu login.
      </p>
    </ModalShell>
  );
}

function GatewayKeyModal({ apiKey, onClose }: { apiKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(apiKey); setCopied(true); } catch {}
  };
  return (
    <ModalShell title="Chave do gateway (só aparece agora)" onClose={onClose} footer={<Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={onClose}>Já guardei a chave</Button>}>
      <p className="text-sm text-zinc-400">Configure esta chave no Vision Edge Gateway físico. Ela não pode ser recuperada depois — só regerada.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 bg-zinc-950 border border-zinc-800 rounded p-2 text-xs text-emerald-300 break-all">{apiKey}</code>
        <Button size="sm" variant="outline" onClick={copy}>{copied ? 'Copiado!' : 'Copiar'}</Button>
      </div>
    </ModalShell>
  );
}

function DeviceModal({ sites, gateways, onClose, onSaved }: { sites: Site[]; gateways: Gateway[]; onClose: () => void; onSaved: () => void }) {
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [gatewayId, setGatewayId] = useState('');
  const [deviceType, setDeviceType] = useState('camera');
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');
  const [compat, setCompat] = useState('nao_homologado');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!siteId) { toast.error('Escolha o site.'); return; }
    setSaving(true);
    const { ok, status, body } = await apiJson('/api/vision/devices', {
      method: 'POST',
      body: JSON.stringify({ site_id: siteId, gateway_id: gatewayId || null, device_type: deviceType, vendor: vendor.trim() || null, model: model.trim() || null, compatibility_status: compat }),
    });
    setSaving(false);
    if (!ok) { toast.error(errorMessage(status, body, 'Erro ao cadastrar dispositivo.')); return; }
    toast.success('Dispositivo cadastrado.');
    onSaved();
  };

  return (
    <ModalShell title="Cadastrar dispositivo" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Cadastrar'}</Button>
    </>}>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Site</label>
        <select className={inputClass} value={siteId} onChange={e => setSiteId(e.target.value)}>
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Gateway (opcional)</label>
        <select className={inputClass} value={gatewayId} onChange={e => setGatewayId(e.target.value)}>
          <option value="">Sem gateway ainda</option>
          {gateways.filter(g => g.site_id === siteId).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Tipo</label>
        <select className={inputClass} value={deviceType} onChange={e => setDeviceType(e.target.value)}>
          <option value="camera">Câmera</option>
          <option value="nvr">NVR</option>
          <option value="dvr">DVR</option>
          <option value="encoder">Encoder</option>
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm text-zinc-400 mb-1 block">Fabricante</label>
          <input className={inputClass} value={vendor} onChange={e => setVendor(e.target.value)} placeholder="Ex.: Hikvision" />
        </div>
        <div>
          <label className="text-sm text-zinc-400 mb-1 block">Modelo</label>
          <input className={inputClass} value={model} onChange={e => setModel(e.target.value)} placeholder="Ex.: DS-2CD2143" />
        </div>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Compatibilidade (PRD §7.1)</label>
        <select className={inputClass} value={compat} onChange={e => setCompat(e.target.value)}>
          <option value="nao_homologado">Não homologado (avaliar)</option>
          <option value="compativel_direto">Compatível direto</option>
          <option value="compativel_via_nvr">Compatível via NVR</option>
          <option value="compativel_com_adaptacao">Compatível com adaptação</option>
          <option value="uso_temporario">Uso temporário</option>
          <option value="substituicao_recomendada">Substituição recomendada</option>
        </select>
      </div>
    </ModalShell>
  );
}

function CameraModal({ sites, devices, gateways, onClose, onSaved }: { sites: Site[]; devices: Device[]; gateways: Gateway[]; onClose: () => void; onSaved: () => void }) {
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [deviceId, setDeviceId] = useState('');
  const [gatewayId, setGatewayId] = useState('');
  const [name, setName] = useState('');
  const [areaName, setAreaName] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!siteId || !name.trim()) { toast.error('Escolha o site e informe o nome da câmera.'); return; }
    setSaving(true);
    const { ok, status, body } = await apiJson('/api/vision/cameras', {
      method: 'POST',
      body: JSON.stringify({ site_id: siteId, device_id: deviceId || null, gateway_id: gatewayId || null, name: name.trim(), area_name: areaName.trim() || null }),
    });
    setSaving(false);
    if (!ok) { toast.error(errorMessage(status, body, 'Erro ao criar câmera.')); return; }
    toast.success('Câmera cadastrada.');
    onSaved();
  };

  return (
    <ModalShell title="Nova câmera" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar câmera'}</Button>
    </>}>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Site</label>
        <select className={inputClass} value={siteId} onChange={e => setSiteId(e.target.value)}>
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Nome</label>
        <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Câmera Portaria 1" autoFocus />
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Área</label>
        <input className={inputClass} value={areaName} onChange={e => setAreaName(e.target.value)} placeholder="Ex.: Portaria" />
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Dispositivo associado (opcional)</label>
        <select className={inputClass} value={deviceId} onChange={e => setDeviceId(e.target.value)}>
          <option value="">Sem dispositivo</option>
          {devices.filter(d => d.site_id === siteId).map(d => <option key={d.id} value={d.id}>{d.vendor || d.device_type} {d.model || ''}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Gateway (opcional)</label>
        <select className={inputClass} value={gatewayId} onChange={e => setGatewayId(e.target.value)}>
          <option value="">Sem gateway ainda</option>
          {gateways.filter(g => g.site_id === siteId).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
    </ModalShell>
  );
}

function IncidentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('media');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) { toast.error('Informe o título da ocorrência.'); return; }
    setSaving(true);
    const { ok, status, body } = await apiJson('/api/vision/incidents', { method: 'POST', body: JSON.stringify({ title: title.trim(), description: description.trim() || null, severity }) });
    setSaving(false);
    if (!ok) { toast.error(errorMessage(status, body, 'Erro ao criar ocorrência.')); return; }
    toast.success('Ocorrência criada.');
    onSaved();
  };

  return (
    <ModalShell title="Nova ocorrência" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Cancelar</Button>
      <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar ocorrência'}</Button>
    </>}>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Título</label>
        <input className={inputClass} value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex.: Portão da garagem emperrado" autoFocus />
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
        <textarea className={`${inputClass} h-20 resize-none`} value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="text-sm text-zinc-400 mb-1 block">Severidade</label>
        <select className={inputClass} value={severity} onChange={e => setSeverity(e.target.value)}>
          <option value="baixa">Baixa</option>
          <option value="media">Média</option>
          <option value="alta">Alta</option>
          <option value="critica">Crítica</option>
        </select>
      </div>
    </ModalShell>
  );
}
