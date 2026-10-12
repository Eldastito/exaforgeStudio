import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';

// Motor de Crescimento (ADR-207 F11): UMA tela com o ciclo Radar → Criar → Aprovar → Programados → Resultados → Aprendizados.
// Só COMPÕE o que o sistema já produz (nenhum motor novo). Abrir não escreve nada; aprovar/publicar chamam as rotas governadas de sempre.
// O primeiro acesso (ativação) é guiado por perguntas simples — não é um chat de IA: cada resposta grava no cadastro existente.

type Tab = 'radar' | 'criar' | 'aprovar' | 'programados' | 'resultados' | 'aprendizados';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'radar', label: 'Radar' }, { id: 'criar', label: 'Criar' }, { id: 'aprovar', label: 'Aprovar' },
  { id: 'programados', label: 'Programados' }, { id: 'resultados', label: 'Resultados' }, { id: 'aprendizados', label: 'Aprendizados' },
];
const brl = (v: number | null | undefined) => (v == null ? '—' : `R$ ${Number(v).toFixed(2)}`);
const unavailable = (s: any) => s && s.available === false;


// Conteúdo → WhatsApp / e-mail (ADR-207 F13a). Só PREPARA: WhatsApp vira RASCUNHO em Campanhas (você revisa e dispara lá); e-mail vira
// texto pronto para copiar. Público = só quem tem consentimento de comunicação registrado e não pediu para sair.
const SEGMENTS: Array<{ id: string; label: string; segment: any }> = [
  { id: 'all', label: 'Todos com consentimento', segment: {} },
  { id: 'inactive', label: 'Clientes que sumiram há 60 dias', segment: { inactiveDays: 60 } },
  { id: 'top', label: 'Melhores clientes (top 50)', segment: { topBuyers: 50 } },
];
function BroadcastActions({ entryId }: { entryId: string }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [seg, setSeg] = useState('all');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const call = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await apiFetch('/api/social/content-broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId, channel, segment: SEGMENTS.find((x) => x.id === seg)!.segment, dryRun }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Não foi possível preparar.'); return; }
      setRes(d);
      if (d.created) toast.success('Rascunho criado em Campanhas.');
    } finally { setBusy(false); }
  };
  if (!open) return <button className="text-fuchsia-300 text-xs hover:underline" onClick={() => setOpen(true)}>Usar em WhatsApp / e-mail</button>;
  return (
    <div className="mt-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 space-y-2 text-xs">
      <div className="flex flex-wrap gap-2 items-center">
        <select className="rounded bg-zinc-950 border border-zinc-800 px-2 py-1" value={channel} onChange={(e) => { setChannel(e.target.value as any); setRes(null); }}><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></select>
        <select className="rounded bg-zinc-950 border border-zinc-800 px-2 py-1" value={seg} onChange={(e) => { setSeg(e.target.value); setRes(null); }}>{SEGMENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <button className="px-2 py-1 rounded bg-zinc-700 text-white disabled:opacity-50" disabled={busy} onClick={() => call(channel === 'whatsapp')}>Ver prévia</button>
        <button className="text-zinc-500" onClick={() => { setOpen(false); setRes(null); }}>Fechar</button>
      </div>
      {res && (
        <div className="space-y-1.5">
          {res.channel === 'email' ? (
            <>
              <p><b>Assunto:</b> {res.subject}</p>
              <pre className="whitespace-pre-wrap text-zinc-300">{res.text}</pre>
              <button className="text-fuchsia-300" onClick={() => { navigator.clipboard?.writeText(`${res.subject}\n\n${res.text}`); toast.success('Copiado.'); }}>Copiar texto</button>
            </>
          ) : (
            <>
              <pre className="whitespace-pre-wrap text-zinc-300">{res.message}</pre>
              {!res.created && !res.existingCampaignId && res.audience?.included > 0 && <button className="px-2 py-1 rounded bg-fuchsia-600 text-white disabled:opacity-50" disabled={busy} onClick={() => call(false)}>Criar rascunho em Campanhas ({res.audience.included} contatos)</button>}
              {res.existingCampaignId && <p className="text-amber-300">Já existe um rascunho/envio em andamento para este conteúdo (em Campanhas).</p>}
              {res.created && <p className="text-emerald-300">Rascunho criado com {res.audience.included} contatos. Revise e dispare em Campanhas — nada foi enviado.</p>}
            </>
          )}
          <p className="text-zinc-400">Público: {res.audience.included} contato(s) com consentimento{res.audience.withoutConsent > 0 ? ` · ${res.audience.withoutConsent} de fora por falta de consentimento` : ''}.</p>
          {(res.caveats || []).map((c: string, i: number) => <p key={i} className="text-amber-300">{c}</p>)}
        </div>
      )}
    </div>
  );
}

