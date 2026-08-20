/**
 * ProfessionalNetworkPanel — ADR-180 F4b: UI do operador da Agenda Federada.
 *
 * Superfície que torna a rede de especialistas USÁVEL pela recepção/gestor: ativar a
 * rede (flag opt-in), convidar/aceitar profissional (identidade GLOBAL + vínculo
 * por-org), configurar serviços ofertados + janelas de trabalho, e — o valor central —
 * VER as vagas que o Availability Engine (F3) prova estarem livres e AGENDAR sem
 * depender de contato manual com o especialista (hold atômico → confirm → appointment
 * federado). Sem vaga: fila (waitlist) na espinha canônica. AutoBooking: comando
 * GOVERNADO (a UI só PROPÕE; a governança decide).
 *
 * Segue o "sotaque" canônico (SpecialtiesPanel/ProfessionalsPanel): paleta
 * zinc/emerald/amber/rose, `apiFetch` direto, `toast` pra feedback, PT-BR. Escrita é
 * owner/admin no servidor — a UI mostra a mensagem de erro, não esconde o botão
 * (RN: a rota é a fonte da verdade de permissão).
 *
 * NUNCA inventa vaga (RN-PN-4): só oferece o que `/availability` devolve. AGENDADO ≠
 * ATENDIDO (RN-PN-5): confirmar cria o agendamento; o comparecimento é outra etapa.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, UserPlus, CheckCircle2, XCircle, CalendarClock, Network, Clock, ListPlus, Bot, Wallet, TrendingUp, CalendarDays } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

type ContactLite = { id: string; name?: string | null };

type Professional = { id: string; council: string; registrationNumber: string; name: string; specialties: string[]; phone: string | null; email: string | null };
type Relationship = { id: string; professionalId: string; status: string; permissions: { services: string[] }; commissionPercent: number | null; commissionBeneficiary?: 'professional' | 'clinic'; taxWithholdingPercent?: number | null; professional: Professional | null };
type FinanceTotals = { count: number; gross: number | null; professionalAmount: number | null; clinicAmount: number | null; taxAmount: number | null; netProfessional: number | null; missingPrice: number };
type Settlement = { appointmentId: string; scheduledStart: string | null; serviceName: string | null; status: string; realized: boolean; gross: number | null; professionalAmount: number | null; clinicAmount: number | null; taxAmount: number | null; netProfessional: number | null; basis: string };
type Statement = { commissionBeneficiary: string; taxWithholdingPercent: number | null; realized: FinanceTotals; expected: FinanceTotals; events: Settlement[] };
type ForecastRow = { relationshipId: string; professionalName: string | null; nextServiceDate: string | null; expected: FinanceTotals };
type Offering = { id: string; serviceId: string; serviceName: string | null; durationMin: number | null; active: boolean };
type Window = { id: string; dayOfWeek: number; startMinute: number; endMinute: number; start: string; end: string; bufferMin: number; active: boolean };
type Slot = { start: string; end: string; startMinute: number; durationMin: number };
type ServiceLite = { id: string; name: string; type?: string; active?: number | boolean };

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const NET = '/api/clinic/professional-network';

function hhmm(iso: string): string { try { const d = new Date(iso); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; } catch { return iso; } }
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function dmy(iso: string | null): string { if (!iso) return '—'; try { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; } catch { return iso; } }
/** BRL honesto: null (não sabido) vira '—', nunca R$ 0,00 inventado (RN-PN-4). */
function brl(n: number | null | undefined): string { return n == null ? '—' : `R$ ${Number(n).toFixed(2).replace('.', ',')}`; }
async function jread(p: string, init?: RequestInit): Promise<any> {
  const r = await apiFetch(p, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
  return d;
}

export default function ProfessionalNetworkPanel({ contacts }: { contacts: ContactLite[] }) {
  const [settings, setSettings] = useState<{ networkEnabled: boolean; autobookingEnabled: boolean } | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);

  const loadSettings = useCallback(async () => {
    setLoadingSettings(true);
    try { setSettings(await jread(`${NET}/settings`)); }
    catch { setSettings({ networkEnabled: false, autobookingEnabled: false }); }
    finally { setLoadingSettings(false); }
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  if (loadingSettings) return <div className="flex items-center gap-2 text-zinc-500 text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Carregando rede de especialistas…</div>;
  if (!settings?.networkEnabled) return <ActivationCard onActivate={loadSettings} />;
  return <NetworkManager contacts={contacts} settings={settings} onSettings={setSettings} />;
}

// ── Ativação (flag opt-in) ──
function ActivationCard({ onActivate }: { onActivate: () => void }) {
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setBusy(true);
    try { await jread(`${NET}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ networkEnabled: true }) }); toast.success('Rede de especialistas ativada.'); onActivate(); }
    catch (e: any) { toast.error(e?.message === 'Forbidden' ? 'Só o dono/admin pode ativar a rede.' : (e?.message || 'Falha ao ativar.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="max-w-2xl rounded-lg border border-zinc-800 bg-zinc-900/40 p-6">
      <div className="flex items-center gap-2 text-emerald-300 mb-2"><Network className="w-5 h-5" /><h3 className="text-base font-semibold">Rede de especialistas (Agenda Federada)</h3></div>
      <p className="text-sm text-zinc-400 leading-relaxed mb-3">
        Agende especialistas que atendem em várias clínicas <strong>sem depender de contato manual</strong>.
        O ZapFlow mostra só os horários que a disponibilidade real do profissional comporta, segura a vaga e confirma o agendamento.
      </p>
      <ul className="text-sm text-zinc-500 list-disc pl-5 space-y-1 mb-4">
        <li>Convide o profissional pela identidade dele (conselho + registro) — ele pode atender em outras clínicas sem conflito.</li>
        <li>Configure quais serviços a clínica pode agendar e as janelas de trabalho na sua unidade.</li>
        <li>Veja vagas livres, segure e confirme — nunca oferece horário que não existe.</li>
      </ul>
      <Button onClick={activate} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Network className="w-4 h-4" />} Ativar rede de especialistas
      </Button>
    </div>
  );
}

// ── Previsão de receita a receber (F8.2) — visão geral por profissional ──
function ForecastPanel() {
  const [fc, setFc] = useState<{ byProfessional: ForecastRow[]; totalNetProfessional: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const d = await jread(`${NET}/finance/forecast`); if (alive) setFc(d); }
      catch { if (alive) setFc(null); } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);
  if (loading) return <div className="text-xs text-zinc-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> carregando previsão…</div>;
  if (!fc || fc.byProfessional.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-indigo-400" /> Previsão a receber <span className="text-zinc-500 text-xs">(agendado, ainda não atendido)</span></div>
      <div className="space-y-1">
        {fc.byProfessional.map((r) => (
          <div key={r.relationshipId} className="flex items-center justify-between gap-2 text-xs border-b border-zinc-800/60 pb-1">
            <span className="text-zinc-300">{r.professionalName || 'profissional'}</span>
            <span className="flex items-center gap-3 text-zinc-500">
              <span title="1º atendimento previsto"><Clock className="w-3 h-3 inline mr-0.5" />{dmy(r.nextServiceDate)}</span>
              <span className="text-zinc-600">{r.expected.count}×</span>
              <span className="text-indigo-300 font-medium" title="líquido do profissional">{brl(r.expected.netProfessional)}</span>
            </span>
          </div>
        ))}
      </div>
      {fc.totalNetProfessional != null && (
        <div className="flex items-center justify-between text-xs pt-1">
          <span className="text-zinc-400">Total líquido previsto</span>
          <span className="text-indigo-300 font-semibold">{brl(fc.totalNetProfessional)}</span>
        </div>
      )}
    </div>
  );
}

// ── Gestor (rede ativa) ──
function NetworkManager({ contacts, settings, onSettings }: { contacts: ContactLite[]; settings: { networkEnabled: boolean; autobookingEnabled: boolean }; onSettings: (s: any) => void }) {
  const [rels, setRels] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [selId, setSelId] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceLite[]>([]);

  const loadRels = useCallback(async () => {
    setLoading(true);
    try { const d = await jread(`${NET}/relationships`); setRels(Array.isArray(d) ? d : []); }
    catch { setRels([]); } finally { setLoading(false); }
  }, []);
  const loadServices = useCallback(async () => {
    try { const r = await apiFetch('/api/products?limit=500'); const d = await r.json().catch(() => []); const arr = Array.isArray(d) ? d : (Array.isArray(d?.products) ? d.products : []); setServices(arr.filter((s: any) => s.type === 'service' && (s.active === undefined || s.active))); }
    catch { setServices([]); }
  }, []);
  useEffect(() => { loadRels(); loadServices(); }, [loadRels, loadServices]);

  const selected = useMemo(() => rels.find((r) => r.id === selId) || null, [rels, selId]);

  const toggleAutobooking = async () => {
    try { const s = await jread(`${NET}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autobookingEnabled: !settings.autobookingEnabled }) }); onSettings(s); toast.success(s.autobookingEnabled ? 'AutoBooking ligado (segue governado).' : 'AutoBooking desligado.'); }
    catch (e: any) { toast.error(e?.message || 'Falha.'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-emerald-300"><Network className="w-4 h-4" /><span className="text-sm font-medium">Rede de especialistas</span></div>
        <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
          <input type="checkbox" checked={settings.autobookingEnabled} onChange={toggleAutobooking} className="accent-emerald-500" />
          <Bot className="w-3.5 h-3.5" /> AutoBooking (agendamento automático, governado)
        </label>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        <div className="space-y-3">
          <InvitePanel onInvited={(id) => { loadRels(); setSelId(id); }} />
          <RelationshipList rels={rels} loading={loading} selId={selId} onSelect={setSelId} onChanged={loadRels} />
        </div>
        <div>
          {selected ? (
            <div key={selected.id}>
              <ProfessionalDetail rel={selected} services={services} contacts={contacts} autobooking={settings.autobookingEnabled} onChanged={loadRels} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-zinc-600 text-sm">Selecione um profissional para configurar serviços, janelas e agendar.</div>
              <ForecastPanel />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Convite ──
function InvitePanel({ onInvited }: { onInvited: (relId: string) => void }) {
  const [council, setCouncil] = useState('CRMV');
  const [registration, setRegistration] = useState('');
  const [name, setName] = useState('');
  const [specialties, setSpecialties] = useState('');
  const [busy, setBusy] = useState(false);

  const invite = async () => {
    if (!name.trim() || !registration.trim()) { toast.error('Informe nome e registro.'); return; }
    setBusy(true);
    try {
      const rel = await jread(`${NET}/relationships`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: { council: council.trim() || null, registrationNumber: registration.trim(), name: name.trim(), specialties: specialties.split(',').map((s) => s.trim()).filter(Boolean) } }),
      });
      toast.success('Profissional convidado (pendente).');
      setName(''); setRegistration(''); setSpecialties('');
      onInvited(rel.id);
    } catch (e: any) { toast.error(e?.message === 'Forbidden' ? 'Só o dono/admin pode convidar.' : (e?.message || 'Falha ao convidar.')); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-zinc-300 text-sm font-medium"><UserPlus className="w-4 h-4" /> Convidar profissional</div>
      <div className="flex gap-2">
        <input value={council} onChange={(e) => setCouncil(e.target.value)} placeholder="Conselho" className="w-24 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
        <input value={registration} onChange={(e) => setRegistration(e.target.value)} placeholder="Nº registro" className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do profissional" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
      <input value={specialties} onChange={(e) => setSpecialties(e.target.value)} placeholder="Especialidades (vírgula)" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
      <Button onClick={invite} disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Convidar
      </Button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { accepted: 'bg-emerald-500/15 text-emerald-300', pending: 'bg-amber-500/15 text-amber-300', revoked: 'bg-rose-500/15 text-rose-300' };
  const label: Record<string, string> = { accepted: 'ativo', pending: 'pendente', revoked: 'revogado' };
  return <span className={`px-1.5 py-0.5 rounded text-[11px] ${map[status] || 'bg-zinc-700 text-zinc-300'}`}>{label[status] || status}</span>;
}

function RelationshipList({ rels, loading, selId, onSelect, onChanged }: { rels: Relationship[]; loading: boolean; selId: string | null; onSelect: (id: string) => void; onChanged: () => void }) {
  const act = async (id: string, verb: 'accept' | 'revoke') => {
    if (verb === 'revoke' && !(await confirmDialog('Revogar o vínculo? A identidade global do profissional é preservada.'))) return;
    try { await jread(`${NET}/relationships/${id}/${verb}`, { method: 'POST' }); toast.success(verb === 'accept' ? 'Vínculo aceito.' : 'Vínculo revogado.'); onChanged(); }
    catch (e: any) { toast.error(e?.message || 'Falha.'); }
  };
  if (loading) return <div className="text-zinc-600 text-sm py-4 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  if (!rels.length) return <div className="text-zinc-600 text-sm py-4">Nenhum profissional na rede ainda.</div>;
  return (
    <div className="space-y-1.5">
      {rels.map((r) => (
        <div key={r.id} className={`rounded-lg border p-2.5 cursor-pointer transition-colors ${selId === r.id ? 'border-emerald-600 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700'}`} onClick={() => onSelect(r.id)}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm text-zinc-200 truncate">{r.professional?.name || 'Profissional'}</div>
              <div className="text-[11px] text-zinc-500 truncate">{r.professional?.council} {r.professional?.registrationNumber}{r.professional?.specialties?.length ? ` · ${r.professional.specialties.join(', ')}` : ''}</div>
            </div>
            <StatusBadge status={r.status} />
          </div>
          <div className="flex gap-1.5 mt-1.5" onClick={(e) => e.stopPropagation()}>
            {r.status === 'pending' && <button onClick={() => act(r.id, 'accept')} className="text-[11px] px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Aceitar</button>}
            {r.status !== 'revoked' && <button onClick={() => act(r.id, 'revoke')} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-rose-600/80 text-zinc-300 hover:text-white inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> Revogar</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Detalhe do profissional selecionado ──
function ProfessionalDetail({ rel, services, contacts, autobooking, onChanged }: { rel: Relationship; services: ServiceLite[]; contacts: ContactLite[]; autobooking: boolean; onChanged: () => void }) {
  const accepted = rel.status === 'accepted';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold text-zinc-100">{rel.professional?.name}</div>
          <div className="text-xs text-zinc-500">{rel.professional?.council} {rel.professional?.registrationNumber} · <StatusBadge status={rel.status} /></div>
        </div>
      </div>
      {!accepted && <div className="rounded border border-amber-700/40 bg-amber-500/5 text-amber-300 text-xs px-3 py-2">Aceite o vínculo para configurar disponibilidade e agendar.</div>}
      <OfferingsEditor relId={rel.id} services={services} disabled={!accepted} />
      <WindowsEditor relId={rel.id} disabled={!accepted} />
      {accepted && <GoogleCalendarPanel relId={rel.id} professionalName={rel.professional?.name || 'profissional'} />}
      {accepted && <AvailabilityBooker rel={rel} contacts={contacts} autobooking={autobooking} onBooked={onChanged} />}
      {accepted && <FinancePanel rel={rel} onChanged={onChanged} />}
    </div>
  );
}

// ── Google Calendar do profissional (F6) — conectar/desconectar ──
function GoogleCalendarPanel({ relId, professionalName }: { relId: string; professionalName: string }) {
  const [st, setSt] = useState<{ configured: boolean; connected: boolean; email: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSt(await jread(`${NET}/relationships/${relId}/google/status`)); }
    catch { setSt(null); } finally { setLoading(false); }
  }, [relId]);
  useEffect(() => { load(); }, [load]);
  // Ao voltar da janela de consentimento do Google, o operador reativa a aba → recarrega.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await jread(`${NET}/relationships/${relId}/google/login-url`);
      window.open(url, '_blank', 'noopener');
      toast.info('Autorize a agenda na janela do Google e volte aqui.');
    } catch (e: any) {
      toast.error(e?.message === 'google_not_configured' ? 'Integração Google não configurada no servidor.' : (e?.message || 'Falha ao gerar o link.'));
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!(await confirmDialog(`Desconectar a agenda Google de ${professionalName}?`))) return;
    setBusy(true);
    try { await jread(`${NET}/relationships/${relId}/google/disconnect`, { method: 'POST' }); toast.success('Agenda Google desconectada.'); load(); }
    catch (e: any) { toast.error(e?.message || 'Falha ao desconectar.'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="text-xs text-zinc-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Google…</div>;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-sky-400" /> Agenda Google</div>
      {st && !st.configured ? (
        <div className="text-xs text-amber-400/80">Integração Google não está configurada neste servidor.</div>
      ) : st?.connected ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-zinc-400">Conectada{st.email ? ` · ${st.email}` : ''}. As vagas já respeitam os compromissos do Google e os atendimentos vão pra essa agenda.</div>
          <button onClick={disconnect} disabled={busy} className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-rose-600/80 text-zinc-300 hover:text-white shrink-0">Desconectar</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-zinc-500">Conecte a agenda do profissional pra não oferecer horários ocupados e lançar os atendimentos automaticamente.</div>
          <Button onClick={connect} disabled={busy} className="bg-sky-600 hover:bg-sky-500 text-xs shrink-0">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-3.5 h-3.5" />} Conectar Google</Button>
        </div>
      )}
    </div>
  );
}

// ── Financeiro do vínculo (F8) — split clínica×profissional + imposto + extrato ──
function FinancePanel({ rel, onChanged }: { rel: Relationship; onChanged: () => void }) {
  const [beneficiary, setBeneficiary] = useState<'professional' | 'clinic'>(rel.commissionBeneficiary || 'professional');
  const [commission, setCommission] = useState<string>(rel.commissionPercent == null ? '' : String(rel.commissionPercent));
  const [tax, setTax] = useState<string>(rel.taxWithholdingPercent == null ? '' : String(rel.taxWithholdingPercent));
  const [busy, setBusy] = useState(false);
  const [st, setSt] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);

  const loadStatement = useCallback(async () => {
    setLoading(true);
    try { setSt(await jread(`${NET}/relationships/${rel.id}/finance/statement`)); }
    catch { setSt(null); } finally { setLoading(false); }
  }, [rel.id]);
  useEffect(() => { loadStatement(); }, [loadStatement]);

  const save = async () => {
    setBusy(true);
    try {
      await jread(`${NET}/relationships/${rel.id}/permissions`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commissionBeneficiary: beneficiary,
          commissionPercent: commission.trim() === '' ? null : Number(commission),
          taxWithholdingPercent: tax.trim() === '' ? null : Number(tax),
        }),
      });
      toast.success('Acordo financeiro salvo.');
      onChanged(); loadStatement();
    } catch (e: any) { toast.error(e?.message === 'percent_out_of_range' ? 'Percentual deve ser de 0 a 100.' : (e?.message || 'Falha ao salvar.')); }
    finally { setBusy(false); }
  };

  const otherSide = beneficiary === 'professional' ? 'a clínica fica com o resto' : 'o profissional fica com o resto';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
      <div className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5"><Wallet className="w-4 h-4 text-emerald-400" /> Financeiro</div>

      {/* Acordo: direção do split + comissão + imposto retido */}
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-zinc-500">O percentual é de</span>
          <select value={beneficiary} onChange={(e) => setBeneficiary(e.target.value as any)} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm">
            <option value="professional">Profissional</option>
            <option value="clinic">Clínica</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-500">Comissão %</span>
          <input type="number" min={0} max={100} value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="—" className="w-20 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-500">Imposto retido %</span>
          <input type="number" min={0} max={100} value={tax} onChange={(e) => setTax(e.target.value)} placeholder="—" className="w-20 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
        </label>
        <Button onClick={save} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Salvar acordo</Button>
      </div>
      <div className="text-[11px] text-zinc-500">Cada par combina o seu — {otherSide}. Sem imposto configurado, o líquido é igual ao bruto (nada é inventado).</div>

      {/* Extrato: realizado × previsto */}
      {loading ? <div className="text-xs text-zinc-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> carregando extrato…</div> : st && (
        <div className="grid grid-cols-2 gap-2">
          <TotalsCard title="Realizado (atendido)" tone="emerald" t={st.realized} />
          <TotalsCard title="Previsto (agendado)" tone="indigo" t={st.expected} />
        </div>
      )}
      {st && st.events.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">Ver {st.events.length} atendimento(s)</summary>
          <div className="mt-2 space-y-1">
            {st.events.map((e) => (
              <div key={e.appointmentId} className="flex items-center justify-between gap-2 border-b border-zinc-800/60 pb-1">
                <span className="text-zinc-400">{dmy(e.scheduledStart)} · {e.serviceName || 'serviço'}</span>
                <span className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${e.realized ? 'bg-emerald-600/20 text-emerald-300' : 'bg-indigo-600/20 text-indigo-300'}`}>{e.realized ? 'atendido' : 'agendado'}</span>
                  <span className="text-zinc-300">{brl(e.gross)}</span>
                  <span className="text-zinc-500" title="líquido do profissional">→ {brl(e.netProfessional)}</span>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function TotalsCard({ title, tone, t }: { title: string; tone: 'emerald' | 'indigo'; t: FinanceTotals }) {
  const ring = tone === 'emerald' ? 'border-emerald-700/40' : 'border-indigo-700/40';
  return (
    <div className={`rounded border ${ring} bg-zinc-950/50 p-2 text-xs space-y-0.5`}>
      <div className="text-zinc-300 font-medium">{title} <span className="text-zinc-600">· {t.count}</span></div>
      <div className="flex justify-between text-zinc-400"><span>Bruto</span><span className="text-zinc-200">{brl(t.gross)}</span></div>
      <div className="flex justify-between text-zinc-400"><span>Profissional</span><span>{brl(t.professionalAmount)}</span></div>
      <div className="flex justify-between text-zinc-400"><span>Clínica</span><span>{brl(t.clinicAmount)}</span></div>
      <div className="flex justify-between text-zinc-400"><span>Imposto retido</span><span>{brl(t.taxAmount)}</span></div>
      <div className="flex justify-between text-emerald-300 font-medium"><span>Líquido profissional</span><span>{brl(t.netProfessional)}</span></div>
      {t.missingPrice > 0 && <div className="text-[10px] text-amber-400/80">{t.missingPrice} sem preço combinado</div>}
    </div>
  );
}

// ── Serviços ofertados ──
function OfferingsEditor({ relId, services, disabled }: { relId: string; services: ServiceLite[]; disabled: boolean }) {
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [svcId, setSvcId] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const d = await jread(`${NET}/relationships/${relId}/offerings`); setOfferings(Array.isArray(d) ? d : []); } catch { setOfferings([]); } }, [relId]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!svcId) { toast.error('Escolha um serviço.'); return; }
    setBusy(true);
    try { await jread(`${NET}/relationships/${relId}/offerings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId: svcId, durationMin: duration ? Number(duration) : null }) }); toast.success('Serviço adicionado.'); setSvcId(''); setDuration(''); load(); }
    catch (e: any) { toast.error(e?.message || 'Falha.'); } finally { setBusy(false); }
  };
  const remove = async (offeringId: string) => {
    try { await jread(`${NET}/offerings/${offeringId}`, { method: 'DELETE' }); load(); } catch (e: any) { toast.error(e?.message || 'Falha.'); }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-1.5 text-zinc-300 text-sm font-medium mb-2"><ListPlus className="w-4 h-4" /> Serviços que a clínica pode agendar</div>
      <div className="space-y-1 mb-2">
        {offerings.length === 0 && <div className="text-xs text-zinc-600">Nenhum serviço ofertado ainda.</div>}
        {offerings.map((o) => (
          <div key={o.id} className="flex items-center justify-between text-sm bg-zinc-950/60 rounded px-2 py-1">
            <span className="text-zinc-300">{o.serviceName || o.serviceId} <span className="text-zinc-500 text-xs">· {o.durationMin ? `${o.durationMin} min` : 'duração do catálogo'}</span></span>
            {!disabled && <button onClick={() => remove(o.id)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>}
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <select value={svcId} onChange={(e) => setSvcId(e.target.value)} className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm">
            <option value="">Serviço do catálogo…</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="min" className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
          <Button onClick={add} disabled={busy} className="bg-zinc-800 hover:bg-zinc-700">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}</Button>
        </div>
      )}
    </div>
  );
}

