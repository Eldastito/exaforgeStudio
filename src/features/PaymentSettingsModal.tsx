import React, { useEffect, useState } from 'react';
import { X, CreditCard, KeyRound, Copy, Check } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

type Settings = {
  enabled: boolean; provider: string; pixKey: string; pixName: string; pixCity: string;
  instructions: string; hasGatewayToken: boolean; hasWebhookSecret: boolean;
};

export function PaymentSettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [gatewayToken, setGatewayToken] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const webhookBase = `${window.location.origin}/api/webhooks/payment`;

  useEffect(() => {
    apiFetch('/api/payments/settings').then(r => r.json()).then(setS).catch(() => setS(null));
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      await apiFetch('/api/payments/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...s, gatewayToken: gatewayToken || undefined }),
      });
      setGatewayToken('');
      const fresh = await apiFetch('/api/payments/settings').then(r => r.json());
      setS(fresh);
    } catch (e) { alert('Erro ao salvar'); }
    finally { setSaving(false); }
  };

  const genSecret = async () => {
    const res = await apiFetch('/api/payments/webhook-secret', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (d.secret) setSecret(d.secret);
  };

  const copyWebhook = () => {
    const url = secret ? `${webhookBase}?secret=${secret}` : webhookBase;
    navigator.clipboard?.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  if (!s) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[560px] max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><CreditCard className="w-5 h-5 text-emerald-400" /> Recebimento de pagamentos</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Configure como a sua empresa recebe dos clientes. Os valores caem na sua conta.</p>

        {/* Liga/desliga */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 mb-4">
          <span className="text-sm text-zinc-200">Cobrança de pagamento ativa</span>
          <button onClick={() => setS({ ...s, enabled: !s.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${s.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {/* Método */}
        <label className="text-sm text-zinc-400 mb-1 block">Método</label>
        <select className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 mb-4"
          value={s.provider} onChange={e => setS({ ...s, provider: e.target.value })}>
          <option value="pix_manual">Pix manual (minha chave Pix)</option>
          <option value="mercadopago">Mercado Pago (gateway)</option>
          <option value="custom">Outro gateway</option>
        </select>

        {/* Pix manual */}
        {s.provider === 'pix_manual' && (
          <div className="space-y-3 mb-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Chave Pix</label>
              <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                placeholder="CPF/CNPJ, e-mail, telefone ou aleatória" value={s.pixKey} onChange={e => setS({ ...s, pixKey: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Nome do beneficiário" value={s.pixName} onChange={e => setS({ ...s, pixName: e.target.value })} />
              <input className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Cidade" value={s.pixCity} onChange={e => setS({ ...s, pixCity: e.target.value })} />
            </div>
            <textarea className="w-full h-16 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
              placeholder="Instruções enviadas ao cliente (opcional)" value={s.instructions} onChange={e => setS({ ...s, instructions: e.target.value })} />
            <p className="text-[11px] text-zinc-500">A IA enviará a chave Pix ao cliente ao fechar o pedido. Você confirma o pagamento na lista de pedidos após receber o comprovante.</p>
          </div>
        )}

        {/* Gateway */}
        {(s.provider === 'mercadopago' || s.provider === 'custom') && (
          <div className="space-y-3 mb-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Token / credencial do gateway</label>
              <input type="password" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                placeholder={s.hasGatewayToken ? '•••••••• (já configurado — preencha para substituir)' : 'Cole o access token'} value={gatewayToken} onChange={e => setGatewayToken(e.target.value)} />
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <p className="text-sm text-zinc-200 flex items-center gap-2 mb-2"><KeyRound className="w-4 h-4 text-indigo-400" /> Webhook de confirmação</p>
              <p className="text-[11px] text-zinc-500 mb-2">Configure esta URL no seu gateway para o pedido ser marcado como pago automaticamente.</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] text-indigo-300 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 truncate">
                  {secret ? `${webhookBase}?secret=${secret}` : (s.hasWebhookSecret ? `${webhookBase}?secret=••••••` : webhookBase)}
                </code>
                <button onClick={copyWebhook} className="text-zinc-400 hover:text-indigo-300 p-1.5 border border-zinc-800 rounded">
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <button onClick={genSecret} className="mt-2 text-xs text-indigo-300 hover:text-indigo-200">
                {s.hasWebhookSecret ? 'Gerar novo segredo' : 'Gerar segredo do webhook'}
              </button>
              {secret && <p className="text-[11px] text-amber-400/80 mt-1">Copie agora — por segurança, o segredo completo não é exibido novamente.</p>}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Fechar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">{saving ? 'Salvando...' : 'Salvar'}</Button>
        </div>
      </div>
    </div>
  );
}
