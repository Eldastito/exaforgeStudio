import React, { useEffect, useRef, useState } from 'react';
import { Wand2, Sparkles, Palette, Image as ImageIcon, Upload, Download, Loader2, Film, Instagram, CalendarClock, Trash2, Layers, Plus, X } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useVisibleLimit, ShowMore } from '@/src/components/ShowMore';

type Brand = { palette: string[]; tone: string; style: string; summary: string };
type Creation = { id: string; kind?: string; status?: string; prompt: string; media_url: string; created_at: string };
type Objective = { id: string; label: string };
type Scheduled = { id: string; creation_id: string; objective: string; caption: string; scheduled_at: string; status: string; error?: string; media_url?: string; kind?: string };
type RecipeSummary = {
  id: string; key: string; version: number; name: string;
  description: string | null; intent: string | null;
  composition: any; constraints: any;
  supported_formats: string[]; vertical_hints: string[];
};
type RecipeAnalytics = {
  scope: 'org' | 'global';
  total_uses: number;
  by_recipe: Array<{ recipe_key: string; name: string | null; vertical_hints: string[]; uses: number; last_used: string }>;
  by_vertical: Array<{ vertical: string; uses: number }>;
};

const RECIPE_FORMAT_LABELS: Record<string, string> = {
  feed_1_1: 'Feed 1:1',
  story_9_16: 'Story 9:16',
  landscape_16_9: 'Paisagem 16:9',
  square_1_1: 'Quadrado 1:1',
  portrait_4_5: 'Retrato 4:5',
};

// Reduz a imagem no navegador (máx. 768px, JPEG) para enviar payload pequeno.
const fileToB64 = (file: File): Promise<{ base64: string; mime: string }> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 768;
      let { width, height } = img;
      if (width > max || height > max) { const r = Math.min(max / width, max / height); width = Math.round(width * r); height = Math.round(height * r); }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      resolve({ base64: dataUrl.split(',')[1] || '', mime: 'image/jpeg' });
    };
    img.onerror = reject;
    img.src = reader.result as string;
  };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const FORMATS: { id: 'post' | 'story' | 'banner'; label: string; hint: string }[] = [
  { id: 'post', label: 'Post (1:1)', hint: 'Feed quadrado' },
  { id: 'story', label: 'Story (9:16)', hint: 'Vertical' },
  { id: 'banner', label: 'Banner (16:9)', hint: 'Horizontal' },
];

