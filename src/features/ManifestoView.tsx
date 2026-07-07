import { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { Sparkles, Save, HelpCircle, Loader2 } from 'lucide-react';

// Manifesto da Marca — a "constituição" da marca (Golden Circle de Sinek +
// StorySelling). Editor guiado com opção de assistência da IA em cada campo.
//
// Filosofia visual: apresentar CADA campo com o "porque isso importa" logo
// abaixo do label, para o dono entender o valor de preencher — não é só
// mais um formulário de settings, é um exercício estratégico.

interface Manifesto {
  whyStatement: string;
  howPrinciples: string[];
  whatSummary: string;
  founderStory: string;
  transformationPromise: string;
  toneVoice: string;
}

const EMPTY: Manifesto = { whyStatement: '', howPrinciples: [], whatSummary: '', founderStory: '', transformationPromise: '', toneVoice: '' };

export function ManifestoView() {
  const [form, setForm] = useState<Manifesto>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assistBusy, setAssistBusy] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/manifesto').then((r) => r.json()).then((d) => {
      setForm({
        whyStatement: d.whyStatement || '',
        howPrinciples: Array.isArray(d.howPrinciples) ? d.howPrinciples : [],
        whatSummary: d.whatSummary || '',
        founderStory: d.founderStory || '',
        transformationPromise: d.transformationPromise || '',
        toneVoice: d.toneVoice || '',
      });
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/manifesto', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar.'); return; }
      toast.success('Manifesto salvo. A IA já vai usar essa constituição em todas as próximas respostas.');
    } catch { toast.error('Falha ao salvar.'); }
    finally { setSaving(false); }
  };

  const assist = async (section: 'why' | 'transformation' | 'story' | 'principles' | 'tone', currentDraft: string) => {
    setAssistBusy(section);
    try {
      const res = await apiFetch('/api/manifesto/assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, context: { businessType: '', currentDraft, answers: [] } }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'IA indisponível.'); return; }
      const sug = d.suggestion;
      if (section === 'principles') {
        const arr = Array.isArray(sug) ? sug : (typeof sug === 'string' ? sug.split(/\n+/).filter(Boolean) : []);
        setForm((f) => ({ ...f, howPrinciples: arr.slice(0, 6) }));
      } else if (section === 'why') setForm((f) => ({ ...f, whyStatement: String(sug) }));
      else if (section === 'transformation') setForm((f) => ({ ...f, transformationPromise: String(sug) }));
      else if (section === 'story') setForm((f) => ({ ...f, founderStory: String(sug) }));
      else if (section === 'tone') setForm((f) => ({ ...f, toneVoice: String(sug) }));
      if (d.notes) toast.success(`💡 ${d.notes}`);
    } catch { toast.error('Falha ao chamar a IA.'); }
    finally { setAssistBusy(null); }
  };

  const fieldClass = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-100 outline-none focus:border-zinc-600';

  const Section = ({ title, why, children, assistKey, currentDraft }: any) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{why}</p>
        </div>
        {assistKey && (
          <button onClick={() => assist(assistKey, currentDraft)} disabled={assistBusy === assistKey}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 disabled:opacity-50">
            {assistBusy === assistKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            IA me ajuda
          </button>
        )}
      </div>
      {children}
    </div>
  );

  if (loading) {
    return <div className="flex-1 flex items-center justify-center bg-zinc-950 text-zinc-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <div className="flex-1 overflow-auto bg-zinc-950">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="border-b border-zinc-800 pb-4 mb-2">
          <p className="zf-kicker mb-1">Tier 1 Filosófico</p>
          <h1 className="zf-page-title flex items-center gap-2">
            📜 Manifesto da Marca
          </h1>
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
            A constituição do seu negócio. Todos os seus canais de IA (atendimento, vendas, Diretor IA, Estúdio de Criação) usam este manifesto como <b>base filosófica</b> — cada mensagem se ancora aqui. Preencher com honestidade vale mais que preencher rápido.
          </p>
          <p className="text-xs text-zinc-500 mt-2 italic">
            "Empresas não vendem O QUE fazem, vendem POR QUÊ fazem." — Simon Sinek
          </p>
        </div>

        <Section title="🎯 Por Quê (Sinek)" why="A razão de existir da marca — não O QUE você vende, não COMO você vende. Uma frase que qualquer pessoa da equipe deveria conseguir repetir de memória. Fuja de chavões vazios (‘qualidade’, ‘excelência’). Vá para a raiz."
          assistKey="why" currentDraft={form.whyStatement}>
          <textarea className={fieldClass} rows={3} placeholder='Ex.: "Existimos para desafogar donos de negócio de tudo que não é o trabalho de verdade."'
            value={form.whyStatement} onChange={(e) => setForm({ ...form, whyStatement: e.target.value })} />
        </Section>

        <Section title="✨ Promessa de Transformação" why="O antes vs depois na vida do cliente. Deve ser concreto, mensurável, honesto. Sem isso, sua marca vira só mais um produto na prateleira."
          assistKey="transformation" currentDraft={form.transformationPromise}>
          <textarea className={fieldClass} rows={3} placeholder='Ex.: "Antes o dono trabalhava 14h/dia e sabia que perdia receita sem saber onde. Depois ele dorme com o negócio rodando e o painel mostra o que fazer amanhã."'
            value={form.transformationPromise} onChange={(e) => setForm({ ...form, transformationPromise: e.target.value })} />
        </Section>

        <Section title="📖 História Fundadora" why="A narrativa de origem — momento, conflito, virada, promessa. É a matéria-bruta que a IA usa em campanhas, ‘sobre nós’ e primeira mensagem a lead frio. Detalhes sensoriais (data, lugar, cena) fazem a história crível. NÃO invente — refine o que aconteceu."
          assistKey="story" currentDraft={form.founderStory}>
          <textarea className={fieldClass} rows={7} placeholder="Como começou? Qual dor você viveu que virou negócio? Qual foi o momento em que percebeu que valia a pena? O que te comprometeu a seguir?"
            value={form.founderStory} onChange={(e) => setForm({ ...form, founderStory: e.target.value })} />
        </Section>

        <Section title="⚖️ Princípios de Como Agimos" why="3 a 5 regras INEGOCIÁVEIS que orientam decisão. Não valores vagos — regras acionáveis. A IA usa como filtro (‘Celery Test’ de Sinek): esta ação reforça ou dilui algum princípio?"
          assistKey="principles" currentDraft={form.howPrinciples.join('\n')}>
          <textarea className={fieldClass} rows={5} placeholder="Um princípio por linha. Ex.:&#10;Nunca vender o que não usaríamos&#10;Responder em até 30 min mesmo aos sábados&#10;Falar a verdade dura quando o cliente pede opinião real"
            value={form.howPrinciples.join('\n')} onChange={(e) => setForm({ ...form, howPrinciples: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 6) })} />
        </Section>

        <Section title="📦 O Que Ofertamos" why="Uma frase resumindo o produto/serviço central. Fica no fim propositalmente — sem o Por Quê acima, o O Quê perde peso."
          assistKey={null} currentDraft={form.whatSummary}>
          <input type="text" className={fieldClass} placeholder='Ex.: "SO comercial com IA para donos de negócio no WhatsApp e Instagram."'
            value={form.whatSummary} onChange={(e) => setForm({ ...form, whatSummary: e.target.value })} />
        </Section>

        <Section title="🎨 Tom de Voz" why="Como a marca fala. Registro + palavras-âncora + palavras-veto. Todo canal (WhatsApp, loja, e-mail, Instagram) deve soar como a mesma pessoa. Consistência gera lealdade."
          assistKey="tone" currentDraft={form.toneVoice}>
          <textarea className={fieldClass} rows={4} placeholder={"Ex.: Registro próximo mas não íntimo.\nUsamos: 'a gente', 'olha só', 'combinado'.\nEvitamos: 'querido(a)', 'fofo(a)', gírias muito regionais."}
            value={form.toneVoice} onChange={(e) => setForm({ ...form, toneVoice: e.target.value })} />
        </Section>

        <div className="sticky bottom-4 flex justify-end pt-2">
          <button onClick={save} disabled={saving}
            className="zf-button zf-button-primary disabled:opacity-50 shadow-lg">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar Manifesto
          </button>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 text-xs text-zinc-400 flex gap-3">
          <HelpCircle className="w-4 h-4 shrink-0 mt-0.5 text-zinc-500" />
          <div>
            <p className="mb-1"><b className="text-zinc-300">Como isso afeta a IA?</b></p>
            <p className="leading-relaxed">Depois de salvar, TODAS as respostas da IA (atendimento, vendas, negociação, Diretor IA, geração de conteúdo) passam a se ancorar neste manifesto. Se alguma mensagem contradizer algum princípio, a IA é instruída a reformular antes de enviar. Você pode ajustar a qualquer momento — o efeito é imediato nas próximas conversas.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
