import { useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Página PÚBLICA de consentimento do cliente do PDV (ADR-204 D4c) — /consentimento/:token.
 * Standalone (sem login/AuthContext). Dois botões de peso igual, nada pré-marcado; o cliente pode
 * mudar de ideia enquanto o link valer. Mostra o mínimo: empresa, 1º nome e final do celular.
 */
type View = { businessName: string; firstName: string | null; phoneTail: string | null; state: 'granted' | 'revoked' | 'unknown'; expiresAt: string };

function readToken(): string | null {
  const last = window.location.pathname.split('/').filter(Boolean).pop();
  return !last || last === 'consentimento' ? null : decodeURIComponent(last);
}

export function ConsentPage() {
  const token = useMemo(readToken, []);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<'invalid' | 'expired' | 'network' | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<'granted' | 'revoked' | null>(null);

  useEffect(() => {
    if (!token) { setErr('invalid'); return; }
    fetch(`/api/public/consent/${encodeURIComponent(token)}`)
      .then(async r => {
        if (r.status === 410) return setErr('expired');
        if (!r.ok) return setErr('invalid');
        setView(await r.json());
      })
      .catch(() => setErr('network'));
  }, [token]);

  const decide = async (granted: boolean) => {
    if (!token) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/public/consent/${encodeURIComponent(token)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted }) });
      if (r.status === 410) { setErr('expired'); return; }
      if (!r.ok) { setErr('invalid'); return; }
      const d = await r.json();
      setDone(d.state === 'granted' ? 'granted' : 'revoked');
    } catch { setErr('network'); } finally { setSaving(false); }
  };

  const shell = (children: ReactNode) => (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-4">{children}</div>
    </div>
  );

  if (err) return shell(<p data-testid="consent-error" className="text-sm text-zinc-300">{err === 'expired' ? 'Este link venceu. Peça um novo link à loja.' : err === 'network' ? 'Sem conexão. Tente de novo em instantes.' : 'Link inválido ou já substituído. Peça um novo link à loja.'}</p>);
  if (!view) return shell(<p className="text-sm text-zinc-400">Carregando…</p>);
  if (done) return shell(<>
    <h1 className="text-lg font-semibold">{done === 'granted' ? 'Autorização registrada' : 'Tudo certo, sem mensagens'}</h1>
    <p className="text-sm text-zinc-300">{done === 'granted' ? `${view.businessName} poderá enviar mensagens ao seu celular.` : `${view.businessName} não enviará mensagens ao seu celular.`} Você pode mudar de ideia a qualquer momento: reabra este link (enquanto valer) ou avise a loja.</p>
    <button onClick={() => setDone(null)} className="text-xs text-zinc-400 underline">Mudar minha escolha</button>
  </>);

  return shell(<>
    <h1 className="text-lg font-semibold">{view.firstName ? `Olá, ${view.firstName}!` : 'Olá!'}</h1>
    <p className="text-sm text-zinc-300">
      <strong>{view.businessName}</strong> gostaria de enviar mensagens (como avisos, novidades e ofertas) para o celular{view.phoneTail ? ` terminado em ${view.phoneTail}` : ''}. Isso só acontece se você autorizar.
    </p>
    {view.state !== 'unknown' && <p className="text-xs text-zinc-400" data-testid="consent-current">Sua escolha atual: {view.state === 'granted' ? 'autorizou' : 'não autorizou'}. Você pode alterá-la abaixo.</p>}
    <div className="grid grid-cols-2 gap-3">
      <button disabled={saving} onClick={() => decide(true)} className="rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-3 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50">Autorizo</button>
      <button disabled={saving} onClick={() => decide(false)} className="rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-3 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50">Não autorizo</button>
    </div>
    <p className="text-[11px] text-zinc-500">Você pode revogar quando quiser, sem custo. Usamos apenas a sua escolha e o número de celular já cadastrado na loja (LGPD).</p>
  </>);
}
