import { useEffect, useMemo, useState } from 'react';

// ZappFlow Comigo — página pública do Mesa/QR (ADR-119). Sem login: o cliente lê
// o QR (/mesa/:token), monta o pedido, PAGA pelo Pix dinâmico e só então o
// pedido entra na fila de preparo. Autocontida; usa /api/public/comigo/*.

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
type MenuItem = { id: string; name: string; price: number };
type Placed = { orderId: string; total: number; txid: string; qrPayload: string };

export function ComigoMesaPage() {
  const token = useMemo(() => window.location.pathname.split('/')[2] || '', []);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [alias, setAlias] = useState('');
  const [consumo, setConsumo] = useState<'local' | 'viagem'>('local');
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [paid, setPaid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch(`/api/public/comigo/${token}/menu`).then((r) => r.json()).then((r) => {
      if (Array.isArray(r?.items)) setMenu(r.items); else setErr('Cardápio não encontrado.');
    }).catch(() => setErr('Não consegui carregar o cardápio.')).finally(() => setLoading(false));
  }, [token]);

  const total = useMemo(() => menu.reduce((s: number, m) => s + (cart[m.id] || 0) * m.price, 0), [menu, cart]);
  const count = useMemo(() => Object.values(cart).reduce((s: number, q: number) => s + q, 0), [cart]);

  const add = (id: string) => setCart((c) => ({ ...c, [id]: (c[id] || 0) + 1 }));
  const sub = (id: string) => setCart((c) => { const q = (c[id] || 0) - 1; const n = { ...c }; if (q <= 0) delete n[id]; else n[id] = q; return n; });

  const order = async () => {
    if (busy || count === 0) return;
    setBusy(true); setErr('');
    try {
      const items = Object.entries(cart).map(([productId, qty]) => ({ productId, qty }));
      const out = await fetch(`/api/public/comigo/${token}/order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, sessionAlias: alias, consumo }),
      }).then((r) => r.json());
      if (out?.ok) setPlaced(out);
      else setErr('Não consegui registrar o pedido. Tente de novo.');
    } catch { setErr('Falha de conexão.'); }
    finally { setBusy(false); }
  };

  // Polling do pagamento (Pix dinâmico confirma sozinho via webhook do PSP).
  useEffect(() => {
    if (!placed || paid) return;
    const iv = setInterval(() => {
      fetch(`/api/public/comigo/${token}/order/${placed.orderId}/status`).then((r) => r.json())
        .then((s) => { if (s?.paid) { setPaid(true); clearInterval(iv); } }).catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [placed, paid, token]);

  return (
    <div style={{ minHeight: '100vh', background: '#09090b', color: '#fafafa', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '8px 0 16px' }}>🍽️ Faça seu pedido</h1>

        {loading && <p style={{ color: '#a1a1aa' }}>Carregando cardápio…</p>}
        {err && <p style={{ color: '#fca5a5' }}>{err}</p>}

        {/* Pagamento confirmado */}
        {paid ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 40 }}>🎉</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 8 }}>Pagamento confirmado!</h2>
            <p style={{ color: '#a1a1aa', marginTop: 4 }}>Seu pedido já está sendo preparado. Obrigado!</p>
          </div>
        ) : placed ? (
          /* Pagamento pendente: mostra o Pix copia-e-cola */
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Pague {brl(placed.total)} pelo Pix</h2>
            <p style={{ color: '#a1a1aa', fontSize: 13, marginTop: 4 }}>Copie o código, pague no seu banco e aguarde a confirmação automática nesta tela.</p>
            <div style={{ background: '#18181b', borderRadius: 8, padding: 12, marginTop: 12, wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12, color: '#e4e4e7' }}>{placed.qrPayload}</div>
            <button onClick={() => { navigator.clipboard?.writeText(placed.qrPayload); }}
              style={{ marginTop: 12, width: '100%', padding: 12, borderRadius: 8, border: 'none', background: '#0ea5e9', color: '#fff', fontWeight: 600, fontSize: 15 }}>
              Copiar código Pix
            </button>
            <p style={{ color: '#71717a', fontSize: 12, textAlign: 'center', marginTop: 12 }}>⏳ aguardando o pagamento…</p>
          </div>
        ) : (
          /* Cardápio + carrinho */
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {menu.map((m) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#18181b', border: '1px solid #27272a', borderRadius: 12, padding: 12 }}>
                  <div>
                    <div style={{ fontSize: 15 }}>{m.name}</div>
                    <div style={{ color: '#6ee7b7', fontSize: 14 }}>{brl(m.price)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {cart[m.id] ? <>
                      <button onClick={() => sub(m.id)} style={btnSm}>−</button>
                      <span style={{ minWidth: 16, textAlign: 'center' }}>{cart[m.id]}</span>
                    </> : null}
                    <button onClick={() => add(m.id)} style={btnSm}>+</button>
                  </div>
                </div>
              ))}
            </div>

            {count > 0 && (
              <div style={{ marginTop: 16 }}>
                <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Seu nome (pra chamar quando ficar pronto)"
                  style={{ width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 8, background: '#18181b', border: '1px solid #27272a', color: '#fafafa', fontSize: 15 }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {(['local', 'viagem'] as const).map((c) => (
                    <button key={c} onClick={() => setConsumo(c)}
                      style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid ' + (consumo === c ? '#10b981' : '#27272a'), background: consumo === c ? 'rgba(16,185,129,0.1)' : '#18181b', color: '#fafafa', fontSize: 14 }}>
                      {c === 'local' ? 'Comer aqui' : 'Viagem'}
                    </button>
                  ))}
                </div>
                <button onClick={order} disabled={busy}
                  style={{ marginTop: 12, width: '100%', padding: 14, borderRadius: 10, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: 16, opacity: busy ? 0.6 : 1 }}>
                  Pedir e pagar {brl(total)} • {count} {count === 1 ? 'item' : 'itens'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const btnSm: any = { width: 32, height: 32, borderRadius: 8, border: '1px solid #3f3f46', background: '#27272a', color: '#fafafa', fontSize: 18, lineHeight: '1' };

export default ComigoMesaPage;
