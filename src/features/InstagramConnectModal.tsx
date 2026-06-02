import React, { useState } from 'react';
import { X, Instagram, Copy, Check, ExternalLink } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

/**
 * Conexão real do Instagram Direct por CREDENCIAIS (sem OAuth).
 * O usuário cola o Token da Página e o Instagram Business Account ID, obtidos
 * no painel da Meta. O webhook do app (/api/webhooks/meta) já processa as DMs.
 */
export function InstagramConnectModal({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [form, setForm] = useState({ username: '', igBusinessId: '', pageToken: '' });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const webhookUrl = `${window.location.origin}/api/webhooks/meta`;

  const connect = async () => {
    if (!form.igBusinessId.trim() || !form.pageToken.trim()) {
      alert('Informe o Instagram Business ID e o Token da Página.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/channels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'instagram',
          name: form.username ? `Instagram ${form.username}` : 'Instagram Direct',
          identifier: form.igBusinessId.trim(),
          token_encrypted: form.pageToken.trim(),
          metadata_json: { username: form.username },
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { onConnected(); onClose(); }
      else alert(d.error || 'Erro ao conectar Instagram');
    } catch (e) { alert('Erro ao conectar Instagram'); }
    finally { setSaving(false); }
  };

  const copyWebhook = () => { navigator.clipboard?.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[560px] max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Instagram className="w-5 h-5 text-pink-400" /> Conectar Instagram Direct</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Conecte o Direct para a IA atender as mensagens e encaminhar leads para o WhatsApp.</p>

        {/* Conexão recomendada: login OAuth do Instagram */}
        <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4 mb-5">
          <p className="text-sm font-medium text-zinc-100 mb-1">Conexão recomendada (1 clique)</p>
          <p className="text-xs text-zinc-400 mb-3">Faça login com o Instagram e autorize — o token completo (que entrega o texto das mensagens) é capturado automaticamente.</p>
          <Button
            onClick={async () => {
              try {
                const res = await apiFetch('/api/integrations/instagram/login-url');
                const d = await res.json();
                if (d.url) { window.location.href = d.url; }
                else alert(d.error || 'Configure as credenciais do app da Meta no servidor.');
              } catch (e) { alert('Erro ao iniciar o login do Instagram.'); }
            }}
            className="w-full bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white">
            <Instagram className="w-4 h-4 mr-2" /> Entrar com Instagram
          </Button>
        </div>

        <p className="text-[11px] text-zinc-600 mb-3 text-center">— ou conecte manualmente colando as credenciais —</p>

        {/* Pré-requisitos */}
        <div className="rounded-lg border border-pink-500/20 bg-pink-500/5 p-3 mb-4 text-xs text-pink-200/80 space-y-1">
          <p className="font-semibold text-pink-300">Pré-requisitos (no Meta for Developers):</p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>Conta Instagram <strong>Profissional</strong> vinculada a uma <strong>Página do Facebook</strong>.</li>
            <li>Um App da Meta com permissões <code>instagram_manage_messages</code> + <code>pages_messaging</code>.</li>
            <li>Webhook do Instagram configurado (campo <code>messages</code>) apontando para a URL abaixo.</li>
          </ol>
          <a href="https://developers.facebook.com/docs/messenger-platform/instagram" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-pink-300 hover:text-pink-200 mt-1">
            Documentação da Meta <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {/* URL do webhook */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 mb-4">
          <p className="text-xs text-zinc-400 mb-1">URL do Webhook (cole no painel da Meta):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] text-indigo-300 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 truncate">{webhookUrl}</code>
            <button onClick={copyWebhook} className="text-zinc-400 hover:text-indigo-300 p-1.5 border border-zinc-800 rounded">{copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}</button>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1">Token de verificação do webhook: use o valor da env <code>META_VERIFY_TOKEN</code> do seu deploy.</p>
        </div>

        {/* Credenciais */}
        <div className="space-y-3">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">@usuário (opcional)</label>
            <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="@minha_loja" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Instagram Business Account ID</label>
            <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Ex: 17841400000000000" value={form.igBusinessId} onChange={e => setForm({ ...form, igBusinessId: e.target.value })} />
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Token de Acesso da Página</label>
            <input type="password" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="EAAB..." value={form.pageToken} onChange={e => setForm({ ...form, pageToken: e.target.value })} />
            <p className="text-[10px] text-zinc-500 mt-1">Use um <strong>token de longa duração</strong> da Página para não expirar.</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={connect} disabled={saving} className="bg-pink-600 hover:bg-pink-700 text-white">{saving ? 'Conectando...' : 'Conectar'}</Button>
        </div>
      </div>
    </div>
  );
}
