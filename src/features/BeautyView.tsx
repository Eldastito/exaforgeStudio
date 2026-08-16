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
import { Wand2, Upload, Sparkles, Palette, CalendarClock, CheckCircle2, XCircle, Loader2, User, Star, Download, Trash2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

// Extrai a mensagem humana do corpo de erro da API ({error: "..."}) — sem
// isso o usuário via o JSON cru no aviso e a causa real só no console.
async function readApiError(r: Response): Promise<string> {
  const raw = await r.text();
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.error === 'string' && j.error) return j.error;
  } catch { /* corpo não-JSON — usa o texto cru */ }
  return raw || `Erro ${r.status}`;
}

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
  // CAMPO: 'signedUrl' — o backend (BeautyHairSimulationService.getSimulation /
  // listForConsultation) devolve a URL da imagem gerada como `signedUrl`, NÃO
  // `outputSignedUrl`. Ler o campo errado fazia a imagem nunca renderizar
  // (caía no fallback que só mostrava o texto "SUCCEEDED").
  signedUrl?: string | null;
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

// Rótulo legível pt-BR pra uma chave snake_case do vocabulário
// (ex.: 'loiro_platinado' → 'Loiro Platinado').
function vocabLabel(key: string): string {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function BeautyView() {
  // F22: a lista de clientes vem de GET /api/beauty/clients (lê a tabela
  // `contacts` direto), NÃO de useStore.contacts — que é hidratado de
  // /api/tickets e só enxerga contatos que já tiveram conversa. Um salão
  // atende clientes walk-in (sem mensagem prévia), então o seletor precisa
  // ver TODOS os contatos + permitir cadastrar um novo na hora.
  const [contactsArr, setContactsArr] = useState<Contact[]>([]);
  const [newName, setNewName] = useState<string>('');
  const [newPhone, setNewPhone] = useState<string>('');
  const [newEmail, setNewEmail] = useState<string>('');
  const [showNewClient, setShowNewClient] = useState<boolean>(false);
  // Ficha capilar (F25) — vocab fechado; ajuda a recomendação e avisa a
  // profissional sobre histórico químico. Idade/peso/altura ficam FORA
  // (minimização LGPD — não mudam recomendação de cor/corte).
  const [pHairType, setPHairType] = useState<string>('');
  const [pThickness, setPThickness] = useState<string>('');
  const [pLength, setPLength] = useState<string>('');
  const [pChemical, setPChemical] = useState<string>('');
  const [pMaintenance, setPMaintenance] = useState<string>('');
  const [pLeadSource, setPLeadSource] = useState<string>('');

  const [contactId, setContactId] = useState<string>('');
  const [goal, setGoal] = useState<string>('coloração');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vocabulário de cores/cortes carregado do backend (GET /vocabulary) — a
  // fonte única (RN-BS-11). Assim as opções acompanham COLOR_VOCAB/CUT_VOCAB
  // sem hardcode no frontend.
  const [colors, setColors] = useState<string[]>([]);
  const [cuts, setCuts] = useState<string[]>([]);
  // F32 — objetivos de consulta prontos (dropdown): o usuário clica e escolhe
  // em vez de digitar. Fonte única no backend (CONSULTATION_GOALS).
  const [goals, setGoals] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    apiFetch('/api/beauty/vocabulary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) {
        setColors(Array.isArray(d.colors) ? d.colors : []);
        setCuts(Array.isArray(d.cuts) ? d.cuts : []);
        if (Array.isArray(d.goals) && d.goals.length) { setGoals(d.goals); setGoal((g) => g === 'coloração' ? d.goals[0].value : g); }
      } })
      .catch(() => {});
  }, []);

  // Fluxo GUIADO da simulação (F25): a cliente escolhe a COR → decide o
  // CORTE (manter o atual / escolher / sugestão do visagismo) → 1 clique em
  // "Gerar novo visual". A imagem só é gerada quando as escolhas fecham
  // (cada geração custa IA — nada de disparar por chip).
  const [chosenColor, setChosenColor] = useState<string | null>(null);
  const [cutMode, setCutMode] = useState<'keep' | 'choose' | 'suggest' | null>(null);
  const [chosenCut, setChosenCut] = useState<string | null>(null);

  // Visagismo (F24): análise facial técnica (subtom + formato do rosto) →
  // recomendação de cor + corte. NUNCA pontua atratividade (RN-BS-03).
  const [vProfile, setVProfile] = useState<string>('feminino');
  const [vUndertone, setVUndertone] = useState<string>(''); // '' = deixar a IA classificar (ou indeterminado)
  const [vFaceShape, setVFaceShape] = useState<string>('');
  const [visagism, setVisagism] = useState<any | null>(null);
  const [visagismAiAvailable, setVisagismAiAvailable] = useState<boolean>(false);
  useEffect(() => {
    apiFetch('/api/beauty/vocabulary/visagism')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setVisagismAiAvailable(!!d.aiAvailable); })
      .catch(() => {});
  }, []);

  // F28 — status do simulador (owner/admin): diz se há IA de imagem REAL
  // configurada no servidor. Se `isReal=false`, as imagens sairiam como
  // quadrados de demonstração — então o banner avisa em vez de deixar o dono
  // no escuro. Rota role-gated: não-admin recebe 403 e o banner some.
  const [simStatus, setSimStatus] = useState<{ isReal: boolean; activeProviderKey: string; keys: { openai: boolean; google: boolean; gemini: boolean } } | null>(null);
  useEffect(() => {
    apiFetch('/api/beauty/simulator-status')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && typeof d.isReal === 'boolean') setSimStatus(d); })
      .catch(() => {});
  }, []);

  async function runVisagism(): Promise<void> {
    if (!consultation) return;
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/visagism`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: vProfile,
          undertone: vUndertone || undefined,
          faceShape: vFaceShape || undefined,
          reason: 'orientar cor e corte por visagismo',
        }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || e.error || 'Falha no visagismo.'); }
      setVisagism(await r.json());
    } catch (e: any) { setError(e?.message || 'Erro no visagismo.'); }
    finally { setBusy(false); }
  }

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
        body: JSON.stringify({
          name,
          phone: newPhone.trim(),
          email: newEmail.trim(),
          profile: {
            hairType: pHairType || undefined,
            hairThickness: pThickness || undefined,
            hairLength: pLength || undefined,
            chemicalHistory: pChemical || undefined,
            maintenancePref: pMaintenance || undefined,
            leadSource: pLeadSource || undefined,
          },
        }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Falha ao cadastrar cliente.'); }
      const d = await r.json();
      await loadClients(d?.client?.id);
      setNewName(''); setNewPhone(''); setNewEmail('');
      setPHairType(''); setPThickness(''); setPLength(''); setPChemical(''); setPMaintenance(''); setPLeadSource('');
      setShowNewClient(false);
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

  // F26 — histórico de visuais do cliente: imagens já geradas ficam salvas;
  // rever não custa IA. Carrega quando a cliente é selecionada e recarrega
  // quando uma nova simulação conclui.
  const [clientHistory, setClientHistory] = useState<Simulation[]>([]);
  useEffect(() => {
    if (!contactId) { setClientHistory([]); return; }
    apiFetch(`/api/beauty/clients/${contactId}/simulations`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setClientHistory(Array.isArray(d?.simulations) ? d.simulations : []))
      .catch(() => setClientHistory([]));
  }, [contactId, simulations.length]);

  // ─── Consulta / upload ───────────────────────────────────────────────
  async function grantConsentAndStart(): Promise<void> {
    if (!contactId) { setError('Selecione um contato'); return; }
    setBusy(true); setError(null);
    try {
      // 1. Consent tipado. CAMPO: 'consentType' — o backend
      // (routes/beauty.ts POST /consents) lê `consentType`, NÃO `scope`.
      // Mandar `scope` fazia o consent falhar em silêncio (400 não checado)
      // e o upload da foto depois travava com "é preciso aceitar o termo de
      // uso da imagem (hair_simulation)". Checamos a resposta pra falhar alto.
      const rc = await apiFetch('/api/beauty/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, consentType: 'hair_simulation' }),
      });
      if (!rc.ok) { const e = await rc.json().catch(() => ({})); throw new Error(e.error || 'Falha ao registrar o consent (hair_simulation).'); }
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

  // Gera UMA simulação com cor e/ou corte explícitos. A imagem real pode
  // demorar (gpt-image/Gemini) — poll mais paciente (60 × 2s = 2min).
  async function generateSimulation(params: { color?: string | null; cut?: string | null }): Promise<void> {
    if (!consultation) return;
    const color = params.color || null;
    const cut = params.cut || null;
    if (!color && !cut) { setError('Escolha ao menos a cor ou o corte.'); return; }
    setBusy(true); setError(null);
    try {
      const simulationType = color && cut ? 'combined' : color ? 'color' : 'cut';
      const parameters: any = {};
      if (color) parameters.color = color;
      if (cut) parameters.cut = cut;
      const r = await apiFetch(`/api/beauty/consultations/${consultation.id}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulationType, parameters }),
      });
      if (!r.ok) throw new Error(await readApiError(r));
      const { simulationId } = await r.json();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const sr = await apiFetch(`/api/beauty/simulations/${simulationId}`);
        if (sr.ok) {
          const s = await sr.json();
          if (s?.status === 'SUCCEEDED' || s?.status === 'FAILED_FINAL') {
            if (s?.status === 'FAILED_FINAL') setError(s?.errorMessageSafe || 'A geração da imagem falhou — tente de novo.');
            break;
          }
        }
      }
      await refreshConsultation();
    } catch (e: any) { setError(e?.message || 'Erro na simulação'); }
    finally { setBusy(false); }
  }

  // F31 — baixar a imagem gerada (pra enviar pra cliente). Busca os bytes e
  // dispara o download com nome amigável; funciona mesmo a URL assinada
  // servindo inline (Content-Type image/*).
  async function downloadSimulation(sim: Simulation): Promise<void> {
    if (!sim.signedUrl) return;
    try {
      const r = await apiFetch(sim.signedUrl);
      if (!r.ok) throw new Error('Falha ao baixar a imagem.');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const parts = [sim.parameters?.color, sim.parameters?.cut].filter(Boolean).map((p) => vocabLabel(p as string));
      a.href = url;
      a.download = `visual-${parts.join('-') || sim.id.slice(0, 6)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e?.message || 'Erro ao baixar a imagem.'); }
  }

  // F31 — deletar uma imagem gerada (apaga do servidor). Pede confirmação.
  async function deleteSimulation(simId: string): Promise<void> {
    if (!window.confirm('Deletar esta imagem? Esta ação não pode ser desfeita.')) return;
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(`/api/beauty/simulations/${simId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(await readApiError(r));
      if (selectedSim === simId) setSelectedSim(null);
      await refreshConsultation();
      // Recarrega a galeria do histórico (some a imagem deletada).
      if (contactId) {
        apiFetch(`/api/beauty/clients/${contactId}/simulations`)
          .then(r => r.ok ? r.json() : null)
          .then(d => setClientHistory(Array.isArray(d?.simulations) ? d.simulations : []))
          .catch(() => {});
      }
    } catch (e: any) { setError(e?.message || 'Erro ao deletar a imagem.'); }
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
      if (!r.ok) throw new Error(await readApiError(r));
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
    // O <main> do App tem overflow-hidden — a view precisa rolar por conta
    // própria, senão o conteúdo que passa da altura da tela fica inacessível
    // (sem barra de rolagem). h-full + overflow-y-auto resolve.
    <div className="h-full w-full overflow-y-auto">
    <div className="p-6 space-y-6 max-w-5xl mx-auto pb-16">
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

      {/* F28 — banner de modo demonstração: quando não há IA de imagem REAL
          configurada no servidor, as imagens sairiam como quadrados de teste.
          Avisa o dono (owner/admin) com a causa exata: a chave não chegou ao
          container. Só aparece pra quem pode agir (rota role-gated). */}
      {simStatus && !simStatus.isReal && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/40 text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <b>Modo demonstração — nenhuma IA de imagem detectada no servidor.</b> As simulações sairão como quadrados de teste até configurar a chave.
            Defina <code className="px-1 rounded bg-black/10">OPENAI_API_KEY</code> (ou <code className="px-1 rounded bg-black/10">GOOGLE_AI_API_KEY</code>/<code className="px-1 rounded bg-black/10">GEMINI_API_KEY</code>) nas variáveis de ambiente do servidor <b>e refaça o deploy</b>.
            <span className="block mt-1 text-xs opacity-80">Detectado agora: OpenAI {simStatus.keys.openai ? '✓' : '✗'} · Google {simStatus.keys.google ? '✓' : '✗'} · Gemini {simStatus.keys.gemini ? '✓' : '✗'} · provider ativo: <code>{simStatus.activeProviderKey}</code></span>
          </div>
        </div>
      )}

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
              <div className="flex-1 min-w-[160px]">
                <label className="text-xs text-slate-500">E-mail (opcional)</label>
                <input
                  className="w-full mt-1 p-2 rounded border bg-transparent"
                  style={{ borderColor: 'var(--color-border)' }}
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="ex.: emily@email.com"
                  disabled={busy}
                />
              </div>
            </div>

            {/* Ficha capilar (opcional) — ajuda a IA e a profissional. */}
            <p className="text-xs text-slate-400 mt-3 mb-1">Ficha capilar (opcional — ajuda na recomendação)</p>
            <div className="flex flex-wrap gap-2">
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pHairType} onChange={(e) => setPHairType(e.target.value)} disabled={busy}>
                <option value="">Tipo de cabelo…</option>
                <option value="liso">Liso</option><option value="ondulado">Ondulado</option>
                <option value="cacheado">Cacheado</option><option value="crespo">Crespo</option>
              </select>
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pThickness} onChange={(e) => setPThickness(e.target.value)} disabled={busy}>
                <option value="">Espessura…</option>
                <option value="fino">Fino</option><option value="medio">Médio</option><option value="grosso">Grosso</option>
              </select>
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pLength} onChange={(e) => setPLength(e.target.value)} disabled={busy}>
                <option value="">Comprimento…</option>
                <option value="curto">Curto</option><option value="medio">Médio</option><option value="longo">Longo</option>
              </select>
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pChemical} onChange={(e) => setPChemical(e.target.value)} disabled={busy}>
                <option value="">Histórico químico…</option>
                <option value="virgem">Virgem (sem química)</option><option value="coloracao">Coloração</option>
                <option value="descoloracao">Descoloração</option><option value="progressiva">Progressiva</option>
                <option value="henna">Henna</option>
              </select>
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pMaintenance} onChange={(e) => setPMaintenance(e.target.value)} disabled={busy}>
                <option value="">Manutenção…</option>
                <option value="baixa">Prefere baixa manutenção</option>
                <option value="media">Manutenção média</option>
                <option value="alta">Topa alta manutenção</option>
              </select>
              <select className="p-2 rounded border bg-transparent text-sm" style={{ borderColor: 'var(--color-border)' }}
                value={pLeadSource} onChange={(e) => setPLeadSource(e.target.value)} disabled={busy}>
                <option value="">Como conheceu o salão…</option>
                <option value="indicacao">Indicação</option><option value="instagram">Instagram</option>
                <option value="passou_na_porta">Passou na porta</option><option value="google">Google</option>
                <option value="whatsapp">WhatsApp</option><option value="outro">Outro</option>
              </select>
            </div>

            <div className="mt-3">
              <button
                onClick={createClient}
                disabled={busy || !newName.trim()}
                className="px-4 py-2 rounded bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50 flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <User className="w-4 h-4" />}
                Cadastrar cliente
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
            <label className="text-xs text-slate-500">O que a cliente quer?</label>
            <select
              className="w-full mt-1 p-2 rounded border bg-transparent"
              style={{ borderColor: 'var(--color-border)' }}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={busy || !!consultation}
            >
              {goals.length === 0 && <option value={goal}>{goal}</option>}
              {goals.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
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

      {/* F26 — Visuais salvos da cliente (todas as consultas). Rever é grátis;
          só gerar algo NOVO custa IA. */}
      {contactId && clientHistory.length > 0 && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-1 flex items-center gap-2"><Star className="w-4 h-4" /> Visuais salvos desta cliente</h2>
          <p className="text-xs text-slate-500 mb-3">
            Imagens já geradas em consultas anteriores — rever e comparar não gasta geração de IA.
          </p>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {clientHistory.map((s) => (
              <div key={s.id} className="rounded border overflow-hidden" style={{ borderColor: 'var(--color-border)' }}>
                {s.signedUrl ? (
                  <img src={s.signedUrl} alt="visual salvo" className="w-full aspect-square object-cover" />
                ) : (
                  <div className="w-full aspect-square bg-slate-500/10 flex items-center justify-center text-[10px] text-slate-400">expirado</div>
                )}
                <div className="p-1 text-[10px] text-slate-500 truncate">
                  {s.parameters?.color ? vocabLabel(s.parameters.color) : ''}{s.parameters?.color && s.parameters?.cut ? ' · ' : ''}{s.parameters?.cut ? vocabLabel(s.parameters.cut) : ''}
                </div>
                {s.signedUrl && (
                  <div className="flex border-t" style={{ borderColor: 'var(--color-border)' }}>
                    <button onClick={() => downloadSimulation(s)} title="Baixar" disabled={busy}
                      className="flex-1 py-1 flex items-center justify-center text-slate-500 hover:bg-pink-500/10 hover:text-pink-500 disabled:opacity-50">
                      <Download className="w-3 h-3" />
                    </button>
                    <button onClick={() => deleteSimulation(s.id)} title="Deletar" disabled={busy}
                      className="flex-1 py-1 flex items-center justify-center text-slate-500 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50 border-l" style={{ borderColor: 'var(--color-border)' }}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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

      {/* PASSO 3 — Novo visual GUIADO: cor → corte → gerar (F25). A imagem só
          é gerada quando as escolhas fecham (cada geração custa IA). */}
      {canSimulate && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Palette className="w-4 h-4" /> 3. Montar o novo visual</h2>

          {/* 3a — Cor */}
          <div className="mb-4">
            <p className="text-xs font-medium text-pink-400 mb-1.5">
              1º) Escolha a cor {chosenColor && <span className="text-slate-400">— selecionada: <b>{vocabLabel(chosenColor)}</b></span>}
            </p>
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
              {colors.map((c) => (
                <button
                  key={c}
                  onClick={() => setChosenColor(chosenColor === c ? null : c)}
                  disabled={busy}
                  className={`px-3 py-1.5 rounded-full border text-sm disabled:opacity-50 ${chosenColor === c ? 'bg-pink-500 text-white border-pink-500' : 'hover:bg-pink-500/10'}`}
                  style={chosenColor === c ? {} : { borderColor: 'var(--color-border)' }}
                >
                  {vocabLabel(c)}
                </button>
              ))}
              {colors.length === 0 && <span className="text-xs text-slate-500">carregando cores…</span>}
            </div>
          </div>

          {/* 3b — Decisão do corte */}
          {chosenColor && (
            <div className="mb-4">
              <p className="text-xs font-medium text-blue-400 mb-1.5">2º) E o corte?</p>
              <div className="flex flex-wrap gap-2 mb-2">
                <button onClick={() => { setCutMode('keep'); setChosenCut(null); }} disabled={busy}
                  className={`px-3 py-1.5 rounded border text-sm ${cutMode === 'keep' ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-blue-500/10'}`}
                  style={cutMode === 'keep' ? {} : { borderColor: 'var(--color-border)' }}>
                  Manter o corte atual
                </button>
                <button onClick={() => { setCutMode('choose'); setChosenCut(null); }} disabled={busy}
                  className={`px-3 py-1.5 rounded border text-sm ${cutMode === 'choose' ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-blue-500/10'}`}
                  style={cutMode === 'choose' ? {} : { borderColor: 'var(--color-border)' }}>
                  Escolher um corte
                </button>
                <button onClick={async () => { setCutMode('suggest'); setChosenCut(null); if (!visagism) await runVisagism(); }} disabled={busy}
                  className={`px-3 py-1.5 rounded border text-sm ${cutMode === 'suggest' ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-blue-500/10'}`}
                  style={cutMode === 'suggest' ? {} : { borderColor: 'var(--color-border)' }}>
                  ✨ Sugestão da IA (visagismo)
                </button>
              </div>

              {cutMode === 'choose' && (
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
                  {cuts.map((c) => (
                    <button key={c} onClick={() => setChosenCut(chosenCut === c ? null : c)} disabled={busy}
                      className={`px-3 py-1.5 rounded-full border text-sm disabled:opacity-50 ${chosenCut === c ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-blue-500/10'}`}
                      style={chosenCut === c ? {} : { borderColor: 'var(--color-border)' }}>
                      {vocabLabel(c)}
                    </button>
                  ))}
                </div>
              )}

              {cutMode === 'suggest' && (
                <div className="rounded border p-3 space-y-3" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-2)' }}>
                  {/* Visagismo consolidado (F28): os controles de perfil/subtom/
                      formato do rosto vivem AQUI, no fluxo guiado — não há mais
                      card separado. Deixe subtom/rosto em branco pra IA analisar
                      a foto, ou informe manualmente pra refinar. */}
                  <div className="flex flex-wrap gap-2 items-end">
                    <div>
                      <label className="text-[10px] text-slate-500">Perfil</label>
                      <select className="w-full mt-0.5 p-1.5 rounded border bg-transparent text-xs" style={{ borderColor: 'var(--color-border)' }}
                        value={vProfile} onChange={(e) => setVProfile(e.target.value)} disabled={busy}>
                        <option value="feminino">Feminino</option>
                        <option value="masculino">Masculino</option>
                        <option value="neutro">Neutro</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500">Subtom de pele</label>
                      <select className="w-full mt-0.5 p-1.5 rounded border bg-transparent text-xs" style={{ borderColor: 'var(--color-border)' }}
                        value={vUndertone} onChange={(e) => setVUndertone(e.target.value)} disabled={busy}>
                        <option value="">{visagismAiAvailable ? '— IA analisa —' : '— selecione —'}</option>
                        <option value="quente">Quente</option><option value="frio">Frio</option><option value="neutro">Neutro</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500">Formato do rosto</label>
                      <select className="w-full mt-0.5 p-1.5 rounded border bg-transparent text-xs" style={{ borderColor: 'var(--color-border)' }}
                        value={vFaceShape} onChange={(e) => setVFaceShape(e.target.value)} disabled={busy}>
                        <option value="">{visagismAiAvailable ? '— IA analisa —' : '— selecione —'}</option>
                        <option value="oval">Oval</option><option value="redondo">Redondo</option><option value="quadrado">Quadrado</option>
                        <option value="coracao">Coração</option><option value="alongado">Alongado</option><option value="triangular">Triangular</option>
                      </select>
                    </div>
                    <button onClick={() => runVisagism()} disabled={busy}
                      className="px-3 py-1.5 rounded bg-pink-500/20 text-pink-500 hover:bg-pink-500/30 disabled:opacity-50 flex items-center gap-1 text-xs">
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {visagism ? 'Reanalisar' : 'Analisar'}
                    </button>
                  </div>

                  {!visagism && busy && <p className="text-xs text-slate-500">Analisando os traços do rosto e o tom de pele…</p>}
                  {visagism && (
                    <>
                      <p className="text-xs text-slate-400 italic">{visagism.narrative}</p>
                      {Array.isArray(visagism.recommendedCuts) && visagism.recommendedCuts.length > 0 ? (
                        <div>
                          <p className="text-xs font-medium text-blue-400 mb-1">Cortes sugeridos pra combinar com "{vocabLabel(chosenColor)}" — escolha um:</p>
                          <div className="flex flex-wrap gap-2">
                            {visagism.recommendedCuts.map((c: string) => (
                              <button key={c} onClick={() => setChosenCut(chosenCut === c ? null : c)} disabled={busy}
                                className={`px-3 py-1.5 rounded-full border text-sm ${chosenCut === c ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-blue-500/10'}`}
                                style={chosenCut === c ? {} : { borderColor: 'var(--color-border)' }}>
                                {vocabLabel(c)}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-slate-500">
                          Sem sugestão automática — informe o <b>formato do rosto</b> acima e clique em Reanalisar, ou volte e escolha o corte manualmente.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 3c — Gerar */}
          {chosenColor && cutMode && (cutMode === 'keep' || chosenCut) && (
            <button
              onClick={() => generateSimulation({ color: chosenColor, cut: cutMode === 'keep' ? null : chosenCut })}
              disabled={busy}
              className="px-5 py-2.5 rounded bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50 flex items-center gap-2 font-medium"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
              {busy ? 'Gerando o novo visual… (pode levar até 2 min)' : `Gerar novo visual — ${vocabLabel(chosenColor)}${chosenCut ? ' + ' + vocabLabel(chosenCut) : ' (corte atual)'}`}
            </button>
          )}
        </section>
      )}

      {/* PASSO 4 — Ver simulações + escolher */}
      {simulations.length > 0 && (
        <section className="p-4 rounded-lg border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Sparkles className="w-4 h-4" /> 4. Resultados da simulação</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {simulations.map((s) => (
              <div key={s.id} className={`rounded border overflow-hidden ${selectedSim === s.id ? 'ring-2 ring-pink-500' : ''}`} style={{ borderColor: 'var(--color-border)' }}>
                {s.signedUrl && s.status === 'SUCCEEDED' ? (
                  <img src={s.signedUrl} alt={`sim ${s.id.slice(0, 6)}`} className="w-full aspect-square object-cover" />
                ) : (
                  <div className="w-full aspect-square bg-slate-500/10 flex items-center justify-center text-xs text-slate-400">
                    {s.status === 'PROCESSING' || s.status === 'QUEUED' ? <Loader2 className="w-6 h-6 animate-spin" /> : s.status}
                  </div>
                )}
                <div className="p-2 space-y-1">
                  <div className="text-xs text-slate-500">
                    {s.parameters?.color && <span>Cor: {vocabLabel(s.parameters.color)}</span>}
                    {s.parameters?.color && s.parameters?.cut && ' · '}
                    {s.parameters?.cut && <span>Corte: {vocabLabel(s.parameters.cut)}</span>}
                  </div>
                  {s.status === 'SUCCEEDED' && canSelect && (
                    <button onClick={() => selectSimulation(s.id)} disabled={busy} className="w-full px-2 py-1 rounded text-xs bg-pink-500/20 text-pink-500 hover:bg-pink-500/30 flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Quero esse
                    </button>
                  )}
                  {/* F31 — baixar (pra enviar pra cliente) + deletar a imagem. */}
                  {s.status === 'SUCCEEDED' && s.signedUrl && (
                    <div className="flex gap-1">
                      <button onClick={() => downloadSimulation(s)} disabled={busy} title="Baixar imagem"
                        className="flex-1 px-2 py-1 rounded text-xs border hover:bg-pink-500/10 disabled:opacity-50 flex items-center justify-center gap-1" style={{ borderColor: 'var(--color-border)' }}>
                        <Download className="w-3 h-3" /> Baixar
                      </button>
                      <button onClick={() => deleteSimulation(s.id)} disabled={busy} title="Deletar imagem"
                        className="px-2 py-1 rounded text-xs border text-red-500 hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center" style={{ borderColor: 'var(--color-border)' }}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  {/* F25 — trocar SÓ a cor deste visual (mesmo corte), usando as
                      cores que o visagismo indicou. Cada clique gera de novo. */}
                  {s.status === 'SUCCEEDED' && visagism && Array.isArray(visagism.recommendedColors) && visagism.recommendedColors.length > 0 && (
                    <div className="pt-1">
                      <p className="text-[10px] text-slate-500 mb-1">Trocar a cor deste visual:</p>
                      <div className="flex flex-wrap gap-1">
                        {visagism.recommendedColors.filter((c: string) => c !== s.parameters?.color).slice(0, 6).map((c: string) => (
                          <button key={c} onClick={() => generateSimulation({ color: c, cut: s.parameters?.cut || null })} disabled={busy}
                            className="px-2 py-0.5 rounded-full border text-[10px] hover:bg-pink-500/10 disabled:opacity-50"
                            style={{ borderColor: 'var(--color-border)' }}>
                            {vocabLabel(c)}
                          </button>
                        ))}
                      </div>
                    </div>
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
    </div>
  );
}

export default BeautyView;
