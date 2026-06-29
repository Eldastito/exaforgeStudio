import React, { useEffect, useRef, useState } from 'react';
import { Wand2, Sparkles, Palette, Image as ImageIcon, Upload, Download, Loader2, Film, Instagram } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type Brand = { palette: string[]; tone: string; style: string; summary: string };
type Creation = { id: string; kind?: string; status?: string; prompt: string; media_url: string; created_at: string };

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

export function StudioView() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [refs, setRefs] = useState<{ url: string; base64: string; mime: string }[]>([]);
  const [analyzing, setAnalyzing] = useState(false);

  const [briefing, setBriefing] = useState('');
  const [format, setFormat] = useState<'post' | 'story' | 'banner'>('post');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const [creations, setCreations] = useState<Creation[]>([]);
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

  const loadBrand = () => apiFetch('/api/studio/brand').then(r => r.json()).then(d => setBrand(d && Array.isArray(d.palette) ? d : null)).catch(() => {});
  const loadCreations = () => apiFetch('/api/studio/creations').then(r => r.json()).then((d) => setCreations(Array.isArray(d) ? d : [])).catch(() => {});
  // Só adota os limites quando vierem no formato esperado (evita crash se a rota
  // retornar um erro, ex.: módulo do Estúdio ainda não habilitado).
  const loadLimits = () => apiFetch('/api/studio/limits').then(r => r.json())
    .then(d => setLimits(d && d.images && d.videos ? d : null)).catch(() => {});
  const loadIg = () => apiFetch('/api/studio/instagram/status').then(r => r.json())
    .then(d => setIg(d && typeof d.connected === 'boolean' ? d : { connected: false })).catch(() => {});
  useEffect(() => { loadBrand(); loadCreations(); loadLimits(); loadIg(); }, []);

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

  const hasBrand = !!(brand && (brand.palette?.length || brand.style || brand.tone));

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <Wand2 className="w-6 h-6 text-fuchsia-400" /> Estúdio de Criação
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
              <a href={result} download className="mt-2 inline-flex items-center gap-1 text-xs text-fuchsia-400 hover:text-fuchsia-300">
                <Download className="w-3.5 h-3.5" /> Baixar
              </a>
            </div>
          )}
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
            {creations.map(c => {
              const isVideo = c.kind === 'video' || (c.media_url || '').endsWith('.mp4');
              if (c.status === 'processing' || !c.media_url) {
                return (
                  <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950 aspect-square flex flex-col items-center justify-center gap-1 text-[10px] text-zinc-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> gerando vídeo…
                  </div>
                );
              }
              return (
                <a key={c.id} href={c.media_url} target="_blank" rel="noreferrer" className="group block">
                  {isVideo
                    ? <video src={c.media_url} muted className="w-full aspect-square object-cover rounded-lg border border-zinc-800 group-hover:border-fuchsia-500/50 transition-colors" />
                    : <img src={c.media_url} alt={c.prompt} className="w-full aspect-square object-cover rounded-lg border border-zinc-800 group-hover:border-fuchsia-500/50 transition-colors" />}
                  <p className="mt-1 text-[10px] text-zinc-500 line-clamp-2">{c.prompt}</p>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
