import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { brlPlain as brl, ddmm, situationLabel, sourceLabel, storeExplanation } from './monthCheckLabels';

// Conferência do MÊS (folha × caixa, dia a dia, por loja) — SOMENTE LEITURA.
// Mostra de onde vem a diferença entre o "total do mês" do app e a soma das folhas
// do gerente. O dono da rede (isNetwork) escolhe aqui se o total segue a folha ou o caixa.
export function MonthCheckCard({ isNetwork }: { isNetwork: boolean }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [openStore, setOpenStore] = useState<Record<string, boolean>>({});
  const [switching, setSwitching] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/retailops/closings/month-check?month=${month}`);
      setData(r.ok ? await r.json() : null);
      if (!r.ok) toast.error('Não foi possível carregar a conferência do mês.');
    } catch { setData(null); } finally { setLoading(false); }
  };
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, month]);

  const switchSource = async (next: 'folha' | 'system') => {
    if (!data || data.source === next) return;
    const msg = next === 'folha'
      ? 'O total do mês, a meta e a comissão passam a seguir só a FOLHA do gerente. Dia sem folha lançada fica fora do total (aparece aqui para conferir). Apurações já aprovadas não mudam. Confirmar?'
      : 'O total do mês, a meta e a comissão passam a seguir o CAIXA do PDV nos dias em que ele existe. Apurações já aprovadas não mudam. Confirmar?';
    if (!window.confirm(msg)) return;
    setSwitching(true);
    try {
      const r = await apiFetch('/api/retailops/official-sale-source', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: next }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Falha ao trocar a fonte do total.'); return; }
      toast.success(`O total do mês agora segue: ${sourceLabel(d.source)}.`);
      await load();
    } finally { setSwitching(false); }
  };

  return (
    <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-950/40">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
        <CalendarDays className="w-4 h-4 text-indigo-400" />
        <span className="text-sm font-medium text-zinc-100">Conferência do mês (folha × caixa)</span>
        <span className="text-[11px] text-zinc-500">de onde vem a diferença do total do mês</span>
        <ChevronDown className={`ml-auto w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-zinc-800 p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input type="month" value={month} onChange={e => setMonth(e.target.value.slice(0, 7))} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" />
            <button onClick={load} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3 h-3" /></button>
            {data && (
              <div className="ml-auto flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-zinc-500">O total do mês segue:</span>
                {isNetwork ? (['folha', 'system'] as const).map(k => (
                  <button key={k} disabled={switching} onClick={() => switchSource(k)} className={`rounded-lg border px-2 py-1 ${data.source === k ? 'border-indigo-500 bg-indigo-600/15 text-indigo-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'} disabled:opacity-50`}>{sourceLabel(k)}</button>
                )) : <strong className="text-zinc-200">{sourceLabel(data.source)}</strong>}
              </div>
            )}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
          ) : !data || data.stores.length === 0 ? (
            <p className="text-xs text-zinc-500">Nenhuma loja ativa para conferir.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-zinc-400">
                  <tr className="text-left">
                    <th className="px-2 py-1.5 font-medium">Loja</th>
                    <th className="px-2 py-1.5 font-medium text-right">Folha (gerente)</th>
                    <th className="px-2 py-1.5 font-medium text-right">Caixa (PDV)</th>
                    <th className="px-2 py-1.5 font-medium text-right">Total do mês no app</th>
                    <th className="px-2 py-1.5 font-medium text-right" title="Total do mês no app − soma das folhas">App − folha</th>
                    <th className="px-2 py-1.5 font-medium text-right">Dias a conferir</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stores.map((st: any) => {
                    const extra = Number(st.totals.countedMinusFolha) || 0;
                    return [
                      <tr key={st.storeId} className="border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-900/40" onClick={() => setOpenStore(p => ({ ...p, [st.storeId]: !p[st.storeId] }))}>
                        <td className="px-2 py-1.5 text-zinc-200 whitespace-nowrap">{openStore[st.storeId] ? '▾' : '▸'} {st.storeName}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-zinc-200">{brl(st.totals.folha)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{st.caixaAvailable ? brl(st.totals.caixa) : '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-medium text-zinc-100">{brl(st.totals.counted)}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${Math.abs(extra) > 0.009 ? 'text-amber-300' : 'text-zinc-500'}`}>{Math.abs(extra) > 0.009 ? `${extra > 0 ? '+' : ''}${brl(extra)}` : '—'}</td>
                        <td className={`px-2 py-1.5 text-right ${st.issues.length ? 'text-amber-300' : 'text-zinc-500'}`}>{st.issues.length || '—'}</td>
                      </tr>,
                      openStore[st.storeId] && (
                        <tr key={`${st.storeId}-d`} className="border-t border-zinc-800/30">
                          <td colSpan={6} className="px-2 py-2">
                            <p className="mb-2 text-[11px] text-zinc-400">{storeExplanation(st, data.source)}</p>
                            <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-zinc-400">
                              {st.weeks.map((w: any) => (
                                <span key={w.start} className="rounded border border-zinc-800 px-2 py-0.5">{ddmm(w.start)}→{ddmm(w.end)}: folha {brl(w.folha)} · app {brl(w.counted)}</span>
                              ))}
                            </div>
                            {st.issues.length === 0 ? (
                              <p className="text-[11px] text-zinc-500">Nenhum dia com diferença entre folha e caixa.</p>
                            ) : (
                              <table className="w-full text-[11px]">
                                <thead className="text-zinc-500"><tr className="text-left"><th className="px-1 py-0.5 font-medium">Dia</th><th className="px-1 py-0.5 font-medium text-right">Folha</th><th className="px-1 py-0.5 font-medium text-right">Caixa</th><th className="px-1 py-0.5 font-medium text-right">Folha − caixa</th><th className="px-1 py-0.5 font-medium text-right">No total do app</th><th className="px-1 py-0.5 font-medium">Situação</th></tr></thead>
                                <tbody>
                                  {st.issues.map((d: any) => (
                                    <tr key={d.date} className="border-t border-zinc-800/40">
                                      <td className="px-1 py-0.5 text-zinc-300">{ddmm(d.date)}</td>
                                      <td className="px-1 py-0.5 text-right font-mono text-zinc-200">{d.folha > 0 ? brl(d.folha) : '—'}</td>
                                      <td className="px-1 py-0.5 text-right font-mono text-zinc-400">{d.caixa > 0 ? brl(d.caixa) : '—'}</td>
                                      <td className="px-1 py-0.5 text-right font-mono text-amber-300">{d.folhaMinusCaixa != null ? brl(d.folhaMinusCaixa) : '—'}</td>
                                      <td className="px-1 py-0.5 text-right font-mono text-zinc-200">{brl(d.counted)}</td>
                                      <td className="px-1 py-0.5 text-amber-200">{situationLabel(d.situation)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                  <tr className="border-t border-zinc-700 font-medium">
                    <td className="px-2 py-1.5 text-zinc-300">{data.scoped ? 'Suas lojas' : 'Rede'}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-200">{brl(data.network.folha)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-400">{brl(data.network.caixa)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-100">{brl(data.network.counted)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-amber-300">{Math.abs(data.network.countedMinusFolha) > 0.009 ? brl(data.network.countedMinusFolha) : '—'}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-zinc-500">Clique na loja para ver as semanas e os dias em que a folha e o caixa não batem. "Total do mês no app" é o mesmo número da corrida, das metas e da comissão.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
