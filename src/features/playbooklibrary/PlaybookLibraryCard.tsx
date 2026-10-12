import { useState } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useAuth } from '@/src/contexts/AuthContext';
import {
  stageLabel, riskLabel, autonomyLabel, verticalsLabel, fitLine, adoptionLine, ceilingWarning, efficacyLine, orderLibrary,
  type LibraryItem,
} from './libraryLabels';

/**
 * Biblioteca de playbooks (ADR-206 F5.3 → tela F5.11) dentro de Empresa → Autonomia da IA — SEM menu novo. Mostra o catálogo de playbooks que o
 * ZapFlow já tem, em linguagem de dono: para quem serve, o que precisa existir antes, até onde pode agir sozinho, como se mede que funcionou, de
 * onde vem o estágio e o que aconteceu na SUA empresa. Só EXIBE o que o `PlaybookRegistryService` devolveu: não liga, não desliga, não inicia
 * nada e não recomenda. Só carrega quando o dono abre. Depende do Execution Runtime estar ligado na empresa (a rota é do runtime).
 */
export function PlaybookLibraryCard() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'unavailable' | 'error'>('idle');
  const [items, setItems] = useState<LibraryItem[] | null>(null);

  if (user?.role !== 'owner' && user?.role !== 'admin') return null;

  const load = () => {
    setState('loading');
    apiFetch('/api/runtime/playbook-registry')
      .then(async (r) => {
        if (r.status === 403) { setState('unavailable'); return; }
        if (!r.ok) { setState('error'); return; }
        const j = await r.json(); setItems(Array.isArray(j.forOrg) ? j.forOrg : []); setState('idle');
      })
      .catch(() => setState('error'));
  };
  const toggle = () => { const next = !open; setOpen(next); if (next && !items && state !== 'loading') load(); };

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button onClick={toggle} className="w-full flex items-center justify-between gap-3 p-4 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-teal-300 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">Biblioteca de playbooks</span>
            <span className="block text-[12px] text-zinc-400">Os roteiros prontos que a IA sabe seguir, até onde cada um pode agir e como está indo na sua empresa.</span>
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          {state === 'loading' && <p className="text-sm text-zinc-400">Carregando…</p>}
          {state === 'unavailable' && <p className="text-sm text-zinc-400">A biblioteca aparece quando o Execution Runtime está ligado na sua empresa. Peça a ativação ao administrador.</p>}
          {state === 'error' && <p className="text-sm text-zinc-400">Não consegui carregar agora. Tente de novo em instantes.</p>}
          {items && items.length === 0 && <p className="text-sm text-zinc-400">Nenhum playbook no catálogo.</p>}
          {items && orderLibrary(items).map((i) => {
            const warn = ceilingWarning(i);
            return (
              <div key={`${i.playbook.id}@${i.playbook.version}`} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-zinc-100">{i.playbook.name}</span>
                  <span className="text-[11px] rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">{stageLabel(i.playbook.stage)}</span>
                  <span className="text-[11px] rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">{riskLabel(i.playbook.risk)}</span>
                </div>
                <p className="text-[13px] text-zinc-300">{i.playbook.summary}</p>
                <p className="text-[12px] text-zinc-400"><b className="text-zinc-300">Serve para:</b> {verticalsLabel(i.playbook.verticals)}. {fitLine(i)}</p>
                <p className="text-[12px] text-zinc-400"><b className="text-zinc-300">Vai até:</b> {autonomyLabel(i.playbook.maxAutonomy)}.</p>
                <div className="text-[12px] text-zinc-400"><b className="text-zinc-300">Precisa existir antes:</b>
                  <ul className="list-disc ml-5">{i.playbook.preconditions.map((p, k) => <li key={k}>{p}</li>)}</ul>
                </div>
                <p className="text-[12px] text-zinc-400"><b className="text-zinc-300">Como se mede:</b> {i.playbook.successMetric}.</p>
                <p className="text-[12px] text-zinc-400"><b className="text-zinc-300">De onde vem o estágio:</b> {i.playbook.evidence}</p>
                <p className="text-[12px] text-zinc-400"><b className="text-zinc-300">Na sua empresa:</b> {adoptionLine(i)} {efficacyLine(i.efficacy)}</p>
                {warn && <p className="text-[12px] text-amber-300">⚠ {warn}</p>}
              </div>
            );
          })}
          <p className="text-[11px] text-zinc-500">Só leitura: esta lista não liga nem desliga nada. Mudanças de autonomia seguem pelos fluxos de aprovação.</p>
        </div>
      )}
    </div>
  );
}
