/**
 * BspSettingsPanel — Track C F5 do PRD-BSP-01.
 *
 * Aba "Business Skills Pack" em Configurações. Compõe 3 cards:
 *  1. Status do gate + toggles por dimensão (pricing / rfp / local_marketing)
 *  2. Editor do quote_template (header/greeting/footer/conditions/signature)
 *  3. Preview de sugestão de preço (POST-ish via GET com querystring)
 *
 * Consome:
 *   GET  /api/bsp/access          — status de cada dimensão (soft launch + allowed)
 *   GET  /api/bsp/config          — config atual
 *   PATCH /api/bsp/config         — salva enabled_dimensions + quote_template
 *   PUT  /api/bsp/rfp/template    — reset ao default (body = null)
 *   GET  /api/bsp/pricing/suggest — preview de preço
 *
 * PT-BR em toda UI (RN-BSP-11).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Package, Save, Loader2, RotateCcw, Calculator, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from '@/src/lib/toast';
import { apiFetch } from '@/src/lib/api';

type Dimension = 'pricing' | 'rfp' | 'local_marketing';

const DIM_LABEL: Record<Dimension, string> = {
  pricing: 'Pricing 360',
  rfp: 'RFP (orçamentos)',
  local_marketing: 'Local Marketing',
};
const DIM_DESC: Record<Dimension, string> = {
  pricing: 'Sugestão de preço por vertical com adapter map.',
  rfp: 'Templates de orçamento + métricas por vendedor.',
  local_marketing: 'Cruzamento contatos ↔ concorrentes monitorados.',
};

interface QuoteTemplate {
  header?: string;
  greeting?: string;
  footer?: string;
  conditions?: string[];
  signature?: string;
}

interface AccessRow { allowed: boolean; code?: string }
interface AccessResp {
  soft_launch: boolean;
  pricing: AccessRow;
  rfp: AccessRow;
  local_marketing: AccessRow;
}

export function BspSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [access, setAccess] = useState<AccessResp | null>(null);
  const [enabled, setEnabled] = useState<Dimension[]>([]);
  const [template, setTemplate] = useState<QuoteTemplate>({});
  const [conditionsText, setConditionsText] = useState('');

  // Preview de preço
  const [cost, setCost] = useState('10');
  const [vertical, setVertical] = useState('retail');
  const [markup, setMarkup] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accResp, cfgResp, tplResp] = await Promise.all([
        apiFetch('/api/bsp/access'),
        apiFetch('/api/bsp/config'),
        apiFetch('/api/bsp/rfp/template'),
      ]);
      if (accResp.ok) setAccess(await accResp.json());
      if (cfgResp.ok) {
        const cfg = await cfgResp.json();
        const dims: Dimension[] = Array.isArray(cfg.enabled_dimensions)
          ? cfg.enabled_dimensions.filter((d: string): d is Dimension =>
              d === 'pricing' || d === 'rfp' || d === 'local_marketing')
          : ['pricing', 'rfp', 'local_marketing'];
        setEnabled(dims);
      }
      if (tplResp.ok) {
        const tpl = await tplResp.json();
        setTemplate(tpl || {});
        setConditionsText(Array.isArray(tpl?.conditions) ? tpl.conditions.join('\n') : '');
      }
    } catch (e: any) {
      toast.error(`Erro ao carregar config: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleDim = (d: Dimension) => {
    setEnabled(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
  };

  const save = async () => {
    setSaving(true);
    try {
      const conditions = conditionsText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const cleanedTpl: QuoteTemplate = {};
      if (template.header) cleanedTpl.header = template.header;
      if (template.greeting) cleanedTpl.greeting = template.greeting;
      if (template.footer) cleanedTpl.footer = template.footer;
      if (template.signature) cleanedTpl.signature = template.signature;
      if (conditions.length > 0) cleanedTpl.conditions = conditions;

      const r = await apiFetch('/api/bsp/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled_dimensions: enabled,
          quote_template: Object.keys(cleanedTpl).length > 0 ? cleanedTpl : null,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Configurações salvas.');
      await load();
    } catch (e: any) {
      toast.error(`Erro ao salvar: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const resetTemplate = async () => {
    setSaving(true);
    try {
      // PUT /rfp/template com body null volta ao default
      const r = await apiFetch('/api/bsp/rfp/template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Template resetado ao default.');
      await load();
    } catch (e: any) {
      toast.error(`Erro ao resetar: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const doPreview = async () => {
    setPreviewing(true); setPreview(null);
    try {
      const params = new URLSearchParams({ cost, vertical });
      if (markup) params.set('markup', markup);
      const r = await apiFetch(`/api/bsp/pricing/suggest?${params.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setPreview(j);
    } catch (e: any) {
      toast.error(`Erro no preview: ${e?.message || e}`);
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-zinc-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="mb-2 flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-zinc-100">
            <Package className="w-5 h-5" /> Business Skills Pack
          </h2>
          <p className="text-sm text-zinc-400 mt-1">
            Pricing 360 · RFP · Local Marketing — um bundle transversal para o negócio.
          </p>
        </div>
      </div>

      {/* ── Card 1: gate + toggles ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          {access?.soft_launch
            ? <ShieldCheck className="w-4 h-4 text-emerald-400" />
            : <ShieldOff className="w-4 h-4 text-amber-400" />}
          Dimensões habilitadas
        </h3>
        {access?.soft_launch && (
          <p className="text-xs text-emerald-300/80 mb-3">
            Modo soft launch ativo — todas as dimensões liberadas independente da configuração.
          </p>
        )}
        <div className="space-y-2">
          {(['pricing', 'rfp', 'local_marketing'] as Dimension[]).map(d => {
            const on = enabled.includes(d);
            const row = access ? (access as any)[d] as AccessRow : null;
            return (
              <label key={d} className="flex items-start gap-3 p-3 rounded-md hover:bg-zinc-800/40 cursor-pointer">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleDim(d)}
                  className="mt-1 accent-teal-500"
                />
                <div className="flex-1">
                  <div className="text-sm text-zinc-100 flex items-center gap-2">
                    {DIM_LABEL[d]}
                    {row && !row.allowed && !access?.soft_launch && (
                      <span className="text-xs text-amber-400">bloqueado ({row.code})</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">{DIM_DESC[d]}</div>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* ── Card 2: quote_template ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">Template de orçamento (RFP)</h3>
            <p className="text-xs text-zinc-500 mt-1">
              Aceita placeholders: <code className="text-teal-300">{'{{org_name}}'}</code>,{' '}
              <code className="text-teal-300">{'{{contact_name}}'}</code>,{' '}
              <code className="text-teal-300">{'{{contact_line}}'}</code>,{' '}
              <code className="text-teal-300">{'{{valid_until}}'}</code>,{' '}
              <code className="text-teal-300">{'{{total}}'}</code>,{' '}
              <code className="text-teal-300">{'{{item_count}}'}</code>.
            </p>
          </div>
          <button
            onClick={resetTemplate}
            disabled={saving}
            className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" /> Voltar ao default
          </button>
        </div>
        <div className="space-y-3">
          <TextField label="Cabeçalho" value={template.header || ''}
            onChange={v => setTemplate({ ...template, header: v })} />
          <TextField label="Saudação" value={template.greeting || ''}
            onChange={v => setTemplate({ ...template, greeting: v })} />
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Condições (uma por linha)</label>
            <textarea
              value={conditionsText}
              onChange={e => setConditionsText(e.target.value)}
              className="w-full min-h-[80px] px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 outline-none focus:border-teal-500/60"
              placeholder="Prazo de entrega: 5 dias úteis&#10;Pagamento: PIX ou boleto"
            />
          </div>
          <TextField label="Rodapé" value={template.footer || ''}
            onChange={v => setTemplate({ ...template, footer: v })} />
          <TextField label="Assinatura" value={template.signature || ''}
            onChange={v => setTemplate({ ...template, signature: v })} />
        </div>
      </section>

      {/* ── Card 3: preview de preço ── */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="text-sm font-semibold text-zinc-200 mb-3 flex items-center gap-2">
          <Calculator className="w-4 h-4" /> Preview de sugestão de preço
        </h3>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Custo (R$)</label>
            <input value={cost} onChange={e => setCost(e.target.value)}
              type="number" min="0" step="0.01"
              className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 outline-none focus:border-teal-500/60" />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Vertical</label>
            <select value={vertical} onChange={e => setVertical(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 outline-none focus:border-teal-500/60">
              <option value="retail">retail</option>
              <option value="loja_virtual">loja_virtual</option>
              <option value="beauty">beauty</option>
              <option value="clinic">clinic</option>
              <option value="comigo">comigo</option>
              <option value="falatu">falatu</option>
              <option value="advocacia">advocacia</option>
              <option value="default">(sem vertical)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Markup % (opcional)</label>
            <input value={markup} onChange={e => setMarkup(e.target.value)}
              type="number" min="0" step="1" placeholder="usa config"
              className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 outline-none focus:border-teal-500/60" />
          </div>
        </div>
        <button
          onClick={doPreview}
          disabled={previewing || !cost}
          className="text-sm bg-teal-500/10 border border-teal-500/40 text-teal-200 hover:bg-teal-500/20 px-3 py-1.5 rounded-md flex items-center gap-1.5 disabled:opacity-50"
        >
          {previewing && <Loader2 className="w-3 h-3 animate-spin" />}
          Calcular
        </button>
        {preview && (
          <div className="mt-4 space-y-1 text-sm">
            <div className="text-lg font-semibold text-teal-300">
              R$ {Number(preview.suggested_price).toFixed(2).replace('.', ',')}
            </div>
            <div className="text-xs text-zinc-400">
              adapter: <span className="text-zinc-200">{preview.adapter}</span> ·{' '}
              method: <span className="text-zinc-200">{preview.method}</span>
              {preview.markup_percent_used != null &&
                <> · markup: <span className="text-zinc-200">{preview.markup_percent_used}%</span></>}
              {preview.target_margin_used != null &&
                <> · target margin: <span className="text-zinc-200">{(preview.target_margin_used * 100).toFixed(0)}%</span></>}
            </div>
            <div className="text-xs text-zinc-500">{preview.reasoning}</div>
          </div>
        )}
      </section>

      {/* ── Save bar ── */}
      <div className="sticky bottom-0 bg-zinc-950 border-t border-zinc-800 pt-4 flex justify-end gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="text-sm bg-teal-500 hover:bg-teal-400 text-zinc-900 font-medium px-4 py-2 rounded-md flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar
        </button>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 outline-none focus:border-teal-500/60" />
    </div>
  );
}