// ── Janelas de trabalho ──
function WindowsEditor({ relId, disabled }: { relId: string; disabled: boolean }) {
  const [windows, setWindows] = useState<Array<{ dayOfWeek: number; start: string; end: string; bufferMin: number }>>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { const d: Window[] = await jread(`${NET}/relationships/${relId}/windows`); setWindows((Array.isArray(d) ? d : []).map((w) => ({ dayOfWeek: w.dayOfWeek, start: w.start, end: w.end, bufferMin: w.bufferMin || 0 }))); }
    catch { setWindows([]); }
  }, [relId]);
  useEffect(() => { load(); }, [load]);

  const addRow = () => setWindows((w) => [...w, { dayOfWeek: 1, start: '09:00', end: '12:00', bufferMin: 0 }]);
  const setRow = (i: number, patch: Partial<{ dayOfWeek: number; start: string; end: string; bufferMin: number }>) => setWindows((w) => w.map((row, idx) => idx === i ? { ...row, ...patch } : row));
  const rmRow = (i: number) => setWindows((w) => w.filter((_, idx) => idx !== i));
  const save = async () => {
    setBusy(true);
    try { await jread(`${NET}/relationships/${relId}/windows`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows }) }); toast.success('Janelas salvas.'); load(); }
    catch (e: any) { toast.error(e?.message || 'Falha ao salvar janelas.'); } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-1.5 text-zinc-300 text-sm font-medium mb-2"><Clock className="w-4 h-4" /> Janelas de trabalho nesta clínica</div>
      <div className="space-y-1.5 mb-2">
        {windows.length === 0 && <div className="text-xs text-zinc-600">Sem janelas — o profissional não terá vagas até você adicionar.</div>}
        {windows.map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <select value={w.dayOfWeek} onChange={(e) => setRow(i, { dayOfWeek: Number(e.target.value) })} disabled={disabled} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm">
              {DOW.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
            </select>
            <input type="time" value={w.start} onChange={(e) => setRow(i, { start: e.target.value })} disabled={disabled} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
            <span className="text-zinc-600 text-xs">até</span>
            <input type="time" value={w.end} onChange={(e) => setRow(i, { end: e.target.value })} disabled={disabled} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
            <input type="number" value={w.bufferMin} onChange={(e) => setRow(i, { bufferMin: Number(e.target.value) })} disabled={disabled} title="buffer (min)" className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-sm" />
            {!disabled && <button onClick={() => rmRow(i)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>}
          </div>
        ))}
      </div>
      {!disabled && (
        <div className="flex gap-2">
          <Button onClick={addRow} className="bg-zinc-800 hover:bg-zinc-700 text-xs"><Plus className="w-3.5 h-3.5" /> Janela</Button>
          <Button onClick={save} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-xs">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Salvar janelas</Button>
        </div>
      )}
    </div>
  );
}

