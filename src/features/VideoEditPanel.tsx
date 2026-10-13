import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, Film, Download } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import {
  buildRenderBody, canCancel, errorText, formatDuration, isActive, isFinal, MAX_POLL_ATTEMPTS, optionAvailability,
  pausesSummary, pollDelayMs, resultSummary, statusLabel, type Caps, type Form,
} from './videoedit/videoEditLabels';

// Editar vídeo (ADR-207 F13b.9). Só CHAMA o que já existe (`/api/studio/video-post/*`): quem corta, legenda e decide o que cabe é o servidor.
// A edição roda em segundo plano (fila existente); aqui só se pede, acompanha e cancela. Sem percentual inventado: só a situação real.

type Channel = { channel: string; label: string };
type Job = { id: string; creationId: string; channel: string; status: string; result: any; error: string | null; createdAt: string };
const API = '/api/studio/video-post';
const json = { 'Content-Type': 'application/json' };

export default function VideoEditPanel({ creationId, prompt, onClose, onDone }: { creationId: string; prompt?: string; onClose: () => void; onDone: () => void }) {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [capsErr, setCapsErr] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [hasTranscript, setHasTranscript] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [form, setForm] = useState<Form>({ creationId, channel: '', topic: '', subtitles: false, removePauses: false, title: false, titleText: '', cta: false, ctaText: '' });
  const [plan, setPlan] = useState<any>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [requested, setRequested] = useState({ subtitles: false, removePauses: false, title: false, cta: false });
  const [recent, setRecent] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const options = optionAvailability(caps, hasTranscript);

  const loadRecent = () => apiFetch(`${API}/jobs?limit=5`).then((r) => r.json()).then((d) => { if (alive.current) setRecent(Array.isArray(d.jobs) ? d.jobs : []); }).catch(() => {});
  useEffect(() => {
    apiFetch(`${API}/capabilities`).then((r) => r.json()).then((c) => alive.current && setCaps(c)).catch(() => alive.current && setCapsErr(true));
    apiFetch('/api/studio/channels').then((r) => r.json()).then((d) => alive.current && setChannels(Array.isArray(d.channels) ? d.channels : [])).catch(() => {});
    apiFetch(`${API}/${creationId}/transcript`).then((r) => alive.current && setHasTranscript(r.ok)).catch(() => {});
    loadRecent();
  }, [creationId]);

  // Acompanha o job até terminar (ou desiste de olhar depois de ~15 min: ele segue no servidor e aparece em "Edições recentes").
  const jobId = job?.id;
  const jobActive = job ? isActive(job.status) : false;
  useEffect(() => {
    if (!jobId || !jobActive) return;
    let cancelled = false; let attempt = 0; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (cancelled || !alive.current) return;
      try {
        const r = await apiFetch(`${API}/jobs/${jobId}`);
        const d = await r.json().catch(() => ({}));
        if (cancelled || !alive.current) return;
        if (r.ok) {
          setJob(d);
          if (isFinal(d.status)) {
            loadRecent();
            if (d.status === 'completed') { onDone(); toast.success('Vídeo editado!'); }
            return;
          }
        }
      } catch { /* tenta de novo */ }
      attempt++;
      if (attempt >= MAX_POLL_ATTEMPTS) return;
      timer = setTimeout(tick, pollDelayMs(attempt));
    };
    timer = setTimeout(tick, pollDelayMs(0));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, jobActive]);

  const transcribe = async () => {
    setTranscribing(true);
    try {
      const r = await apiFetch(`${API}/${creationId}/transcribe`, { method: 'POST', headers: json, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(errorText(r.status, d)); return; }
      setHasTranscript(true);
      toast.success(d.speechDetected === false ? 'Não ouvi fala nesse vídeo.' : 'Transcrição pronta.');
    } finally { if (alive.current) setTranscribing(false); }
  };

  const seePlan = async () => {
    if (!form.channel || form.topic.trim().length < 2) { toast.error('Escolha o canal e diga do que é o vídeo.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`${API}/plan`, { method: 'POST', headers: json, body: JSON.stringify({ topic: form.topic.trim(), channels: [form.channel] }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(errorText(r.status, d)); return; }
      setPlan(d.plans?.[0] || null);
    } finally { if (alive.current) setBusy(false); }
  };

  const start = async () => {
    const built = buildRenderBody(form, options);
    if (built.ok === false) { toast.error(built.error); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`${API}/render-async`, { method: 'POST', headers: json, body: JSON.stringify(built.body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(errorText(r.status, d)); return; }
      setRequested({ subtitles: form.subtitles, removePauses: form.removePauses, title: form.title, cta: form.cta });
      setJob(d);
      loadRecent();
      if (d.deduplicated) toast.success('Essa edição já estava em andamento.');
    } finally { if (alive.current) setBusy(false); }
  };

  const cancel = async () => {
    if (!job) return;
    const r = await apiFetch(`${API}/jobs/${job.id}/cancel`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setJob({ ...job, status: 'cancelled' }); loadRecent(); toast.success('Edição cancelada.'); }
    else { toast.error(d.message || errorText(r.status, d)); apiFetch(`${API}/jobs/${job.id}`).then((x) => x.json()).then((j) => alive.current && j?.id && setJob(j)).catch(() => {}); }
  };

  const fieldCls = 'w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100';
  const opt = (id: 'subtitles' | 'removePauses' | 'title' | 'cta', label: string, hint: string, a: { enabled: boolean; reason: string | null }) => (
    <label className={`flex items-start gap-3 rounded-lg border border-zinc-800 p-3 ${a.enabled ? 'cursor-pointer' : 'opacity-60'}`}>
      <input type="checkbox" className="mt-1 h-4 w-4" checked={form[id] && a.enabled} disabled={!a.enabled || !!job && isActive(job.status)} onChange={(e) => set({ [id]: e.target.checked } as any)} />
      <span className="text-sm"><span className="text-zinc-100">{label}</span><span className="block text-xs text-zinc-500">{a.enabled ? hint : a.reason}</span></span>
    </label>
  );

  const summary = job?.status === 'completed' ? resultSummary(job.result, requested) : null;
  const pauses = job?.status === 'completed' ? pausesSummary(job.result?.pauses) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Editar vídeo">
      <div className="w-full sm:max-w-xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium text-zinc-100 flex items-center gap-2"><Film className="w-4 h-4 text-fuchsia-400" /> Editar vídeo</h3>
          <button onClick={onClose} aria-label="Fechar" className="p-1 text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        {capsErr && <p className="text-sm text-amber-400">Não consegui verificar se a edição está disponível. Feche e abra de novo.</p>}
        {!caps && !capsErr && <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Verificando…</p>}
        {caps && !caps.ffmpeg && <p className="text-sm text-amber-400">{options.pauses.reason}</p>}

        {caps && caps.ffmpeg && !job && (
          <div className="space-y-3">
            {prompt && <p className="text-xs text-zinc-500 line-clamp-2">Vídeo: {prompt}</p>}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Onde vai publicar</label>
              <select className={fieldCls} value={form.channel} onChange={(e) => { set({ channel: e.target.value }); setPlan(null); }}>
                <option value="">Escolha…</option>
                {channels.map((c) => <option key={c.channel} value={c.channel}>{c.label}</option>)}
              </select>
              <p className="text-[11px] text-zinc-500 mt-1">O vídeo é cortado e enquadrado no formato do canal. O original não é alterado.</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Do que é o vídeo?</label>
              <input className={fieldCls} maxLength={140} placeholder="Ex.: camisa de linho nova" value={form.topic} onChange={(e) => { set({ topic: e.target.value }); setPlan(null); }} />
            </div>

            <div className="space-y-2">
              {opt('removePauses', 'Cortar pausas', 'Tira os silêncios longos e deixa um respiro junto das falas.', options.pauses)}
              <div>
                {opt('subtitles', 'Legenda automática', 'Escreve o que é falado, na imagem.', options.subtitles)}
                {options.subtitles.needsTranscript && (
                  <button className="mt-1 text-xs text-fuchsia-300 hover:underline disabled:opacity-50" disabled={transcribing} onClick={transcribe}>
                    {transcribing ? 'Transcrevendo…' : 'Transcrever agora (usa IA)'}
                  </button>
                )}
              </div>
              <div>
                {opt('title', 'Título na imagem', 'Aparece no topo nos primeiros segundos.', options.title)}
                {form.title && options.title.enabled && <input className={`${fieldCls} mt-1`} maxLength={140} placeholder={plan?.title ? `Em branco: "${plan.title}"` : 'Em branco: uso o título sugerido'} value={form.titleText} onChange={(e) => set({ titleText: e.target.value })} />}
              </div>
              <div>
                {opt('cta', 'Chamada para ação no final', 'Aparece no meio da tela nos últimos segundos.', options.cta)}
                {form.cta && options.cta.enabled && <input className={`${fieldCls} mt-1`} maxLength={140} placeholder={plan?.ctaText ? `Em branco: "${plan.ctaText}"` : 'Em branco: uso a chamada sugerida'} value={form.ctaText} onChange={(e) => set({ ctaText: e.target.value })} />}
              </div>
            </div>

            {plan && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400 space-y-1">
                <p><b className="text-zinc-300">{plan.label}</b> · formato {plan.aspect} · até {formatDuration(plan.targetDurationSec)}</p>
                {(plan.caveats || []).slice(0, 2).map((c: string, i: number) => <p key={i}>• {c}</p>)}
                <p className="text-zinc-500">Isso é o plano; o tempo real depende do vídeo. Pausas cortadas deixam o vídeo mais curto.</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50" disabled={busy} onClick={seePlan}>Ver o que vou fazer</button>
              <button className="rounded-lg bg-fuchsia-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:opacity-50 flex-1" disabled={busy} onClick={start}>
                {busy ? 'Enviando…' : 'Editar vídeo'}
              </button>
            </div>
          </div>
        )}

        {job && (
          <div className="space-y-3">
            <p className={`text-sm flex items-center gap-2 ${job.status === 'failed' ? 'text-red-400' : job.status === 'completed' ? 'text-emerald-400' : 'text-zinc-200'}`}>
              {isActive(job.status) && <Loader2 className="w-4 h-4 animate-spin" />} {statusLabel(job.status)}
            </p>
            {isActive(job.status) && <p className="text-xs text-zinc-500">Pode fechar esta janela: a edição continua e aparece em “Edições recentes”.</p>}
            {job.status === 'failed' && <p className="text-sm text-zinc-300">{job.error || 'Não consegui editar esse vídeo.'}</p>}
            {job.status === 'completed' && job.result?.mediaUrl && (
              <div className="space-y-2">
                <video src={job.result.mediaUrl} controls className="w-full max-w-xs rounded-lg border border-zinc-800" />
                <a href={job.result.mediaUrl} download className="inline-flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300"><Download className="w-3.5 h-3.5" /> Baixar</a>
                {summary && summary.done.length > 0 && <p className="text-xs text-zinc-300">Feito: {summary.done.join(' · ')}</p>}
                {pauses && <p className="text-xs text-zinc-400">{pauses}</p>}
                {summary && summary.notDone.map((n, i) => <p key={i} className="text-xs text-amber-400">• {n}</p>)}
              </div>
            )}
            <div className="flex gap-2">
              {canCancel(job.status) && <button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800" onClick={cancel}>Cancelar edição</button>}
              {isFinal(job.status) && <button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800" onClick={() => { setJob(null); setPlan(null); }}>Fazer outra edição</button>}
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="mt-5 border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-400 mb-1">Edições recentes</p>
            <ul className="space-y-1">
              {recent.map((j) => (
                <li key={j.id} className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                  <span>{channels.find((c) => c.channel === j.channel)?.label || j.channel} · {statusLabel(j.status)}</span>
                  {j.status === 'completed' && j.result?.mediaUrl && <a href={j.result.mediaUrl} target="_blank" rel="noreferrer" className="text-fuchsia-400 hover:underline">Ver</a>}
                  {isActive(j.status) && <button className="text-zinc-400 hover:underline" onClick={() => { setJob(j); }}>Acompanhar</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
