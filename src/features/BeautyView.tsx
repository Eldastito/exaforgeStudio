/**
 * BeautyView (ADR-169 F19 / BEAUTY-020) — UI da vertical Beleza & Salões.
 *
 * Consome as 18 rotas de `/api/beauty/*` do backend (F5–F13). Fluxo visual
 * segue o §7 do PRD (jornada da cliente):
 *
 *  1. Concede consent tipado (hair_simulation) pra um contato
 *  2. Inicia uma consulta visual + upload da foto de referência
 *  3. Aprova a foto → dispara simulação (color/cut/combined)
 *  4. Vê o resultado → escolhe o visual → dispara análise de harmonia
 *     (descritiva, RN-BS-03) → recomenda serviços do catálogo real (RN-BS-11)
 *  5. Vê availability por profissional → reserva slot → status='scheduled'
 *
 * A view respeita:
 *  - RN-BS-04: só oferece scopes tipados (hair_simulation ≠ marketing)
 *  - RN-BS-08: valores nunca aparecem em rotas públicas — só via role-gate
 *    do backend (a view lê o que o backend devolveu)
 *  - RN-BS-11: recomendação vem do catálogo — nunca lista arbitrária local
 *
 * NÃO é uma view do CLIENTE FINAL (o cliente é sempre atendido por um
 * humano da recepção — a view é operada por recepção/estilista/dona).
 * Portanto entrada é `contactId` já cadastrado, não um formulário público.
 */
import React, { useEffect, useState } from 'react';
import { Wand2, Upload, Sparkles, Palette, CalendarClock, CheckCircle2, XCircle, Loader2, User, Star } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

type Consultation = {
  id: string;
  contactId: string | null;
  status: 'draft' | 'ready' | 'selected' | 'scheduled' | 'abandoned';
  goal: string | null;
  intensity: string | null;
  selectedSimulationId: string | null;
  scheduledAppointmentId: string | null;
};

type Simulation = {
  id: string;
  consultationId: string;
  status: 'CREATED' | 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED_FINAL';
  parameters: { color?: string | null; cut?: string | null } | null;
  outputSignedUrl?: string | null;
};

type Asset = {
  id: string;
  status: 'quarantined' | 'approved' | 'rejected' | 'deleted' | 'expired';
  signedUrl?: string | null;
};

type ServiceRec = {
  serviceId: string;
  name: string;
  price: number | null;
  durationMinutes: number | null;
  relevance: 'primary' | 'matched' | 'generic';
  matchReason: string;
};

type ProfessionalSlot = {
  professionalId: string;
  professionalName: string;
  isPrimary: boolean;
  slots: { startISO: string; endISO: string; durationMinutes: number }[];
};

type Contact = { id: string; name: string; identifier?: string };