// ── Disponibilidade + agendamento ──
function AvailabilityBooker({ rel, contacts, autobooking, onBooked }: { rel: Relationship; contacts: ContactLite[]; autobooking: boolean; onBooked: () => void }) {
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<Slot | null>(null);

  useEffect(() => { (async () => { try { const d = await jread(`${NET}/relationships/${rel.id}/offerings`); setOfferings(Array.isArray(d) ? d : []); } catch { setOfferings([]); } })(); }, [rel.id]);

  const search = async () => {
    if (!serviceId) { toast.error('Escolha um serviço.'); return; }
    setLoading(true); setSlots(null);
    try { const d = await jread(`${NET}/relationships/${rel.id}/availability?date=${date}&serviceId=${encodeURIComponent(serviceId)}`); setSlots(Array.isArray(d) ? d : []); }
    catch (e: any) { toast.error(e?.message || 'Falha ao buscar vagas.'); setSlots([]); } finally { setLoading(false); }
  };

  const waitlist = async () => {
    try { await jread(`${NET}/relationships/${rel.id}/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId }) }); toast.success('Demanda registrada na fila (a operação será avisada).'); }
    catch (e: any) { toast.error(e?.message || 'Falha.'); }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center gap-1.5 text-zinc-300 text-sm font-medium mb-2"><CalendarClock className="w-4 h-4" /> Disponibilidade & agendamento</div>
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm">
          <option value="">Serviço…</option>
          {offerings.map((o) => <option key={o.id} value={o.serviceId}>{o.serviceName || o.serviceId}</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
        <Button onClick={search} disabled={loading} className="bg-emerald-600 hover:bg-emerald-500 text-sm">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />} Ver vagas</Button>
      </div>

      {offerings.length === 0 && <div className="text-xs text-amber-400/80">Configure ao menos um serviço ofertado (acima) para buscar vagas.</div>}

      {slots !== null && (
        slots.length ? (
          <div className="flex flex-wrap gap-1.5">
            {slots.map((s) => (
              <button key={s.start} onClick={() => setBooking(s)} className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-emerald-600 text-sm text-zinc-200 hover:text-white transition-colors">{hhmm(s.start)}</button>
            ))}
          </div>
        ) : (
          <div className="text-sm text-zinc-500 flex items-center gap-3">
            Nenhuma vaga nesse dia.
            <button onClick={waitlist} className="text-emerald-400 hover:underline inline-flex items-center gap-1"><ListPlus className="w-3.5 h-3.5" /> Entrar na fila</button>
            {autobooking && serviceId && <AutoBookButton relId={rel.id} serviceId={serviceId} contacts={contacts} />}
          </div>
        )
      )}

      {booking && <BookingModal rel={rel} slot={booking} serviceId={serviceId} contacts={contacts} onClose={() => setBooking(null)} onDone={() => { setBooking(null); search(); onBooked(); }} />}
    </div>
  );
}

// AutoBooking: PROPÕE o comando governado (nunca agenda direto — RN-PN-6).
function AutoBookButton({ relId, serviceId, contacts }: { relId: string; serviceId: string; contacts: ContactLite[] }) {
  const [busy, setBusy] = useState(false);
  const propose = async () => {
    const contactId = contacts[0]?.id;
    if (!contactId) { toast.error('Cadastre um cliente antes.'); return; }
    setBusy(true);
    try { await jread(`${NET}/relationships/${relId}/autobook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId, serviceId, days: 14 }) }); toast.success('AutoBooking proposto — aguardando aprovação na Execução.'); }
    catch (e: any) { toast.error(e?.message || 'Falha.'); } finally { setBusy(false); }
  };
  return <button onClick={propose} disabled={busy} className="text-indigo-300 hover:underline inline-flex items-center gap-1">{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3.5 h-3.5" />} Propor AutoBooking</button>;
}

