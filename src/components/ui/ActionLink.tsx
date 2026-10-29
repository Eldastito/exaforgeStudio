import type { ReactNode } from 'react';
import { useStore } from '@/src/store/useStore';
import type { StoreFixField } from '@/src/lib/actionLinks';

// Texto de aviso que leva o usuário direto ao lugar do acerto (ver src/lib/actionLinks.ts).
type Tone = 'sky' | 'amber' | 'red';
const TONE: Record<Tone, string> = { sky: 'text-sky-300 hover:text-sky-200', amber: 'text-amber-100 hover:text-white', red: 'text-red-100 hover:text-white' };

export function ActionLink({ onClick, children, title, tone = 'amber' }: { onClick: () => void; children: ReactNode; title?: string; tone?: Tone }) {
  return (
    <button type="button" onClick={onClick} title={title || 'Ir direto para o lugar'} className={`underline underline-offset-2 decoration-dotted font-medium ${TONE[tone]}`}>
      {children}
    </button>
  );
}

/** Abre uma aba da Operação da Rede (a mesma ponte da barra "Pergunte ou procure"). */
export function TabLink({ tab, children, title, tone }: { tab: string; children: ReactNode; title?: string; tone?: Tone }) {
  const setTab = useStore(s => s.setPendingRetailTab);
  return <ActionLink tone={tone} title={title} onClick={() => setTab(tab)}>{children}</ActionLink>;
}

/** Abre o formulário da loja (ou uma loja nova, field 'new') já no campo que precisa de acerto. */
export function StoreFixLink({ field, storeId = null, children, title, tone }: { field: StoreFixField; storeId?: string | null; children: ReactNode; title?: string; tone?: Tone }) {
  const setFix = useStore(s => s.setPendingStoreFix);
  const setTab = useStore(s => s.setPendingRetailTab);
  return <ActionLink tone={tone} title={title} onClick={() => { setFix({ storeId, field }); setTab('fechamento'); }}>{children}</ActionLink>;
}