export default function GrowthEnginePanel({ onUseBriefing }: { onUseBriefing: (text: string) => void }) {
  const setViewMode = useStore((s: any) => s.setViewMode);
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('radar');
  const [err, setErr] = useState(false);
  const [objectives, setObjectives] = useState<any[]>([]);
  const [brand, setBrand] = useState({ persona: '', voice: '', positioning: '' });
  const [objId, setObjId] = useState('');
  const [when, setWhen] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const r = await apiFetch('/api/social/growth-engine');
      if (!r.ok) { setErr(true); return; }
      const d = await r.json();
      setData(d); setErr(false);
      setOpen((o) => (o === null ? !d.activation.ready : o));
    } catch { setErr(true); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (data && !data.activation.ready && objectives.length === 0) {
      apiFetch('/api/studio/campaign-objectives').then((r) => r.json()).then((d) => setObjectives(d.objectives || [])).catch(() => {});
    }
  }, [data]);

  const post = async (url: string, body?: any, okMsg = 'Feito.') => {
    const r = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(d.error || 'Não foi possível concluir.'); return false; }
    toast.success(okMsg); load(); return true;
  };
  const saveBrand = async () => {
    const patch: any = {};
    for (const k of ['persona', 'voice', 'positioning'] as const) if (brand[k].trim()) patch[k] = brand[k].trim();
    if (!Object.keys(patch).length) { toast.error('Responda ao menos uma pergunta.'); return; }
    const r = await apiFetch('/api/studio/brand-dna', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(d.error || 'Não foi possível salvar.'); return; }
    toast.success('Identidade salva.'); setBrand({ persona: '', voice: '', positioning: '' }); load();
  };

  if (err) return null;                    // sem acesso (não é dono/administrador) ou falha: o Estúdio segue como sempre
  if (!data) return null;
  const a = data.activation;
  const inp = 'w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-xs text-zinc-100';
  const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-zinc-500">{children}</p>;
  const Off = ({ s }: { s: any }) => <p className="text-sm text-zinc-500">Esta parte não está disponível agora ({s.reason}).</p>;

  return (
    <div className="rounded-xl border border-fuchsia-500/30 bg-zinc-900/60 p-4 mb-6">
      <button type="button" className="w-full flex items-center justify-between gap-3 text-left" onClick={() => setOpen(!open)}>
        <div>
          <p className="text-sm font-semibold text-zinc-100">Motor de Crescimento</p>
          <p className="text-xs text-zinc-400">{data.headline}</p>
        </div>
        <span className="text-xs text-fuchsia-300">{open ? 'Fechar' : 'Abrir'}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {!a.ready && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-3">
              <p className="text-sm text-zinc-200">{a.message} Vamos por partes:</p>
              <ul className="space-y-1.5">
                {a.steps.map((s: any) => (
                  <li key={s.key} className="text-xs flex gap-2"><span>{s.done ? '✅' : s.required ? '⬜' : '▫️'}</span><span><b className="text-zinc-200">{s.label}</b> <span className="text-zinc-400">— {s.detail}</span></span></li>
                ))}
              </ul>
              {a.next && ['channel', 'store'].includes(a.next.key) && (
                <button className="text-xs px-3 py-1.5 rounded-lg bg-fuchsia-600 text-white" onClick={() => setViewMode(a.next.where)}>{a.next.key === 'channel' ? 'Ir conectar um canal' : 'Ir para a loja virtual'}</button>
              )}
              {a.next?.key === 'brand' && (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-300">Responda o que souber (pode deixar em branco):</p>
                  <input className={inp} placeholder="Quem é o seu cliente? (ex.: mulheres de 30 a 45 anos que trabalham fora)" value={brand.persona} onChange={(e) => setBrand({ ...brand, persona: e.target.value })} />
                  <input className={inp} placeholder="Como a marca fala? (ex.: elegante e próxima, sem gírias)" value={brand.voice} onChange={(e) => setBrand({ ...brand, voice: e.target.value })} />
                  <input className={inp} placeholder="O que a diferencia? (ex.: alfaiataria acessível)" value={brand.positioning} onChange={(e) => setBrand({ ...brand, positioning: e.target.value })} />
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-fuchsia-600 text-white" onClick={saveBrand}>Salvar identidade</button>
                </div>
              )}
              {a.next?.key === 'objective' && (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-300">O que você quer que as campanhas gerem?</p>
                  <select className={inp} value={objId} onChange={(e) => setObjId(e.target.value)}>
                    <option value="">Escolha…</option>
                    {objectives.map((o) => <option key={o.id} value={o.id}>{o.label}{o.hasBusinessMetric ? '' : ' (sem meta de negócio direta)'}</option>)}
                  </select>
                  <button className="text-xs px-3 py-1.5 rounded-lg bg-fuchsia-600 text-white disabled:opacity-50" disabled={!objId} onClick={() => post('/api/studio/campaign-contracts', { objectiveId: objId }, 'Objetivo definido.')}>Definir objetivo</button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${tab === t.id ? 'bg-fuchsia-600 border-fuchsia-500 text-white' : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>{t.label}</button>
            ))}
          </div>

          <div className="space-y-2 text-sm text-zinc-200">
            {tab === 'radar' && (unavailable(data.radar) ? <Off s={data.radar} /> : (
              <>
                {data.radar.whatToPost.length === 0 ? <Empty>Nenhuma ideia agora. O Radar só sugere o que tem base (assunto do nicho, produto em estoque de boa margem parado).</Empty> : (
                  <ul className="space-y-1.5">{data.radar.whatToPost.map((w: any) => <li key={`${w.kind}:${w.ref}`}><b>{w.label}</b> <span className="text-zinc-400">— {w.reason}</span></li>)}</ul>
                )}
                {(data.radar.stockAlerts || []).map((a: any, i: number) => (
                  <p key={i} className={`text-xs ${a.state === 'out' ? 'text-red-300' : 'text-amber-300'}`}>{a.state === 'out' ? '⛔' : '⚠️'} {a.product || 'Produto'}: {a.state === 'out' ? 'esgotado' : `restam ${a.units}`} e ainda em campanha. {a.note}</p>
                ))}
                {data.radar.commentsToAnswer > 0 && <p className="text-xs text-amber-300">{data.radar.commentsToAnswer} comentário{data.radar.commentsToAnswer > 1 ? 's' : ''} no Instagram com interesse de compra (veja em Loja virtual → Comentários do Instagram).</p>}
              </>
            ))}

            {tab === 'criar' && (unavailable(data.create) ? <Off s={data.create} /> : data.create.briefs.length === 0 ? <Empty>Sem briefing pronto. Quando houver uma oportunidade de conteúdo, o texto para o Estúdio aparece aqui.</Empty> : (
              <ul className="space-y-2">{data.create.briefs.map((b: any) => (
                <li key={b.signalId} className="rounded-lg border border-zinc-800 p-2 text-xs">
                  <p className="text-zinc-300">{b.briefingText}</p>
                  <button className="mt-1 text-fuchsia-300 hover:underline" onClick={() => { onUseBriefing(b.briefingText); toast.success('Briefing no Estúdio — gere a arte abaixo.'); }}>Usar no Estúdio</button>
                </li>
              ))}</ul>
            ))}

            {tab === 'aprovar' && (unavailable(data.approve) ? <Off s={data.approve} /> : (
              <>
                {data.approve.pending.length + data.approve.approvedToPublish.length + data.approve.drafts.length === 0 && <Empty>Nada esperando você.</Empty>}
                {data.approve.pending.map((p: any) => (
                  <div key={p.actionId} className="flex items-center justify-between gap-2 text-xs rounded-lg border border-zinc-800 p-2">
                    <span>{p.title}{p.channel ? ` · ${p.channel}` : ''}</span>
                    <span className="flex gap-2"><button className="text-emerald-300" onClick={() => post(`/api/actions/${p.actionId}/approve`, {}, 'Aprovado.')}>Aprovar</button><button className="text-zinc-400" onClick={() => post(`/api/actions/${p.actionId}/reject`, {}, 'Recusado.')}>Recusar</button></span>
                  </div>
                ))}
                {data.approve.approvedToPublish.map((p: any) => (
                  <div key={p.actionId} className="flex items-center justify-between gap-2 text-xs rounded-lg border border-emerald-900/50 p-2">
                    <span>{p.title}{p.channel ? ` · ${p.channel}` : ''} <span className="text-emerald-300">— aprovado</span></span>
                    <button className="text-fuchsia-300" onClick={() => post(`/api/social/publish/${p.actionId}/execute`, {}, 'Publicação enviada.')}>Publicar agora</button>
                  </div>
                ))}
                {data.approve.drafts.map((d: any) => (
                  <div key={d.id} className="text-xs rounded-lg border border-zinc-800 p-2 space-y-1">
                    <p>Rascunho{d.channel ? ` · ${d.channel}` : ''}: <span className="text-zinc-300">{d.caption || '(sem legenda)'}</span></p>
                    <div className="flex flex-wrap items-center gap-2">
                      <input type="datetime-local" className="rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs" value={when[d.id] || ''} onChange={(e) => setWhen({ ...when, [d.id]: e.target.value })} />
                      <button className="text-emerald-300 disabled:opacity-40" disabled={!when[d.id]} onClick={() => post(`/api/social/studio/calendar/${d.id}/approve`, { scheduledAt: new Date(when[d.id]).toISOString() }, 'Agendado.')}>Agendar</button>
                      <button className="text-zinc-400" onClick={async () => { const r = await apiFetch(`/api/social/studio/calendar/${d.id}`, { method: 'DELETE' }); if (r.ok) { toast.success('Cancelado.'); load(); } }}>Cancelar</button>
                    </div>
                    <BroadcastActions entryId={d.id} />
                  </div>
                ))}
              </>
            ))}

            {tab === 'programados' && (unavailable(data.scheduled) ? <Off s={data.scheduled} /> : data.scheduled.entries.length === 0 ? <Empty>Nada programado.</Empty> : (
              <ul className="space-y-1">{data.scheduled.entries.map((e: any) => <li key={e.id} className="text-xs">{e.scheduledAt ? new Date(e.scheduledAt).toLocaleString('pt-BR') : 'sem data'} · {e.channel || 'canal'} — <span className="text-zinc-300">{e.caption || '(sem legenda)'}</span><BroadcastActions entryId={e.id} /></li>)}</ul>
            ))}

            {tab === 'resultados' && (unavailable(data.results) ? <Off s={data.results} /> : (
              <>
                {data.results.campaigns.length === 0 && data.results.measured.length === 0 && data.results.media.length === 0 && <Empty>Ainda sem resultado medido. Aqui aparece o que virou venda, não só curtida.</Empty>}
                {data.results.campaigns.length > 0 && (
                  <div><p className="text-xs text-zinc-400 mb-1">Campanhas na loja (30 dias, pedidos pagos)</p>
                    <ul className="text-xs space-y-0.5">{data.results.campaigns.map((c: any) => <li key={`${c.source}|${c.campaign}`}>{c.campaign}: {c.paidOrders} pedido(s) pagos · {brl(c.revenuePaid)} · margem {brl(c.marginPaid)}</li>)}</ul></div>
                )}
                {data.results.media.length > 0 && (
                  <div><p className="text-xs text-zinc-400 mb-1">Mídia paga (gasto que você lançou)</p>
                    <ul className="text-xs space-y-0.5">{data.results.media.map((m: any) => <li key={m.campaign}>{m.campaign}: gasto {brl(m.spend)} · ROAS {m.roas ?? '—'} · lucro {brl(m.profit)} · POAS {m.poas ?? '—'}</li>)}</ul></div>
                )}
                {data.results.measured.length > 0 && (
                  <div><p className="text-xs text-zinc-400 mb-1">Publicações medidas (engajamento — não é venda)</p>
                    <ul className="text-xs space-y-0.5">{data.results.measured.map((m: any) => <li key={m.actionId}>{m.channel || 'canal'} {m.variantKey ? `· ${m.variantKey}` : ''}: {m.engagement} interações</li>)}</ul></div>
                )}
                {data.results.goals.length > 0 && (
                  <div><p className="text-xs text-zinc-400 mb-1">Metas de crescimento</p>
                    <ul className="text-xs space-y-0.5">{data.results.goals.map((g: any) => <li key={g.metric}>{g.label}: {g.current} de {g.target} ({g.attainmentPct}%)</li>)}</ul></div>
                )}
              </>
            ))}

            {tab === 'aprendizados' && (unavailable(data.learnings) ? <Off s={data.learnings} /> : data.learnings.learning.length === 0 && data.learnings.champions.length === 0 ? <Empty>Ainda não há o que aprender: o sistema só aprende com publicação que teve resultado comprovado.</Empty> : (
              <>
                {data.learnings.champions.length > 0 && <ul className="text-xs space-y-0.5">{data.learnings.champions.map((c: any) => <li key={c.experimentId}>Campeã: <b>{c.winnerVariantKey}</b> — {c.hypothesis}</li>)}</ul>}
                {data.learnings.learning.length > 0 && <ul className="text-xs space-y-0.5">{data.learnings.learning.map((l: any) => <li key={l.patternType}>{l.patternType}: eficácia {l.effectiveness == null ? '—' : Math.round(l.effectiveness * 100) + '%'} em {l.acted} publicação(ões)</li>)}</ul>}
              </>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">{data.note}</p>
        </div>
      )}
    </div>
  );
}
