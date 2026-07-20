import React, { useEffect, useMemo, useState } from 'react';
import { Radar, Search, Loader2, MapPin, Building2, Phone, Mail, Users2, Download, AlertCircle, ArrowUpDown } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';

// Sugestões fixas de CNAE (prefixo) — PRD T05.
const CNAE_SUGGESTIONS = [
  { p: '56', label: '56 — Alimentação' },
  { p: '47', label: '47 — Comércio varejista' },
  { p: '620', label: '620 — TI / software' },
  { p: '86', label: '86 — Saúde' },
  { p: '85', label: '85 — Educação' },
  { p: '68', label: '68 — Imobiliárias' },
  { p: '41', label: '41 — Construção' },
];
const PORTES = [{ v: '01', label: 'ME' }, { v: '03', label: 'EPP' }, { v: '05', label: 'Demais' }];
const brl = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function RadarB2BView() {
  const { setViewMode } = useStore();
  const [status, setStatus] = useState<{ instalado: boolean; totalEmpresas: number; totalCeps: number; dataBase: string | null } | null>(null);
  const [address, setAddress] = useState('');
  const [radiusKm, setRadiusKm] = useState(2);
  const [cnaePrefix, setCnaePrefix] = useState('');
  const [porte, setPorte] = useState<string[]>([]);
  const [comTelefone, setComTelefone] = useState(true);
  const [capitalMin, setCapitalMin] = useState('');

  const [loading, setLoading] = useState(false);
  const [ponto, setPonto] = useState<any>(null);
  const [resumo, setResumo] = useState<any>(null);
  const [empresas, setEmpresas] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'dist' | 'capital'>('dist');
  const [importing, setImporting] = useState(false);

  useEffect(() => { apiFetch('/api/radar-b2b/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ instalado: false } as any)); }, []);

  const togglePorte = (v: string) => setPorte(p => p.includes(v) ? p.filter(x => x !== v) : [...p, v]);

  const search = async () => {
    if (!address.trim()) { toast.error('Informe um endereço ou CEP.'); return; }
    setLoading(true); setSelected(new Set());
    try {
      const isCep = /^\d{5}-?\d{3}$/.test(address.trim());
      const body: any = { radiusKm, cnaePrefix: cnaePrefix || undefined, porte: porte.length ? porte : undefined, comTelefone, capitalMin: capitalMin ? Number(capitalMin) : undefined };
      if (isCep) body.cep = address.replace(/\D/g, ''); else body.address = address.trim();
      const r = await apiFetch('/api/radar-b2b/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Falha na busca.'); return; }
      setPonto(d.ponto); setResumo(d.resumo); setEmpresas(d.empresas || []);
      if (!d.empresas?.length) toast.error('Nenhuma empresa encontrada com esses filtros.');
    } catch { toast.error('Falha na busca.'); }
    finally { setLoading(false); }
  };

  const sorted = useMemo(() => {
    const arr = [...empresas];
    arr.sort((a, b) => sortBy === 'dist' ? (a.distanciaKm ?? 1e9) - (b.distanciaKm ?? 1e9) : (b.capitalSocial || 0) - (a.capitalSocial || 0));
    return arr;
  }, [empresas, sortBy]);

  const toggleSel = (cnpj: string) => setSelected(s => { const n = new Set(s); n.has(cnpj) ? n.delete(cnpj) : n.add(cnpj); return n; });
  const toggleAll = () => setSelected(s => s.size === sorted.length ? new Set() : new Set(sorted.map(e => e.cnpj)));

  const doImport = async () => {
    if (!selected.size) return;
    setImporting(true);
    try {
      const r = await apiFetch('/api/radar-b2b/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cnpjs: Array.from(selected) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Falha ao importar.'); return; }
      toast.success(`Importado: ${d.created} empresa(s) para Prospecção${d.skipped ? ` (${d.skipped} já existiam)` : ''}.`);
      setSelected(new Set());
    } catch { toast.error('Falha ao importar.'); }
    finally { setImporting(false); }
  };

  // Estado: base não instalada.
  if (status && !status.instalado) {
    return (
      <div className="flex-1 overflow-auto p-6 bg-zinc-950">
        <h2 className="zf-page-title flex items-center gap-2 mb-4"><Radar className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Radar B2B</h2>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 max-w-2xl">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-100/90">
              <p className="font-semibold mb-1">Base do Radar B2B não instalada.</p>
              <p className="text-amber-200/80">Rode o ETL uma vez para gerar <code>data/radar_rio.db</code> a partir da base pública da Receita Federal. Passo a passo em <code>tools/radar_etl/README.md</code>:</p>
              <ol className="list-decimal list-inside mt-2 space-y-1 text-amber-200/70">
                <li>Baixar os ZIPs da RFB (Empresas/Estabelecimentos/Sócios/Cnaes/Municipios).</li>
                <li><code>python build_radar_rio.py --downloads ./downloads --base-month AAAA-MM</code></li>
                <li>Geolocalização: <code>python build_cep_geo.py --cnefe ./downloads/cnefe_rj</code></li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-4">
        <p className="zf-kicker mb-1">Prospecção com base pública (RFB)</p>
        <h2 className="zf-page-title flex items-center gap-2"><Radar className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Radar B2B</h2>
        <p className="text-zinc-400 text-sm mt-1">Empresas reais do Rio num raio a partir de um endereço/CEP. {status && <span className="text-zinc-500">{status.totalEmpresas.toLocaleString('pt-BR')} empresas · base {status.dataBase || '—'}</span>}</p>
      </div>

      {/* Formulário */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 mb-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs text-zinc-400">Endereço ou CEP</label>
            <input value={address} onChange={e => setAddress(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Ex.: Av. das Américas 4200, Barra da Tijuca ou 22640-102"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100" />
          </div>
          <div>
            <label className="text-xs text-zinc-400">Raio: <span className="text-zinc-200 font-medium">{radiusKm} km</span></label>
            <input type="range" min={0.5} max={10} step={0.5} value={radiusKm} onChange={e => setRadiusKm(Number(e.target.value))} className="mt-3 w-full accent-indigo-500" />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-zinc-400">Segmento (CNAE)</label>
            <input value={cnaePrefix} onChange={e => setCnaePrefix(e.target.value.replace(/\D/g, ''))} list="cnae-sug" placeholder="Prefixo, ex.: 56"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100" />
            <datalist id="cnae-sug">{CNAE_SUGGESTIONS.map(c => <option key={c.p} value={c.p}>{c.label}</option>)}</datalist>
            <div className="flex flex-wrap gap-1 mt-1">{CNAE_SUGGESTIONS.slice(0, 4).map(c => <button key={c.p} onClick={() => setCnaePrefix(c.p)} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">{c.label}</button>)}</div>
          </div>
          <div>
            <label className="text-xs text-zinc-400">Porte</label>
            <div className="flex gap-3 mt-2">{PORTES.map(p => (
              <label key={p.v} className="flex items-center gap-1.5 text-sm text-zinc-300"><input type="checkbox" checked={porte.includes(p.v)} onChange={() => togglePorte(p.v)} className="accent-indigo-500" /> {p.label}</label>
            ))}</div>
          </div>
          <div>
            <label className="text-xs text-zinc-400">Capital mínimo (R$)</label>
            <input value={capitalMin} onChange={e => setCapitalMin(e.target.value.replace(/\D/g, ''))} placeholder="opcional"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100" />
            <label className="flex items-center gap-1.5 text-sm text-zinc-300 mt-2"><input type="checkbox" checked={comTelefone} onChange={e => setComTelefone(e.target.checked)} className="accent-indigo-500" /> Somente com telefone</label>
          </div>
        </div>

        <Button onClick={search} disabled={loading} className="zf-button zf-button-primary">
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />} Buscar empresas
        </Button>
      </div>

      {ponto && (
        <p className="text-xs text-zinc-500 mb-3 flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Centro: {ponto.display}</p>
      )}

      {/* Cards de resumo */}
      {resumo && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <SummaryCard icon={<Building2 className="w-4 h-4" />} label="Empresas" value={resumo.total} />
          <SummaryCard icon={<Phone className="w-4 h-4" />} label="Com telefone" value={resumo.comTelefone} />
          <SummaryCard icon={<Mail className="w-4 h-4" />} label="Com e-mail" value={resumo.comEmail} />
          <SummaryCard icon={<Users2 className="w-4 h-4" />} label="Por porte" value={`ME ${resumo.porPorte.ME} · EPP ${resumo.porPorte.EPP} · D ${resumo.porPorte.Demais}`} small />
        </div>
      )}
      {resumo?.topCnaes?.length > 0 && (
        <div className="mb-4 text-xs text-zinc-400">Top segmentos: {resumo.topCnaes.map((c: any) => `${c.descricao || c.cnae} (${c.count})`).join(' · ')}</div>
      )}

      {/* Tabela + importar */}
      {sorted.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <button onClick={() => setSortBy(sortBy === 'dist' ? 'capital' : 'dist')} className="inline-flex items-center gap-1 hover:text-zinc-200"><ArrowUpDown className="w-3.5 h-3.5" /> Ordenar por {sortBy === 'dist' ? 'distância' : 'capital'}</button>
              <span>· {selected.size} selecionada(s)</span>
            </div>
            <Button onClick={doImport} disabled={!selected.size || importing} className="zf-button zf-button-primary">
              {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />} Importar selecionadas para Prospecção
            </Button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-950/60 text-left text-xs text-zinc-500">
                  <th className="p-2"><input type="checkbox" checked={selected.size === sorted.length && sorted.length > 0} onChange={toggleAll} className="accent-indigo-500" /></th>
                  <th className="p-2">Razão social</th><th className="p-2">Segmento</th><th className="p-2">Porte</th>
                  <th className="p-2 text-right">Capital</th><th className="p-2">Bairro</th><th className="p-2 text-right">Dist.</th>
                  <th className="p-2">Telefone</th><th className="p-2">E-mail</th><th className="p-2">Sócio(s)</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(e => (
                  <tr key={e.cnpj} className={`border-t border-zinc-800/60 ${selected.has(e.cnpj) ? 'bg-indigo-500/5' : ''}`}>
                    <td className="p-2"><input type="checkbox" checked={selected.has(e.cnpj)} onChange={() => toggleSel(e.cnpj)} className="accent-indigo-500" /></td>
                    <td className="p-2 text-zinc-100">{e.razaoSocial}{e.nomeFantasia && <span className="block text-[11px] text-zinc-500">{e.nomeFantasia}</span>}</td>
                    <td className="p-2 text-zinc-300 text-xs">{e.cnaeDescricao || e.cnae}</td>
                    <td className="p-2 text-zinc-300">{e.porteLabel}</td>
                    <td className="p-2 text-right text-zinc-300">{brl(e.capitalSocial)}</td>
                    <td className="p-2 text-zinc-300">{e.bairro || '—'}</td>
                    <td className="p-2 text-right text-zinc-300">{e.distanciaKm != null ? `${e.distanciaKm} km` : '—'}</td>
                    <td className="p-2 text-zinc-300">{e.telefone1 || '—'}</td>
                    <td className="p-2 text-zinc-300 text-xs">{e.email || '—'}</td>
                    <td className="p-2 text-zinc-400 text-xs">{e.socios?.map((s: any) => s.nome).slice(0, 2).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">Depois de importar, acompanhe o score e as hipóteses em <button onClick={() => setViewMode('prospect')} className="text-indigo-400 hover:underline">Prospect AI</button>.</p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, small }: { icon: React.ReactNode; label: string; value: any; small?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center gap-1.5 text-zinc-400 text-xs">{icon} {label}</div>
      <p className={`mt-1 font-bold text-emerald-400 ${small ? 'text-sm' : 'text-2xl'}`}>{value}</p>
    </div>
  );
}
