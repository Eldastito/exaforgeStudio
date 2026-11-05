import type { TeamPerson } from './sellerPickRules';

// P4 — o vendedor do fechamento é ESCOLHIDO (equipe da loja; outras lojas para cobertura). Digitar fica como "Outro"
// e é avisado: nome fora da lista vira outra pessoa na comissão/metas. Sem lista carregada, cai no campo de texto.
export function SellerPick({ team, others, name, matricula, onChange, className = '' }: {
  team: TeamPerson[] | null; others: TeamPerson[]; name: string; matricula?: string | null;
  onChange: (name: string, matricula: string | null) => void; className?: string;
}) {
  if (team === null) {
    return <input value={name} onChange={e => onChange(e.target.value, null)} placeholder="Nome do vendedor" className={className} />;
  }
  const all = [...team, ...others];
  const known = matricula ? all.find(p => p.matricula === matricula) : null;
  const value = matricula ? `m:${matricula}` : (name ? '__other' : '');
  return (
    <div className="min-w-0 flex-1">
      <select value={value} className={`${className} w-full`} onChange={e => {
        const v = e.target.value;
        if (v === '__other') return onChange(name, null);
        if (!v) return onChange('', null);
        const p = all.find(x => `m:${x.matricula}` === v);
        if (p) onChange(p.name, p.matricula);
      }}>
        <option value="">Escolha o vendedor…</option>
        {matricula && !known && <option value={`m:${matricula}`}>{name || matricula}</option>}
        {team.length > 0 && <optgroup label="Equipe da loja">{team.map(p => <option key={p.sellerId} value={`m:${p.matricula}`}>{p.name}</option>)}</optgroup>}
        {others.length > 0 && <optgroup label="Outras lojas (cobertura)">{others.map(p => <option key={p.sellerId} value={`m:${p.matricula}`}>{p.name}{p.stores.length ? ` · ${p.stores.join(', ')}` : ''}</option>)}</optgroup>}
        <option value="__other">Outro (digitar o nome)</option>
      </select>
      {value === '__other' && (
        <>
          <input value={name} onChange={e => onChange(e.target.value, null)} placeholder="Nome (fora da equipe)" className={`${className} mt-1 w-full`} />
          {name.trim() && <span className="mt-0.5 block text-[10px] text-amber-300">Fora da equipe: conta como outra pessoa na comissão e nas metas. Se é alguém da loja, escolha na lista.</span>}
        </>
      )}
    </div>
  );
}