// Modal: hold atômico → confirm booking (cria appointment federado).
function BookingModal({ rel, slot, serviceId, contacts, onClose, onDone }: { rel: Relationship; slot: Slot; serviceId: string; contacts: ContactLite[]; onClose: () => void; onDone: () => void }) {
  const [contactId, setContactId] = useState('');
  const [pets, setPets] = useState<Array<{ id: string; name: string }>>([]);
  const [petId, setPetId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!contactId) { setPets([]); setPetId(''); return; }
    apiFetch(`/api/clinic/pets?tutor=${encodeURIComponent(contactId)}`).then((r) => (r.ok ? r.json() : { pets: [] })).then((d) => setPets(Array.isArray(d?.pets) ? d.pets : [])).catch(() => setPets([]));
  }, [contactId]);

  const confirm = async () => {
    if (!contactId) { toast.error('Escolha o cliente.'); return; }
    setBusy(true);
    try {
      // 1) segura a vaga (hold atômico) — se outra reserva pegou, avisa.
      const hold = await jread(`${NET}/relationships/${rel.id}/holds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId, startISO: slot.start }) });
      // 2) confirma → cria o appointment federado (idempotente por hold).
      await jread(`${NET}/holds/${hold.id}/booking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId, petId: petId || null, title: title.trim() || null }) });
      toast.success('Agendamento confirmado.');
      onDone();
    } catch (e: any) {
      toast.error(e?.message === 'slot_taken' ? 'Essa vaga acabou de ser preenchida — escolha outra.' : (e?.message || 'Falha ao agendar.'));
      if (e?.message === 'slot_taken') onDone();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-zinc-100">Agendar {rel.professional?.name} — {hhmm(slot.start)} às {hhmm(slot.end)}</div>
        <select value={contactId} onChange={(e) => setContactId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm">
          <option value="">Cliente / tutor…</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
        </select>
        {pets.length > 0 && (
          <select value={petId} onChange={(e) => setPetId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm">
            <option value="">Pet (opcional)…</option>
            {pets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (opcional)" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm" />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} className="bg-zinc-800 hover:bg-zinc-700 text-sm">Cancelar</Button>
          <Button onClick={confirm} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-sm">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Confirmar</Button>
        </div>
      </div>
    </div>
  );
}