export function BeautyView() {
  // F22: a lista de clientes vem de GET /api/beauty/clients (lê a tabela
  // `contacts` direto), NÃO de useStore.contacts — que é hidratado de
  // /api/tickets e só enxerga contatos que já tiveram conversa. Um salão
  // atende clientes walk-in (sem mensagem prévia), então o seletor precisa
  // ver TODOS os contatos + permitir cadastrar um novo na hora.
  const [contactsArr, setContactsArr] = useState<Contact[]>([]);
  const [newName, setNewName] = useState<string>('');
  const [newPhone, setNewPhone] = useState<string>('');
  const [showNewClient, setShowNewClient] = useState<boolean>(false);

  const [contactId, setContactId] = useState<string>('');
  const [goal, setGoal] = useState<string>('coloração');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadClients(selectId?: string): Promise<void> {
    try {
      const r = await apiFetch('/api/beauty/clients');
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d?.clients)) {
        setContactsArr(d.clients);
        if (selectId) setContactId(selectId);
      }
    } catch { /* noop */ }
  }
  useEffect(() => { loadClients(); }, []);

  async function createClient(): Promise<void> {
    const name = newName.trim();
    if (!name) { setError('Informe o nome da cliente.'); return; }
    setBusy(true); setError(null);
    try {
      const r = await apiFetch('/api/beauty/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone: newPhone.trim() }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Falha ao cadastrar cliente.'); }
      const d = await r.json();
      await loadClients(d?.client?.id);
      setNewName(''); setNewPhone(''); setShowNewClient(false);
    } catch (e: any) { setError(e?.message || 'Erro ao cadastrar cliente.'); }
    finally { setBusy(false); }
  }

  const [consultation, setConsultation] = useState<Consultation | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [selectedSim, setSelectedSim] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<ServiceRec[]>([]);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [availability, setAvailability] = useState<ProfessionalSlot[]>([]);
  const [scheduledAppointmentId, setScheduledAppointmentId] = useState<string | null>(null);
  const [analysisNarrative, setAnalysisNarrative] = useState<string | null>(null);

  // ─── Consulta / upload ───────────────────────────────────────────────
  async function grantConsentAndStart(): Promise<void> {
    if (!contactId) { setError('Selecione um contato'); return; }
    setBusy(true); setError(null);
    try {
      // 1. Consent tipado
      await apiFetch('/api/beauty/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, scope: 'hair_simulation' }),
      });
      // 2. Inicia consulta
      const r = await apiFetch('/api/beauty/consultations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, goal }),
      });
      if (!r.ok) throw new Error(await r.text());
      const cons = await r.json();
      setConsultation(cons);
      setAssets([]); setSimulations([]); setSelectedSim(null);
      setRecommendations([]); setAvailability([]); setScheduledAppointmentId(null);
      setAnalysisNarrative(null);
    } catch (e: any) { setError(e?.message || 'Erro ao iniciar consulta'); }
    finally { setBusy(false); }
  }

  async function uploadPhoto(file: File): Promise<void> {
    if (!consultation) return;
    setBusy(true); setError(null);
    try {
      // NOME DO CAMPO: 'file' — o backend usa `avatarUpload.single("file")` em
      // routes/beauty.ts:192. Mandar em outro nome (ex.: 'photo') faz o multer
      // lançar `MulterError: Unexpected field` porque single() só aceita UM
      // campo com o nome registrado; qualquer arquivo em outro campo dispara
      // LIMIT_UNEXPECTED_FILE, que não é tratado no try/catch do handler (ele
      // acontece ANTES) e cai no error handler default do Express — resposta
      // vira HTML "Internal Server Error" (500) em vez de JSON. Padrão idêntico
      // ao FashionAvatarService pra consistência entre as duas superfícies.
      const fd = new FormData();
      fd.append('file', file);
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!r.ok) throw new Error(await r.text());
      await refreshConsultation();
    } catch (e: any) { setError(e?.message || 'Erro no upload'); }
    finally { setBusy(false); }
  }

  async function approveAsset(assetId: string): Promise<void> {
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/api/beauty/assets/${assetId}/approve`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      await refreshConsultation();
    } catch (e: any) { setError(e?.message || 'Erro ao aprovar'); }
    finally { setBusy(false); }
  }

  async function refreshConsultation(): Promise<void> {
    if (!consultation) return;
    const r = await apiFetch(`/api/beauty/consultations/${consultation.id}`);
    if (!r.ok) return;
    const d = await r.json();
    if (d?.consultation) setConsultation(d.consultation);
    if (d?.assets) setAssets(d.assets);
    if (d?.simulations) setSimulations(d.simulations);
  }

  async function requestSimulation(type: 'color' | 'cut' | 'combined', paramName: string): Promise<void> {
    if (!consultation) return;
    setBusy(true); setError(null);
    try {
      const parameters = type === 'combined'
        ? { color: paramName.split('/')[0], cut: paramName.split('/')[1] }
        : { [type]: paramName };
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulationType: type, parameters }),
      });
      if (!r.ok) throw new Error(await r.text());
      // Poll status até SUCCEEDED
      const { simulationId } = await r.json();
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        const sr = await apiFetch(`/api/beauty/simulations/${simulationId}`);
        if (sr.ok) {
          const s = await sr.json();
          if (s?.status === 'SUCCEEDED' || s?.status === 'FAILED_FINAL') break;
        }
      }
      await refreshConsultation();
    } catch (e: any) { setError(e?.message || 'Erro na simulação'); }
    finally { setBusy(false); }
  }

  async function selectSimulation(simId: string): Promise<void> {
    if (!consultation) return;
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulationId: simId }),
      });
      if (!r.ok) throw new Error(await r.text());
      setSelectedSim(simId);
      await refreshConsultation();
      // Carrega recomendações + análise
      await loadRecommendations(simId);
      await runAnalysis(simId);
    } catch (e: any) { setError(e?.message || 'Erro ao selecionar'); }
    finally { setBusy(false); }
  }

  async function loadRecommendations(simId: string): Promise<void> {
    const r = await apiFetch(`/api/beauty/simulations/${simId}/recommendations`);
    if (!r.ok) return;
    const d = await r.json();
    if (d?.ok && Array.isArray(d?.recommendations)) setRecommendations(d.recommendations);
  }

  async function runAnalysis(simId: string): Promise<void> {
    if (!consultation) return;
    const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulationId: simId, reason: 'conversar sobre visual escolhido' }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d?.narrative) setAnalysisNarrative(d.narrative);
    }
  }

  async function loadAvailability(serviceId: string): Promise<void> {
    if (!consultation) return;
    setBusy(true); setError(null);
    try {
      const url = `/api/beauty/consultations/${consultation.id}/availability?serviceId=${encodeURIComponent(serviceId)}&days=7`;
      const r = await apiFetch(url);
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      if (d?.ok && Array.isArray(d?.professionals)) {
        setAvailability(d.professionals);
        setSelectedService(serviceId);
      } else {
        setError(d?.message || 'Sem disponibilidade');
        setAvailability([]);
      }
    } catch (e: any) { setError(e?.message || 'Erro ao ler disponibilidade'); }
    finally { setBusy(false); }
  }

  async function bookSlot(professionalId: string, startISO: string): Promise<void> {
    if (!consultation || !selectedService) return;
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: selectedService, professionalId, startISO }),
      });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      if (d?.ok) {
        setScheduledAppointmentId(d.appointmentId);
        await refreshConsultation();
      } else {
        setError(d?.message || 'Não foi possível reservar');
      }
    } catch (e: any) { setError(e?.message || 'Erro ao reservar'); }
    finally { setBusy(false); }
  }

  const disabled = busy || !consultation;
  const canSimulate = consultation?.status === 'ready';
  const canSelect = consultation && ['ready', 'selected'].includes(consultation.status);
  const scheduled = consultation?.status === 'scheduled';

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <header className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-pink-500/10">
          <Sparkles className="w-6 h-6 text-pink-500" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Beauty AI · Simulação de Visual</h1>
          <p className="text-sm text-slate-500">
            Simule o próximo visual da cliente, escolha os serviços do catálogo e agende com a profissional certa.
          </p>
        </div>
      </header>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-500 flex items-start gap-2">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* PASSO 1 — Nova consulta */}
      <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
        <h2 className="font-semibold mb-3 flex items-center gap-2"><User className="w-4 h-4" /> 1. Nova consulta visual</h2>

        {/* F22 — cadastro de cliente walk-in (a que chegou no balcão sem
            mensagem prévia). Cria o contato na hora e já seleciona. */}
        {showNewClient && !consultation && (
          <div className="mb-3 p-3 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}>
            <p className="text-xs text-slate-400 mb-2">Cadastrar cliente que está no balcão</p>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1 min-w-[160px]">
                <label className="text-xs text-slate-500">Nome</label>
                <input
                  className="w-full mt-1 p-2 rounded border bg-transparent"
                  style={{ borderColor: 'var(--color-border)' }}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="ex.: Emily Souza"
                  disabled={busy}
                />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="text-xs text-slate-500">Telefone (WhatsApp)</label>
                <input
                  className="w-full mt-1 p-2 rounded border bg-transparent"
                  style={{ borderColor: 'var(--color-border)' }}
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="ex.: 11999998888"
                  disabled={busy}
                />
              </div>
              <button
                onClick={createClient}
                disabled={busy || !newName.trim()}
                className="px-3 py-2 rounded bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50 flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <User className="w-4 h-4" />}
                Cadastrar
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <div className="flex items-center justify-between">
              <label className="text-xs text-slate-500">Cliente</label>
              {!consultation && (
                <button
                  type="button"
                  onClick={() => setShowNewClient(v => !v)}
                  className="text-xs text-pink-400 hover:text-pink-300"
                >
                  {showNewClient ? 'Cancelar' : '+ Nova cliente'}
                </button>
              )}
            </div>
            <select
              className="w-full mt-1 p-2 rounded border bg-transparent"
              style={{ borderColor: 'var(--color-border)' }}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={busy || !!consultation}
            >
              <option value="">— Selecione um contato —</option>
              {contactsArr.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` (${c.identifier})` : ''}</option>
              ))}
            </select>
            {contactsArr.length === 0 && !showNewClient && (
              <p className="text-xs text-slate-500 mt-1">Nenhuma cliente cadastrada. Clique em <b>+ Nova cliente</b> pra cadastrar a que está no balcão.</p>
            )}
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-slate-500">Objetivo (goal)</label>
            <input
              className="w-full mt-1 p-2 rounded border bg-transparent"
              style={{ borderColor: 'var(--color-border)' }}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="ex.: coloração, mechas, escova"
              disabled={busy || !!consultation}
            />
          </div>
          <button
            onClick={grantConsentAndStart}
            disabled={busy || !!consultation || !contactId}
            className="px-4 py-2 rounded bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50 flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            Consent + Nova consulta
          </button>
        </div>
        {consultation && (
          <div className="mt-3 text-sm text-slate-500">
            Consulta <code className="text-xs">{consultation.id.slice(0, 8)}</code> · status: <b>{consultation.status}</b>
          </div>
        )}
      </section>

      {/* PASSO 2 — Upload foto + aprovar */}
      {consultation && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Upload className="w-4 h-4" /> 2. Foto de referência</h2>
          {assets.length === 0 && (
            <label className="block p-6 rounded border-2 border-dashed text-center cursor-pointer hover:bg-slate-500/5" style={{ borderColor: 'var(--color-border)' }}>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPhoto(f);
                }}
                disabled={disabled}
              />
              <Upload className="w-6 h-6 mx-auto text-slate-500 mb-2" />
              <div className="text-sm text-slate-500">Clique pra selecionar foto (JPG/PNG/WEBP até 15MB)</div>
            </label>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {assets.map((a) => (
              <div key={a.id} className="rounded border overflow-hidden" style={{ borderColor: 'var(--color-border)' }}>
                {a.signedUrl ? (
                  <img src={a.signedUrl} alt="referência" className="w-full aspect-square object-cover" />
                ) : (
                  <div className="w-full aspect-square bg-slate-500/10 flex items-center justify-center text-xs text-slate-400">sem preview</div>
                )}
                <div className="p-2 flex items-center justify-between text-xs">
                  <span className={`px-2 py-0.5 rounded ${a.status === 'approved' ? 'bg-green-500/20 text-green-500' : a.status === 'quarantined' ? 'bg-amber-500/20 text-amber-500' : 'bg-slate-500/20'}`}>
                    {a.status}
                  </span>
                  {a.status === 'quarantined' && (
                    <button onClick={() => approveAsset(a.id)} disabled={busy} className="text-pink-500 hover:underline">aprovar</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* PASSO 3 — Simular visual */}
      {canSimulate && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Palette className="w-4 h-4" /> 3. Simular visual</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => requestSimulation('color', 'morena_iluminada')} disabled={busy} className="px-3 py-2 rounded bg-purple-500/20 text-purple-500 hover:bg-purple-500/30 text-sm">Morena Iluminada</button>
            <button onClick={() => requestSimulation('color', 'balayage')} disabled={busy} className="px-3 py-2 rounded bg-amber-500/20 text-amber-500 hover:bg-amber-500/30 text-sm">Balayage</button>
            <button onClick={() => requestSimulation('color', 'loiro')} disabled={busy} className="px-3 py-2 rounded bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 text-sm">Loiro</button>
            <button onClick={() => requestSimulation('cut', 'bob')} disabled={busy} className="px-3 py-2 rounded bg-blue-500/20 text-blue-500 hover:bg-blue-500/30 text-sm">Corte Bob</button>
            <button onClick={() => requestSimulation('cut', 'chanel')} disabled={busy} className="px-3 py-2 rounded bg-cyan-500/20 text-cyan-500 hover:bg-cyan-500/30 text-sm">Corte Chanel</button>
          </div>
        </section>
      )}

      {/* PASSO 4 — Ver simulações + escolher */}
      {simulations.length > 0 && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Sparkles className="w-4 h-4" /> 4. Resultados da simulação</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {simulations.map((s) => (
              <div key={s.id} className={`rounded border overflow-hidden ${selectedSim === s.id ? 'ring-2 ring-pink-500' : ''}`} style={{ borderColor: 'var(--color-border)' }}>
                {s.outputSignedUrl && s.status === 'SUCCEEDED' ? (
                  <img src={s.outputSignedUrl} alt={`sim ${s.id.slice(0, 6)}`} className="w-full aspect-square object-cover" />
                ) : (
                  <div className="w-full aspect-square bg-slate-500/10 flex items-center justify-center text-xs text-slate-400">
                    {s.status === 'PROCESSING' || s.status === 'QUEUED' ? <Loader2 className="w-6 h-6 animate-spin" /> : s.status}
                  </div>
                )}
                <div className="p-2 space-y-1">
                  <div className="text-xs text-slate-500">
                    {s.parameters?.color && <span>Cor: {s.parameters.color}</span>}
                    {s.parameters?.color && s.parameters?.cut && ' · '}
                    {s.parameters?.cut && <span>Corte: {s.parameters.cut}</span>}
                  </div>
                  {s.status === 'SUCCEEDED' && canSelect && (
                    <button onClick={() => selectSimulation(s.id)} disabled={busy} className="w-full px-2 py-1 rounded text-xs bg-pink-500/20 text-pink-500 hover:bg-pink-500/30 flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Quero esse
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* PASSO 5 — Análise + recomendações */}
      {analysisNarrative && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Star className="w-4 h-4" /> Harmonia visual (descritiva)</h2>
          <p className="text-sm text-slate-400 italic">{analysisNarrative}</p>
        </section>
      )}

      {recommendations.length > 0 && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4" /> 5. Serviços recomendados</h2>
          <div className="space-y-2">
            {recommendations.map((rec) => (
              <div key={rec.serviceId} className="flex flex-wrap items-center gap-3 p-3 rounded border" style={{ borderColor: 'var(--color-border)' }}>
                <div className="flex-1 min-w-[200px]">
                  <div className="font-medium flex items-center gap-2">
                    {rec.name}
                    {rec.relevance === 'primary' && <span className="text-xs px-2 py-0.5 rounded bg-pink-500/20 text-pink-500">curado</span>}
                  </div>
                  <div className="text-xs text-slate-500">{rec.matchReason}</div>
                </div>
                <div className="text-sm text-slate-500">
                  {rec.price != null && <span>R$ {Number(rec.price).toFixed(2)}</span>}
                  {rec.price != null && rec.durationMinutes != null && ' · '}
                  {rec.durationMinutes != null && <span>{rec.durationMinutes}min</span>}
                </div>
                <button onClick={() => loadAvailability(rec.serviceId)} disabled={busy} className="px-3 py-1.5 rounded bg-pink-500/20 text-pink-500 hover:bg-pink-500/30 text-sm">
                  Ver horários
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* PASSO 6 — Availability + book */}
      {availability.length > 0 && !scheduled && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4" /> 6. Reservar horário</h2>
          {availability.map((p) => (
            <div key={p.professionalId} className="mb-3">
              <div className="text-sm font-medium mb-1 flex items-center gap-2">
                <User className="w-3 h-3" />
                {p.professionalName}
                {p.isPrimary && <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-500">primário</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {p.slots.length === 0 && <span className="text-xs text-slate-500">sem horário na janela</span>}
                {p.slots.map((s) => (
                  <button
                    key={s.startISO}
                    onClick={() => bookSlot(p.professionalId, s.startISO)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded bg-pink-500/20 text-pink-500 hover:bg-pink-500/30 text-xs"
                  >
                    {new Date(s.startISO).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {scheduled && scheduledAppointmentId && (
        <section className="p-4 rounded-lg border border-green-500/40 bg-green-500/5">
          <h2 className="font-semibold text-green-500 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" /> Agendado com sucesso!
          </h2>
          <p className="text-sm mt-1 text-slate-400">
            Appointment <code className="text-xs">{scheduledAppointmentId.slice(0, 8)}</code> reservado.
            O snapshot visual fica disponível pra profissional consultar antes do atendimento.
          </p>
        </section>
      )}
    </div>
  );
}

export default BeautyView;