// Valor mínimo (agora + 5 min) para o input datetime-local, no fuso do navegador.
const minLocalDateTime = () => {
  const d = new Date(Date.now() + 5 * 60000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmtWhen = (iso: string) => { try { return new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };
const SCHED_BADGE: Record<string, { label: string; cls: string }> = {
  scheduled: { label: 'Agendado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  published: { label: 'Publicado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  failed: { label: 'Falhou', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  canceled: { label: 'Cancelado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
};

export function StudioView() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [refs, setRefs] = useState<{ url: string; base64: string; mime: string }[]>([]);
  const [analyzing, setAnalyzing] = useState(false);

  const [briefing, setBriefing] = useState('');
  const [format, setFormat] = useState<'post' | 'story' | 'banner'>('post');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);

  // Publicar / agendar no Instagram
  const [pubId, setPubId] = useState<string | null>(null);
  const [pubPrompt, setPubPrompt] = useState('');
  const [pubCaption, setPubCaption] = useState('');
  const [pubBusy, setPubBusy] = useState(false);
  const [pubCapBusy, setPubCapBusy] = useState(false);
  const [postedIds, setPostedIds] = useState<Set<string>>(new Set());
  const [pubMode, setPubMode] = useState<'now' | 'schedule'>('now');
  const [pubObjective, setPubObjective] = useState('vendas');
  const [pubWhen, setPubWhen] = useState('');
  const [objectives, setObjectives] = useState<Objective[]>([]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);

  const [creations, setCreations] = useState<Creation[]>([]);
  const creationsPage = useVisibleLimit(creations);
  const [limits, setLimits] = useState<{ images: { used: number; limit: number }; videos: { used: number; limit: number } } | null>(null);
  const [ig, setIg] = useState<{ connected: boolean; username?: string }>({ connected: false });
  const [igAnalyzing, setIgAnalyzing] = useState(false);
  const [igPerf, setIgPerf] = useState('');

  // Vídeo (Veo) — fluxo assíncrono com polling.
  const [vBriefing, setVBriefing] = useState('');
  const [vFormat, setVFormat] = useState<'story' | 'banner'>('story');
  const [vStatus, setVStatus] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');
  const [vUrl, setVUrl] = useState<string | null>(null);
  const pollRef = useRef<any>(null);

  // Receitas visuais (ADR-194 F3) — catálogo + geração via /api/studio/recipes/generate.
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [selectedRecipeKey, setSelectedRecipeKey] = useState<string>('');
  const [recipeFormat, setRecipeFormat] = useState<string>('feed_1_1');
  const [recipeCtx, setRecipeCtx] = useState('');
  const [recipeBrandHint, setRecipeBrandHint] = useState('');
  const [recipeGenerating, setRecipeGenerating] = useState(false);
  const [recipeResult, setRecipeResult] = useState<{
    mediaUrl: string; id: string; prompt: string;
    recipe_key: string; recipe_version: number;
  } | null>(null);
  const [recipeAnalytics, setRecipeAnalytics] = useState<RecipeAnalytics | null>(null);
  // F3.5 — auto-sugestão de receita a partir de briefing livre.
  const [suggestBriefing, setSuggestBriefing] = useState('');
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [lastSuggestion, setLastSuggestion] = useState<{
    method: 'llm' | 'fallback_keyword';
    suggestion: { recipe_key: string; name: string; reasoning: string; confidence: number } | null;
    alternatives: Array<{ recipe_key: string; name: string; reasoning: string }>;
  } | null>(null);
  // F5 — Atalhos per-org (aliases customizados).
  const [orgAliases, setOrgAliases] = useState<Array<{ id: string; alias: string; recipe_key: string }>>([]);
  const [newAliasText, setNewAliasText] = useState('');
  const [newAliasKey, setNewAliasKey] = useState('');
  const [aliasBusy, setAliasBusy] = useState(false);
  const selectedRecipe = recipes.find(r => r.key === selectedRecipeKey) || null;

  const loadBrand = () => apiFetch('/api/studio/brand').then(r => r.json()).then(d => setBrand(d && Array.isArray(d.palette) ? d : null)).catch(() => {});
  const loadCreations = () => apiFetch('/api/studio/creations').then(r => r.json()).then((d) => setCreations(Array.isArray(d) ? d : [])).catch(() => {});
  // Só adota os limites quando vierem no formato esperado (evita crash se a rota
  // retornar um erro, ex.: módulo do Estúdio ainda não habilitado).
  const loadLimits = () => apiFetch('/api/studio/limits').then(r => r.json())
    .then(d => setLimits(d && d.images && d.videos ? d : null)).catch(() => {});
  const loadIg = () => apiFetch('/api/studio/instagram/status').then(r => r.json())
    .then(d => setIg(d && typeof d.connected === 'boolean' ? d : { connected: false })).catch(() => {});
  const loadObjectives = () => apiFetch('/api/studio/objectives').then(r => r.json())
    .then(d => setObjectives(Array.isArray(d) ? d : [])).catch(() => {});
  const loadScheduled = () => apiFetch('/api/studio/scheduled').then(r => r.json())
    .then(d => setScheduled(Array.isArray(d) ? d : [])).catch(() => {});
  const loadRecipes = () => apiFetch('/api/studio/recipes').then(r => r.json())
    .then(d => setRecipes(Array.isArray(d?.recipes) ? d.recipes : [])).catch(() => {});
  const loadRecipeAnalytics = () => apiFetch('/api/studio/recipes/analytics').then(r => r.json())
    .then(d => setRecipeAnalytics(d && typeof d.total_uses === 'number' ? d : null)).catch(() => {});
  const loadOrgAliases = () => apiFetch('/api/studio/recipes/aliases?scope=own').then(r => r.json())
    .then(d => setOrgAliases(Array.isArray(d?.aliases) ? d.aliases : [])).catch(() => {});
  useEffect(() => { loadBrand(); loadCreations(); loadLimits(); loadIg(); loadObjectives(); loadScheduled(); loadRecipes(); loadRecipeAnalytics(); loadOrgAliases(); }, []);

  // Auto-seleciona primeira receita disponível quando o catálogo chega.
  useEffect(() => {
    if (!selectedRecipeKey && recipes.length > 0) setSelectedRecipeKey(recipes[0].key);
  }, [recipes, selectedRecipeKey]);

  // Ao trocar de receita, ajusta o formato pra um suportado se o atual não estiver.
  useEffect(() => {
    if (!selectedRecipe) return;
    if (!selectedRecipe.supported_formats.includes(recipeFormat) && selectedRecipe.supported_formats[0]) {
      setRecipeFormat(selectedRecipe.supported_formats[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRecipeKey]);

  const analyzeInstagram = async () => {
    setIgAnalyzing(true);
    try {
      const res = await apiFetch('/api/studio/instagram/analyze', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Falha ao analisar o Instagram.');
      if (d.brand) setBrand(d.brand);
      setIgPerf(d.performance || '');
      toast.success('Identidade captada do seu Instagram! ✨');
    } catch (e: any) { toast.error(e.message); } finally { setIgAnalyzing(false); }
  };

  const onPickRefs = async (files: FileList | null) => {
    if (!files) return;
    const list = Array.from(files).slice(0, 5);
    try {
      const converted = await Promise.all(list.map(async f => {
        const { base64, mime } = await fileToB64(f);
        return { url: URL.createObjectURL(f), base64, mime };
      }));
      setRefs(converted);
    } catch { toast.error('Não foi possível ler as imagens.'); }
  };

  const analyzeBrand = async () => {
    if (!refs.length) { toast.error('Selecione de 1 a 5 posts de referência.'); return; }
    setAnalyzing(true);
    try {
      const res = await apiFetch('/api/studio/brand/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: refs.map(r => ({ base64: r.base64, mime: r.mime })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao analisar.');
      setBrand(data);
      toast.success('Identidade da marca capturada! ✨');
    } catch (e: any) { toast.error(e.message); } finally { setAnalyzing(false); }
  };

  const generate = async () => {
    if (!briefing.trim()) { toast.error('Descreva o que você quer criar.'); return; }
    setGenerating(true); setResult(null);
    try {
      const res = await apiFetch('/api/studio/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: briefing, format }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar.');
      setResult(data.mediaUrl);
      setResultId(data.id || null);
      loadCreations();
      loadLimits();
      toast.success('Arte criada! 🎨');
    } catch (e: any) { toast.error(e.message); } finally { setGenerating(false); }
  };

  // Acompanha o job de vídeo até ficar pronto (ou falhar).
  const pollVideo = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/studio/video/${jobId}`);
        const d = await res.json();
        if (d.status === 'done') { clearInterval(pollRef.current); setVStatus('done'); setVUrl(d.mediaUrl); loadCreations(); loadLimits(); toast.success('Vídeo pronto! 🎬'); }
        else if (d.status === 'error') { clearInterval(pollRef.current); setVStatus('error'); toast.error(d.error || 'Falha na geração do vídeo.'); }
      } catch { /* tenta de novo no próximo tick */ }
    }, 8000);
  };
  const startVideo = async () => {
    if (!vBriefing.trim()) { toast.error('Descreva o vídeo que você quer criar.'); return; }
    setVStatus('processing'); setVUrl(null);
    try {
      const res = await apiFetch('/api/studio/video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: vBriefing, format: vFormat }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao iniciar o vídeo.');
      toast.success('Geração iniciada — o vídeo leva alguns minutos. ⏳');
      pollVideo(data.jobId);
    } catch (e: any) { setVStatus('error'); toast.error(e.message); }
  };
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const suggestRecipe = async () => {
    if (!suggestBriefing.trim()) { toast.error('Descreva o que você quer criar.'); return; }
    setSuggestBusy(true);
    try {
      const body: any = { briefing: suggestBriefing.trim() };
      if (recipeFormat) body.format = recipeFormat;
      const res = await apiFetch('/api/studio/recipes/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao sugerir receita.');
      setLastSuggestion(data);
      if (data.suggestion?.recipe_key) {
        setSelectedRecipeKey(data.suggestion.recipe_key);
      }
      toast.success(`Sugestão: ${data.suggestion?.name || data.suggestion?.recipe_key || 'nenhuma'} ✨`);
    } catch (e: any) { toast.error(e.message); } finally { setSuggestBusy(false); }
  };

  const addOrgAlias = async () => {
    const alias = newAliasText.trim();
    const key = newAliasKey || selectedRecipeKey;
    if (!alias) { toast.error('Digite o texto do atalho.'); return; }
    if (!key) { toast.error('Escolha uma receita.'); return; }
    setAliasBusy(true);
    try {
      const res = await apiFetch('/api/studio/recipes/aliases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias, recipe_key: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao criar atalho.');
      setNewAliasText('');
      setNewAliasKey('');
      loadOrgAliases();
      toast.success(`Atalho "${alias}" criado 🔗`);
    } catch (e: any) { toast.error(e.message); } finally { setAliasBusy(false); }
  };

  const removeOrgAlias = async (id: string, alias: string) => {
    try {
      const res = await apiFetch(`/api/studio/recipes/aliases/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Falha ao remover atalho.');
      }
      loadOrgAliases();
      toast.success(`Atalho "${alias}" removido.`);
    } catch (e: any) { toast.error(e.message); }
  };

  const applyAlternative = (key: string) => {
    setSelectedRecipeKey(key);
    toast.success(`Trocado para: ${recipes.find(r => r.key === key)?.name || key}`);
  };

  const generateFromRecipe = async () => {
    if (!selectedRecipeKey) { toast.error('Escolha uma receita.'); return; }
    setRecipeGenerating(true); setRecipeResult(null);
    try {
      const inputs: Record<string, string> = {};
      if (recipeCtx.trim()) inputs.description = recipeCtx.trim();
      const body: any = { recipe: selectedRecipeKey, format: recipeFormat, inputs };
      if (recipeBrandHint.trim()) body.brand_hint = recipeBrandHint.trim();
      const res = await apiFetch('/api/studio/recipes/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar com receita.');
      setRecipeResult(data);
      loadCreations();
      loadLimits();
      loadRecipeAnalytics();
      toast.success(`Arte criada com ${data.recipe_key}! 🎨`);
    } catch (e: any) { toast.error(e.message); } finally { setRecipeGenerating(false); }
  };

  const openPublish = (id: string, prompt: string) => {
    setPubId(id); setPubPrompt(prompt || ''); setPubCaption(prompt || '');
    setPubMode('now'); setPubObjective('vendas'); setPubWhen('');
  };
  const suggestCaption = async () => {
    setPubCapBusy(true);
    try {
      const r = await apiFetch('/api/studio/instagram/caption', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: pubPrompt, objective: pubObjective }) });
      const d = await r.json();
      if (d.caption) setPubCaption(d.caption);
    } catch { } finally { setPubCapBusy(false); }
  };
  const doPublish = async () => {
    if (!pubId) return;
    setPubBusy(true);
    try {
      const r = await apiFetch('/api/studio/instagram/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creationId: pubId, caption: pubCaption }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao publicar.');
      setPostedIds(p => new Set(p).add(pubId));
      toast.success('Publicado no Instagram! 🚀');
      setPubId(null);
    } catch (e: any) { toast.error(e.message); } finally { setPubBusy(false); }
  };
  const doSchedule = async () => {
    if (!pubId) return;
    if (!pubWhen) { toast.error('Escolha a data e a hora.'); return; }
    const iso = new Date(pubWhen).toISOString();
    if (new Date(iso).getTime() < Date.now()) { toast.error('Escolha uma data/hora no futuro.'); return; }
    setPubBusy(true);
    try {
      const r = await apiFetch('/api/studio/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creationId: pubId, objective: pubObjective, caption: pubCaption, scheduledAt: iso }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao agendar.');
      toast.success('Post agendado! 📅');
      setPubId(null);
      loadScheduled();
    } catch (e: any) { toast.error(e.message); } finally { setPubBusy(false); }
  };
  const cancelScheduled = async (id: string) => {
    try {
      const r = await apiFetch(`/api/studio/scheduled/${id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Falha ao cancelar.');
      toast.success('Agendamento cancelado.');
      loadScheduled();
    } catch (e: any) { toast.error(e.message); }
  };

  const hasBrand = !!(brand && (brand.palette?.length || brand.style || brand.tone));

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-6">
        <p className="zf-kicker mb-1">Artes com a Marca</p>
        <h2 className="zf-page-title flex items-center gap-2">
          <Wand2 className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Estúdio de Criação
        </h2>
        <p className="text-zinc-400 text-sm mt-1">A IA cria artes de campanha com a cara da sua marca.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Identidade da marca */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2 mb-1"><Palette className="w-4 h-4 text-fuchsia-400" /> Identidade da marca</h3>
          <p className="text-xs text-zinc-500 mb-3">A IA capta as cores, o estilo e o tom — do seu Instagram ou de posts de referência.</p>

          {ig.connected && (
            <>
              <button onClick={analyzeInstagram} disabled={igAnalyzing}
                className="flex items-center justify-center gap-2 w-full rounded-lg bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-700 hover:to-pink-700 text-white py-2.5 text-sm font-medium transition-colors disabled:opacity-60">
                {igAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Instagram className="w-4 h-4" />}
                {igAnalyzing ? 'Analisando seu feed…' : `Analisar meu Instagram${ig.username ? ` (@${ig.username})` : ''}`}
              </button>
              <div className="text-center text-[10px] text-zinc-600 my-2">ou suba posts manualmente</div>
            </>
          )}

          <label className="flex items-center justify-center gap-2 w-full cursor-pointer rounded-lg border border-dashed border-zinc-700 bg-zinc-950 py-4 text-sm text-zinc-400 hover:border-fuchsia-500/50 hover:text-zinc-200 transition-colors">
            <Upload className="w-4 h-4" /> Selecionar posts (até 5)
            <input type="file" accept="image/*" multiple className="hidden" onChange={e => onPickRefs(e.target.files)} />
          </label>

          {refs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {refs.map((r, i) => (
                <img key={i} src={r.url} alt="ref" className="w-16 h-16 object-cover rounded-lg border border-zinc-800" />
              ))}
            </div>
          )}

          <Button onClick={analyzeBrand} disabled={analyzing || !refs.length} className="mt-3 bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
            {analyzing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {analyzing ? 'Analisando…' : 'Analisar identidade'}
          </Button>

          {hasBrand && (
            <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
              {brand!.palette?.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-zinc-500">Paleta:</span>
                  {brand!.palette.map((c, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-[10px] text-zinc-300">
                      <span className="w-4 h-4 rounded border border-zinc-700" style={{ background: c }} /> {c}
                    </span>
                  ))}
                </div>
              )}
              {brand!.style && <p className="text-xs text-zinc-400"><span className="text-zinc-500">Estilo:</span> {brand!.style}</p>}
              {brand!.tone && <p className="text-xs text-zinc-400"><span className="text-zinc-500">Tom:</span> {brand!.tone}</p>}
              {brand!.summary && <p className="text-xs text-zinc-500 italic">{brand!.summary}</p>}
            </div>
          )}

          {igPerf && (
            <div className="mt-3 rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3 text-xs text-fuchsia-200">
              <span className="font-medium">O que mais performa no seu Instagram:</span> {igPerf}
            </div>
          )}
        </div>

        {/* Gerar arte */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><ImageIcon className="w-4 h-4 text-fuchsia-400" /> Gerar arte</h3>
            {limits?.images && (
              <span className="text-[11px] text-zinc-500">Imagens este mês: <span className="text-zinc-300 font-medium">{limits.images.used}/{limits.images.limit}</span></span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mb-3">{hasBrand ? 'Usando a identidade da sua marca.' : 'Dica: analise sua identidade ao lado para artes com a cara da marca.'}</p>

          <div className="flex flex-wrap gap-2 mb-3">
            {FORMATS.map(f => (
              <button key={f.id} type="button" onClick={() => setFormat(f.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${format === f.id ? 'bg-fuchsia-600 border-fuchsia-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                title={f.hint}>{f.label}</button>
            ))}
          </div>

          <textarea value={briefing} onChange={e => setBriefing(e.target.value)}
            placeholder="Ex.: Anúncio de campanha de vacinação para pets, com um cachorro feliz, tom acolhedor e CTA 'Agende agora'."
            className="w-full h-24 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 resize-none focus:border-fuchsia-500 outline-none" />

          <Button onClick={generate} disabled={generating || !briefing.trim()} className="mt-3 bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
            {generating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
            {generating ? 'Criando…' : 'Gerar arte'}
          </Button>

          {result && (
            <div className="mt-4">
              <img src={result} alt="arte gerada" className="w-full max-w-sm rounded-lg border border-zinc-800" />
              <div className="mt-2 flex items-center gap-3">
                <a href={result} download className="inline-flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300">
                  <Download className="w-3.5 h-3.5" /> Baixar
                </a>
                {ig.connected && resultId && (
                  <button onClick={() => openPublish(resultId, briefing)} className="inline-flex items-center gap-1 text-xs text-pink-400 hover:text-pink-300">
                    <Instagram className="w-3.5 h-3.5" /> Publicar no Instagram
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Gerar com receita visual (ADR-194 F3) */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-fuchsia-400" /> Gerar com receita visual
          </h3>
          {limits?.images && (
            <span className="text-[11px] text-zinc-500">Imagens este mês: <span className="text-zinc-300 font-medium">{limits.images.used}/{limits.images.limit}</span></span>
          )}
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          Receitas prontas com composição, iluminação e restrições curadas — como slash-commands
          (/ProductExplosion, /3Dbillboard etc.). Consomem o mesmo limite mensal do Estúdio.
        </p>

        {recipes.length === 0 ? (
          <p className="text-xs text-zinc-500">Nenhuma receita disponível.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Coluna esquerda: seleção + inputs */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-400 mb-1 block">Receita</label>
                <select value={selectedRecipeKey} onChange={e => setSelectedRecipeKey(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-fuchsia-500 outline-none">
                  {recipes.map(r => (
                    <option key={r.key} value={r.key}>{r.name} — v{r.version}</option>
                  ))}
                </select>
              </div>

              {/* Sugestão automática (F3.5) */}
              <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3 space-y-2">
                <label className="text-[11px] text-fuchsia-300 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3" /> Não sabe qual escolher? Descreva sua ideia
                </label>
                <div className="flex gap-2">
                  <input
                    type="text" value={suggestBriefing}
                    onChange={e => setSuggestBriefing(e.target.value)}
                    placeholder="Ex.: outdoor 3D pra lançamento de tênis"
                    className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-fuchsia-500 outline-none"
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); suggestRecipe(); } }}
                  />
                  <button
                    type="button" onClick={suggestRecipe}
                    disabled={suggestBusy || !suggestBriefing.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white px-3 py-2 text-xs font-medium disabled:opacity-60">
                    {suggestBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    Sugerir
                  </button>
                </div>
                {lastSuggestion?.suggestion && (
                  <div className="text-[10px] text-zinc-400 space-y-1">
                    <p>
                      <span className="text-fuchsia-300 font-medium">{lastSuggestion.suggestion.name}</span>
                      <span className="text-zinc-600 mx-1">·</span>
                      <span>{Math.round((lastSuggestion.suggestion.confidence || 0) * 100)}% ({lastSuggestion.method === 'llm' ? 'IA' : 'palavra-chave'})</span>
                    </p>
                    {lastSuggestion.suggestion.reasoning && (
                      <p className="text-zinc-500 italic line-clamp-2">{lastSuggestion.suggestion.reasoning}</p>
                    )}
                    {lastSuggestion.alternatives.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        <span className="text-zinc-500">Outras:</span>
                        {lastSuggestion.alternatives.map(a => (
                          <button
                            key={a.recipe_key} type="button"
                            onClick={() => applyAlternative(a.recipe_key)}
                            title={a.reasoning}
                            className="text-fuchsia-300 hover:text-fuchsia-200 underline underline-offset-2"
                          >
                            {a.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {selectedRecipe && (
                <>
                  <div>
                    <label className="text-xs text-zinc-400 mb-1 block">Formato</label>
                    <div className="flex flex-wrap gap-2">
                      {selectedRecipe.supported_formats.map(f => (
                        <button key={f} type="button" onClick={() => setRecipeFormat(f)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${recipeFormat === f ? 'bg-fuchsia-600 border-fuchsia-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
                          {RECIPE_FORMAT_LABELS[f] || f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400 mb-1 block">Contexto (produto, cenário, mensagem)</label>
                    <textarea value={recipeCtx} onChange={e => setRecipeCtx(e.target.value)}
                      placeholder="Ex.: Tênis esportivo azul cobalto, foco na sola de amortecimento, campanha inverno."
                      className="w-full h-20 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 resize-none focus:border-fuchsia-500 outline-none" />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-400 mb-1 block">Dica de marca (opcional)</label>
                    <input type="text" value={recipeBrandHint} onChange={e => setRecipeBrandHint(e.target.value)}
                      placeholder={brand?.summary || 'Ex.: paleta azul cobalto + branco, tom esportivo e confiável'}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-fuchsia-500 outline-none" />
                  </div>

                  <Button onClick={generateFromRecipe} disabled={recipeGenerating || !selectedRecipeKey}
                    className="bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
                    {recipeGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
                    {recipeGenerating ? 'Gerando…' : 'Gerar com receita'}
                  </Button>
                </>
              )}
            </div>

            {/* Coluna direita: detalhes do recipe + preview do resultado */}
            <div className="space-y-3">
              {selectedRecipe && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
                  {selectedRecipe.description && <p className="text-xs text-zinc-300">{selectedRecipe.description}</p>}
                  {selectedRecipe.intent && (
                    <p className="text-[11px] text-zinc-500"><span className="text-zinc-400">Intenção:</span> {selectedRecipe.intent}</p>
                  )}
                  {selectedRecipe.vertical_hints?.length > 0 && (
                    <div className="flex flex-wrap gap-1 items-center">
                      <span className="text-[11px] text-zinc-500">Ideal para:</span>
                      {selectedRecipe.vertical_hints.map(v => (
                        <span key={v} className="text-[10px] px-1.5 py-0.5 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300">{v}</span>
                      ))}
                    </div>
                  )}
                  {selectedRecipe.constraints && Object.keys(selectedRecipe.constraints).length > 0 && (
                    <div className="pt-1 border-t border-zinc-800/70">
                      <p className="text-[11px] text-zinc-500 mb-1">Restrições:</p>
                      <ul className="text-[10px] text-zinc-400 space-y-0.5">
                        {selectedRecipe.constraints.preserve_product_identity && <li>• Preserva identidade do produto</li>}
                        {selectedRecipe.constraints.allow_text_on_image === false && <li>• Sem texto sobre a imagem</li>}
                        {selectedRecipe.constraints.allow_text_on_image === true && <li>• Aceita texto sobre a imagem</li>}
                        {typeof selectedRecipe.constraints.max_people_in_scene === 'number' && (
                          <li>• Até {selectedRecipe.constraints.max_people_in_scene} pessoa(s) na cena</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {recipeResult && (
                <div>
                  <img src={recipeResult.mediaUrl} alt="arte gerada" className="w-full max-w-sm rounded-lg border border-zinc-800" />
                  <p className="mt-1 text-[10px] text-zinc-500">{recipeResult.recipe_key} · v{recipeResult.recipe_version}</p>
                  <div className="mt-2 flex items-center gap-3">
                    <a href={recipeResult.mediaUrl} download className="inline-flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300">
                      <Download className="w-3.5 h-3.5" /> Baixar
                    </a>
                    {ig.connected && (
                      <button onClick={() => openPublish(recipeResult.id, recipeResult.prompt)} className="inline-flex items-center gap-1 text-xs text-pink-400 hover:text-pink-300">
                        <Instagram className="w-3.5 h-3.5" /> Publicar no Instagram
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Insights (F4) — só aparece com uso registrado. */}
        {recipeAnalytics && recipeAnalytics.total_uses > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-800/70">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] text-zinc-500">Suas receitas mais usadas</span>
              <span className="text-[10px] text-zinc-500">{recipeAnalytics.total_uses} geração(ões)</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {recipeAnalytics.by_recipe.slice(0, 3).map(r => (
                <span key={r.recipe_key} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px]">
                  <span className="text-zinc-200 font-medium">{r.name || r.recipe_key}</span>
                  <span className="text-zinc-500">·</span>
                  <span className="text-fuchsia-300">{r.uses}×</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Atalhos per-org (F5) */}
        <div className="mt-4 pt-3 border-t border-zinc-800/70">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-[11px] text-zinc-500">Meus atalhos</span>
            <span className="text-[10px] text-zinc-500">{orgAliases.length} atalho(s)</span>
          </div>
          {orgAliases.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {orgAliases.map(a => (
                <span key={a.id} className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px]">
                  <span className="text-zinc-200 font-medium">{a.alias}</span>
                  <span className="text-zinc-600">→</span>
                  <span className="text-fuchsia-300">{a.recipe_key}</span>
                  <button
                    type="button"
                    onClick={() => removeOrgAlias(a.id, a.alias)}
                    title="Remover atalho"
                    className="ml-0.5 text-zinc-500 hover:text-red-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              type="text" value={newAliasText}
              onChange={e => setNewAliasText(e.target.value)}
              placeholder="ex.: meu-3d"
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-1.5 text-[11px] text-zinc-100 focus:border-fuchsia-500 outline-none"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOrgAlias(); } }}
            />
            <select
              value={newAliasKey} onChange={e => setNewAliasKey(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg p-1.5 text-[11px] text-zinc-300 focus:border-fuchsia-500 outline-none"
            >
              <option value="">— receita —</option>
              {recipes.map(r => (
                <option key={r.key} value={r.key}>{r.key}</option>
              ))}
            </select>
            <button
              type="button" onClick={addOrgAlias}
              disabled={aliasBusy || !newAliasText.trim() || (!newAliasKey && !selectedRecipeKey)}
              className="inline-flex items-center gap-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-60"
            >
              {aliasBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Adicionar
            </button>
          </div>
          <p className="mt-1 text-[10px] text-zinc-600">Vazio na receita → usa a que está selecionada acima. Atalho da org tem prioridade sobre os globais.</p>
        </div>
      </div>

      {/* Gerar vídeo (Veo) */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Film className="w-4 h-4 text-fuchsia-400" /> Gerar vídeo</h3>
          {limits?.videos && <span className="text-[11px] text-zinc-500">Vídeos este mês: <span className="text-zinc-300 font-medium">{limits.videos.used}/{limits.videos.limit}</span></span>}
        </div>
        <p className="text-xs text-zinc-500 mb-3">Vídeo curto de campanha (leva alguns minutos). {hasBrand ? 'Usando a identidade da marca.' : ''}</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {[{ id: 'story', label: 'Story 9:16' }, { id: 'banner', label: 'Paisagem 16:9' }].map(f => (
            <button key={f.id} type="button" onClick={() => setVFormat(f.id as any)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${vFormat === f.id ? 'bg-fuchsia-600 border-fuchsia-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>{f.label}</button>
          ))}
        </div>
        <textarea value={vBriefing} onChange={e => setVBriefing(e.target.value)}
          placeholder="Ex.: Vídeo curto de banho & tosa com um pet feliz e a marca ao final."
          className="w-full h-24 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 resize-none focus:border-fuchsia-500 outline-none" />
        <Button onClick={startVideo} disabled={vStatus === 'processing' || !vBriefing.trim()} className="mt-3 bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
          {vStatus === 'processing' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Film className="w-4 h-4 mr-2" />}
          {vStatus === 'processing' ? 'Gerando vídeo…' : 'Gerar vídeo'}
        </Button>
        {vStatus === 'processing' && <p className="mt-2 text-xs text-zinc-500">Pode levar alguns minutos — deixe esta aba aberta que avisamos quando ficar pronto.</p>}
        {vUrl && vStatus === 'done' && (
          <div className="mt-4">
            <video src={vUrl} controls className="w-full max-w-sm rounded-lg border border-zinc-800" />
            <a href={vUrl} download className="mt-2 inline-flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300"><Download className="w-3.5 h-3.5" /> Baixar</a>
          </div>
        )}
      </div>

      {/* Galeria */}
      {creations.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Minhas criações</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {creationsPage.visible.map(c => {
              const isVideo = c.kind === 'video' || (c.media_url || '').endsWith('.mp4');
              if (c.status === 'processing' || !c.media_url) {
                return (
                  <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950 aspect-square flex flex-col items-center justify-center gap-1 text-[10px] text-zinc-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> gerando vídeo…
                  </div>
                );
              }
              return (
                <div key={c.id} className="group block">
                  <a href={c.media_url} target="_blank" rel="noreferrer">
                    {isVideo
                      ? <video src={c.media_url} muted className="w-full aspect-square object-cover rounded-lg border border-zinc-800 group-hover:border-fuchsia-500/50 transition-colors" />
                      : <img src={c.media_url} alt={c.prompt} className="w-full aspect-square object-cover rounded-lg border border-zinc-800 group-hover:border-fuchsia-500/50 transition-colors" />}
                  </a>
                  <p className="mt-1 text-[10px] text-zinc-500 line-clamp-2">{c.prompt}</p>
                  {ig.connected && (
                    postedIds.has(c.id)
                      ? <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-emerald-400"><Instagram className="w-3 h-3" /> publicado</span>
                      : <button onClick={() => openPublish(c.id, c.prompt)} className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-pink-400 hover:text-pink-300"><Instagram className="w-3 h-3" /> Publicar no IG</button>
                  )}
                </div>
              );
            })}
            <ShowMore page={creationsPage} noun="criações" className="col-span-full" />
          </div>
        </div>
      )}

      {/* Agenda de posts */}
      {scheduled.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2"><CalendarClock className="w-4 h-4 text-fuchsia-400" /> Agenda de posts</h3>
          <div className="space-y-2">
            {scheduled.map(s => {
              const badge = SCHED_BADGE[s.status] || SCHED_BADGE.scheduled;
              const objLabel = objectives.find(o => o.id === s.objective)?.label || s.objective;
              const isVideo = s.kind === 'video' || (s.media_url || '').endsWith('.mp4');
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
                  {s.media_url ? (
                    isVideo
                      ? <video src={s.media_url} muted className="w-12 h-12 object-cover rounded-md border border-zinc-800 shrink-0" />
                      : <img src={s.media_url} alt="" className="w-12 h-12 object-cover rounded-md border border-zinc-800 shrink-0" />
                  ) : <div className="w-12 h-12 rounded-md bg-zinc-800 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.cls}`}>{badge.label}</span>
                      <span className="text-[11px] text-zinc-400">{objLabel}</span>
                      <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" /> {fmtWhen(s.scheduled_at)}</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 line-clamp-1 mt-0.5">{s.caption || '—'}</p>
                    {s.status === 'failed' && s.error && <p className="text-[10px] text-red-400 line-clamp-1">{s.error}</p>}
                  </div>
                  {s.status === 'scheduled' && (
                    <button onClick={() => cancelScheduled(s.id)} title="Cancelar agendamento"
                      className="shrink-0 text-zinc-500 hover:text-red-400 p-1"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modal: publicar / agendar no Instagram */}
      {pubId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6">
            <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-3"><Instagram className="w-5 h-5 text-pink-400" /> Publicar no Instagram</h3>

            {/* Quando publicar */}
            <div className="flex gap-2 mb-3">
              {([['now', 'Publicar agora'], ['schedule', 'Agendar']] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setPubMode(id)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${pubMode === id ? 'bg-fuchsia-600 border-fuchsia-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>{label}</button>
              ))}
            </div>

            {/* Objetivo da campanha */}
            <label className="text-xs text-zinc-400 mb-1 block">Objetivo da campanha</label>
            <select value={pubObjective} onChange={e => setPubObjective(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-fuchsia-500 outline-none mb-3">
              {objectives.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>

            {/* Data/hora (apenas ao agendar) */}
            {pubMode === 'schedule' && (
              <>
                <label className="text-xs text-zinc-400 mb-1 block">Data e hora</label>
                <input type="datetime-local" value={pubWhen} min={minLocalDateTime()} onChange={e => setPubWhen(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-fuchsia-500 outline-none mb-3 [color-scheme:dark]" />
              </>
            )}

            <label className="text-xs text-zinc-400 mb-1 flex items-center justify-between">
              <span>Legenda</span>
              <button onClick={suggestCaption} disabled={pubCapBusy} className="text-[11px] text-fuchsia-400 hover:text-fuchsia-300 inline-flex items-center gap-1">
                {pubCapBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Gerar com IA
              </button>
            </label>
            <textarea value={pubCaption} onChange={e => setPubCaption(e.target.value)}
              className="w-full h-28 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 resize-none focus:border-pink-500 outline-none"
              placeholder="Escreva a legenda do post (ou gere com IA)…" />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPubId(null)} disabled={pubBusy}>Cancelar</Button>
              {pubMode === 'now' ? (
                <Button onClick={doPublish} disabled={pubBusy} className="bg-pink-600 hover:bg-pink-700 text-white">
                  {pubBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Instagram className="w-4 h-4 mr-2" />}
                  {pubBusy ? 'Publicando…' : 'Publicar'}
                </Button>
              ) : (
                <Button onClick={doSchedule} disabled={pubBusy} className="bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
                  {pubBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CalendarClock className="w-4 h-4 mr-2" />}
                  {pubBusy ? 'Agendando…' : 'Agendar'}
                </Button>
              )}
            </div>
            <p className="mt-2 text-[10px] text-zinc-600">Requer a permissão de publicação aprovada pela Meta (App Review).</p>
          </div>
        </div>
      )}
    </div>
  );
}
