import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, ClipboardCheck } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import {
  buildBody, channelLabel, CHANNELS, emptyForm, errorText, METRICS, metricsLine, resultLines, shortLink, variantOptions, type Form, type MetricKey,
} from './manualresult/manualResultLabels';

// Registrar resultado de post feito à mão (ADR-207 F13c, 2ª etapa). Só CHAMA o que já existe (`/api/studio/manual-result(s)`):
// quem valida o link, normaliza e decide o que vale é o servidor. Número digitado ≠ medido — e a tela diz isso.

type Item = { channel: string; postId: string; link: string; publishedAt: string | null; variantKey: string | null; analyticsAvailable: number } & Partial<Record<MetricKey, number | null>>;
const fieldCls = 'w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100';

export default function ManualResultPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<Form>(emptyForm());
  const [items, setItems] = useState<Item[]>([]);
  const [experiments, setExperiments] = useState<{ id: string; hypothesis: string }[]>([]);
  const [expId, setExpId] = useState('');
  const [variants, setVariants] = useState<{ key: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<ReturnType<typeof resultLines> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadItems = () => apiFetch('/api/studio/manual-results?limit=10').then((r) => r.json()).then((d) => { if (alive.current) setItems(Array.isArray(d.results) ? d.results : []); }).catch(() => {});
  useEffect(() => {
    loadItems();
    // Teste A/B é opcional: se não houver experimento (ou a rota negar), o campo simplesmente não aparece.
    apiFetch('/api/social/experiments?status=running').then((r) => (r.ok ? r.json() : { experiments: [] }))
      .then((d) => { if (alive.current) setExperiments(Array.isArray(d.experiments) ? d.experiments : []); }).catch(() => {});
  }, []);

  const pickExperiment = async (id: string) => {
    setExpId(id); setVariants([]); setForm((f) => ({ ...f, variantKey: '' }));
    if (!id) return;
    try { const r = await apiFetch(`/api/social/experiments/${id}`); const d = await r.json().catch(() => ({})); if (alive.current && r.ok) setVariants(variantOptions(d)); } catch { /* sem variantes: segue sem teste A/B */ }
  };

  const set = (patch: Partial<Form>) => { setForm((f) => ({ ...f, ...patch })); setSaved(null); setError(''); };
  const setMetric = (k: MetricKey, v: string) => { setForm((f) => ({ ...f, metrics: { ...f.metrics, [k]: v } })); setSaved(null); setError(''); };

  const submit = async () => {
    const built = buildBody(form);
    if ('error' in built) { setError(built.error); return; }
    setBusy(true); setError('');
    try {
      const r = await apiFetch('/api/studio/manual-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(errorText(r.status, d)); return; }
      if (!alive.current) return;
      setSaved(resultLines(d)); toast.success('Resultado registrado.'); loadItems();
    } finally { if (alive.current) setBusy(false); }
  };

  // Reabrir um já registrado: o mesmo link atualiza o mesmo post (o que ficar em branco não apaga o que já estava).
  const complete = (it: Item) => { setForm({ ...emptyForm(), channel: it.channel, link: it.link, variantKey: it.variantKey || '' }); setSaved(null); setError(''); };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Registrar resultado de um post">
      <div className="w-full sm:max-w-xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-medium text-zinc-100 flex items-center gap-2"><ClipboardCheck className="w-4 h-4 text-fuchsia-400" /> Registrar resultado de um post</h3>
          <button onClick={onClose} aria-label="Fechar" className="p-1 text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">Para posts que você publicou à mão no TikTok, LinkedIn, YouTube ou X. Os números são os que <b>você</b> digita — o sistema não consegue conferi-los nessas redes.</p>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Onde você postou</label>
            <select className={fieldCls} value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
              <option value="">Escolha…</option>
              {CHANNELS.map((c) => <option key={c.channel} value={c.channel}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Link do post</label>
            <input className={fieldCls} inputMode="url" placeholder="https://…" value={form.link} onChange={(e) => set({ link: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Quando postou <span className="text-zinc-600">(opcional)</span></label>
            <input type="datetime-local" className={fieldCls} value={form.publishedAt} onChange={(e) => set({ publishedAt: e.target.value })} />
          </div>

          <div>
            <p className="text-xs text-zinc-400 mb-1">Números <span className="text-zinc-600">(preencha só o que souber — em branco não vira zero)</span></p>
            <div className="grid grid-cols-2 gap-2">
              {METRICS.map((m) => (
                <label key={m.key} className="text-[11px] text-zinc-500">
                  {m.label}
                  <input className={`${fieldCls} mt-0.5`} inputMode="numeric" placeholder="—" value={form.metrics[m.key] ?? ''} onChange={(e) => setMetric(m.key, e.target.value)} />
                </label>
              ))}
            </div>
          </div>

          {experiments.length > 0 && (
            <div className="rounded-lg border border-zinc-800 p-3 space-y-2">
              <p className="text-xs text-zinc-400">Esse post faz parte de um teste A/B? <span className="text-zinc-600">(opcional)</span></p>
              <select className={fieldCls} value={expId} onChange={(e) => pickExperiment(e.target.value)}>
                <option value="">Não</option>
                {experiments.map((x) => <option key={x.id} value={x.id}>{x.hypothesis.slice(0, 70)}</option>)}
              </select>
              {variants.length > 0 && (
                <select className={fieldCls} value={form.variantKey} onChange={(e) => set({ variantKey: e.target.value })}>
                  <option value="">Qual versão?</option>
                  {variants.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
                </select>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
          {saved && (
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3 space-y-1">
              <p className="text-sm text-emerald-400">{saved.title}</p>
              {saved.notes.map((n, i) => <p key={i} className="text-xs text-zinc-400">• {n}</p>)}
              {saved.warnings.map((w, i) => <p key={i} className="text-xs text-amber-400">• {w}</p>)}
            </div>
          )}

          <button className="w-full rounded-lg bg-fuchsia-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:opacity-50 flex items-center justify-center gap-2" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {busy ? 'Salvando…' : 'Registrar'}
          </button>
        </div>

        {items.length > 0 && (
          <div className="mt-5 border-t border-zinc-800 pt-3">
            <p className="text-xs text-zinc-400 mb-1">Já registrados</p>
            <ul className="space-y-2">
              {items.map((it) => (
                <li key={it.postId} className="text-xs text-zinc-500 flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="text-zinc-300">{channelLabel(it.channel)}</span> · <a href={it.link} target="_blank" rel="noreferrer noopener" title={it.link} className="text-fuchsia-400 hover:underline break-all">{shortLink(it.link)}</a>
                    <span className="block">{metricsLine(it)}{it.variantKey ? ` · teste ${it.variantKey}` : ''}</span>
                  </span>
                  <button className="shrink-0 text-zinc-400 hover:underline" onClick={() => complete(it)}>Completar</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
