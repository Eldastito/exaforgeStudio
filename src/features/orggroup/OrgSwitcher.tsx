/**
 * OrgSwitcher — ADR-199 F0c-2 (UI): seletor de operação no header.
 *
 * Só aparece quando a identidade tem >1 operação (membership) — 0-regressão pro parque
 * single-org. Trocar chama POST /api/auth/switch-org (reassina o JWT com a org alvo),
 * atualiza a sessão (login) e RECARREGA a página (descarta qualquer estado/cache da org
 * anterior — RN-GRP-07). "Gerenciar grupo" abre a tela do grupo (viewMode 'grupo').
 *
 * Feature gated no servidor (rotas dão 404 sem FEATURE_ORG_GROUPS) → aqui vira "sem orgs".
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Building2, Check } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useAuth } from '@/src/contexts/AuthContext';
import { useStore } from '@/src/store/useStore';

interface Membership { organizationId: string; businessName: string | null; role: string; current: boolean }

export function OrgSwitcher() {
  const { login } = useAuth();
  const setViewMode = useStore((s) => s.setViewMode);
  const [orgs, setOrgs] = useState<Membership[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/auth/organizations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.organizations) setOrgs(d.organizations); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // 0-regressão: sem grupo (≤1 operação), nada é renderizado.
  if (orgs.length < 2) return null;

  const current = orgs.find((o) => o.current);

  async function switchTo(orgId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/auth/switch-org', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId }),
      });
      if (!r.ok) { setBusy(false); return; }
      const d = await r.json();
      if (d?.token && d?.user) {
        login(d.token, { ...d.user, organizationId: d.user.organizationId });
        window.location.reload(); // descarta estado da org anterior (RN-GRP-07)
      } else setBusy(false);
    } catch { setBusy(false); }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs md:text-sm font-medium text-zinc-200 hover:bg-zinc-800 max-w-[180px]"
        title="Trocar de operação"
      >
        <Building2 className="w-4 h-4 shrink-0 text-zinc-400" />
        <span className="truncate">{current?.businessName || 'Operação'}</span>
        <ChevronDown className="w-4 h-4 shrink-0 text-zinc-500" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-64 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">Operações</div>
          <div className="max-h-72 overflow-y-auto py-1">
            {orgs.map((o) => (
              <button
                key={o.organizationId}
                onClick={() => (o.current ? setOpen(false) : switchTo(o.organizationId))}
                disabled={busy}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800 ${o.current ? 'text-white' : 'text-zinc-300'}`}
              >
                <span className="flex-1 truncate">{o.businessName || o.organizationId}</span>
                <span className="text-[10px] text-zinc-500 uppercase">{o.role}</span>
                {o.current && <Check className="w-4 h-4 text-emerald-400" />}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setOpen(false); setViewMode('grupo'); }}
            className="w-full text-left px-3 py-2 text-sm text-indigo-300 hover:bg-zinc-800 border-t border-zinc-800"
          >
            Gerenciar grupo →
          </button>
        </div>
      )}
    </div>
  );
}
