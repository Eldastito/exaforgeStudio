import { useEffect, useMemo, useState } from 'react';

// ZappFlow Comigo — página pública do Mesa/QR (ADR-119 + ADR-124). Vitrine com
// imagem (esqueleto da loja) + Pix dinâmico (pay-first) + fiado para cliente
// cadastrado e liberado pelo dono, dentro do limite. Autocontida; usa
// /api/public/comigo/*.

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
type MenuItem = { id: string; name: string; price: number; image?: string | null; description?: string | null };
type Placed = { orderId: string; total: number; txid?: string; qrPayload?: string; fiado?: boolean };

export function ComigoMesaPage() {
  const token = useMemo(() => window.location.pathname.split('/')[2] || '', []);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [alias, setAlias] = useState('');
  const [phone, setPhone] = useState('');
  const [consumo, setConsumo] = useState<'local' | 'viagem'>('local');
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [paid, setPaid] = useState(false);
  const [fiado, setFiado] = useState<{ authorized: boolean; available: number; fits: boolean; name?: string | null } | null>(null);
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

  // Fiado: só aparece pra quem o dono cadastrou e liberou (checa pelo telefone).
  useEffect(() => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 8 || count === 0) { setFiado(null); return; }
    const id = setTimeout(() => {
      fetch(`/api/public/comigo/${token}/fiado-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: digits, cartTotal: total }) })
        .then((r) => r.json()).then((e) => setFiado(e?.authorized ? e : null)).catch(() => setFiado(null));
    }, 500);
    return () => clearTimeout(id);
  }, [phone, total, count, token]);

  const order = async (payment: 'pix' | 'fiado') => {
    if (busy || count === 0) return;
    setBusy(true); setErr('');
    try {
      const items = Object.entries(cart).map(([productId, qty]) => ({ productId, qty }));
      const out = await fetch(`/api/public/comigo/${token}/order`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, sessionAlias: alias, consumo, payment, customer: { phone: phone.replace(/\D/g, '') } }),
      }).then((r) => r.json());
      if (out?.ok) { setPlaced(out); if (out.fiado) setPaid(true); }
      else if (out?.error === 'fiado_over_limit') setErr('Esse pedido passa do seu limite de fiado. Reduza itens ou pague no Pix.');
      else if (out?.error === 'fiado_not_authorized') setErr('Fiado não liberado para este telefone.');
      else setErr('Não consegui registrar o pedido. Tente de novo.');
    } catch { setErr('Falha de conexão.'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!placed || paid || placed.fiado) return;
    const iv = setInterval(() => {
      fetch(`/api/public/comigo/${token}/order/${placed.orderId}/status`).then((r) => r.json())
        .then((s) => { if (s?.paid) { setPaid(true); clearInterval(iv); } }).catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [placed, paid, token]);

  const S = STYLES;
  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <h1 style={S.h1}>🍽️ Faça seu pedido</h1>

        {loading && <p style={{ color: '#a1a1aa' }}>Carregando cardápio…</p>}
        {err && <p style={S.err}>{err}</p>}

        {paid ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 40 }}>🎉</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 8 }}>{placed?.fiado ? 'Anotado no fiado!' : 'Pagamento confirmado!'}</h2>
            <p style={{ color: '#a1a1aa', marginTop: 4 }}>Seu pedido já está sendo preparado. Obrigado!</p>
          </div>
        ) : placed && !placed.fiado ? (
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Pague {brl(placed.total)} pelo Pix</h2>
            <p style={{ color: '#a1a1aa', fontSize: 13, marginTop: 4 }}>Copie o código, pague no seu banco e aguarde a confirmação automática.</p>
            <div style={S.pixBox}>{placed.qrPayload}</div>
            <button onClick={() => navigator.clipboard?.writeText(placed.qrPayload || '')} style={S.btnSky}>Copiar código Pix</button>
            <p style={{ color: '#71717a', fontSize: 12, textAlign: 'center', marginTop: 12 }}>⏳ aguardando o pagamento…</p>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {menu.map((m) => (
                <div key={m.id} style={S.card}>
                  {m.image
                    ? <img src={m.image} alt={m.name} style={S.thumb} />
                    : <div style={{ ...S.thumb, ...S.thumbEmpty }}>🍽️</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, lineHeight: 1.25 }}>{m.name}</div>
                    {m.description ? <div style={S.desc}>{m.description}</div> : null}
                    <div style={{ color: '#6ee7b7', fontSize: 14, marginTop: 2 }}>{brl(m.price)}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {cart[m.id] ? <>
                      <button onClick={() => sub(m.id)} style={S.btnSm}>−</button>
                      <span style={{ minWidth: 16, textAlign: 'center' }}>{cart[m.id]}</span>
                    </> : null}
                    <button onClick={() => add(m.id)} style={S.btnSm}>+</button>
                  </div>
                </div>
              ))}
            </div>

            {count > 0 && (
              <div style={S.checkout}>
                <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Seu nome" style={S.input} />
                <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Seu telefone (com DDD)" inputMode="tel" style={{ ...S.input, marginTop: 8 }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {(['local', 'viagem'] as const).map((c) => (
                    <button key={c} onClick={() => setConsumo(c)} style={{ ...S.consumo, borderColor: consumo === c ? '#10b981' : '#27272a', background: consumo === c ? 'rgba(16,185,129,0.1)' : '#18181b' }}>
                      {c === 'local' ? 'Comer aqui' : 'Viagem'}
                    </button>
                  ))}
                </div>

                <button onClick={() => order('pix')} disabled={busy} style={{ ...S.btnPay, background: '#10b981', opacity: busy ? 0.6 : 1 }}>
                  Pagar {brl(total)} no Pix • {count} {count === 1 ? 'item' : 'itens'}
                </button>

                {/* Fiado: só aparece pra quem o dono liberou (ADR-124) */}
                {fiado?.authorized && (
                  <button onClick={() => order('fiado')} disabled={busy || !fiado.fits}
                    style={{ ...S.btnPay, marginTop: 8, background: fiado.fits ? '#d97706' : '#3f3f46', opacity: busy ? 0.6 : 1 }}>
                    {fiado.fits ? `Anotar no fiado ${brl(total)} (limite: ${brl(fiado.available)})` : `Fiado indisponível — passa do limite (${brl(fiado.available)})`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const STYLES: Record<string, any> = {
  page: { minHeight: '100vh', background: '#09090b', color: '#fafafa', fontFamily: 'system-ui, sans-serif' },
  wrap: { maxWidth: 520, margin: '0 auto', padding: 16 },
  h1: { fontSize: 20, fontWeight: 700, margin: '8px 0 16px' },
  err: { color: '#fca5a5' },
  card: { display: 'flex', alignItems: 'center', gap: 12, background: '#18181b', border: '1px solid #27272a', borderRadius: 14, padding: 10 },
  thumb: { width: 60, height: 60, borderRadius: 10, objectFit: 'cover', flexShrink: 0, background: '#27272a' },
  thumbEmpty: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 },
  desc: { color: '#a1a1aa', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checkout: { marginTop: 16 },
  input: { width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 8, background: '#18181b', border: '1px solid #27272a', color: '#fafafa', fontSize: 15 },
  consumo: { flex: 1, padding: 10, borderRadius: 8, border: '1px solid #27272a', color: '#fafafa', fontSize: 14 },
  btnPay: { width: '100%', padding: 14, borderRadius: 10, border: 'none', color: '#fff', fontWeight: 700, fontSize: 15, marginTop: 12 },
  btnSm: { width: 32, height: 32, borderRadius: 8, border: '1px solid #3f3f46', background: '#27272a', color: '#fafafa', fontSize: 18, lineHeight: '1' },
  btnSky: { marginTop: 12, width: '100%', padding: 12, borderRadius: 8, border: 'none', background: '#0ea5e9', color: '#fff', fontWeight: 600, fontSize: 15 },
  pixBox: { background: '#18181b', borderRadius: 8, padding: 12, marginTop: 12, wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 12, color: '#e4e4e7' },
};

export default ComigoMesaPage;
