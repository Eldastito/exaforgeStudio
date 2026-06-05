import React, { useEffect, useState } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

type Vertical = { key: string; label: string; descricao: string; icon: string };

export function OnboardingView() {
  const { user, login, token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [formData, setFormData] = useState({
    business_name: '',
    address: '',
    phone: '',
    logo_url: '',
    vertical: '',
  });

  useEffect(() => {
    apiFetch('/api/analytics/verticals')
      .then(r => r.json())
      .then(d => setVerticals(Array.isArray(d) ? d : []))
      .catch(() => setVerticals([]));
  }, []);

  const finishOnboarding = async () => {
    setLoading(true);
    try {
      await apiFetch('/api/analytics/settings/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      // refresh user profile
      const res = await apiFetch('/api/auth/me');
      if (res.ok) {
        const u = await res.json();
        login(token!, u);
      }
    } catch(e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="bg-indigo-600/10 border-b border-indigo-500/20 px-8 py-6 text-center">
          <h2 className="text-xl font-semibold text-zinc-100">Bem-vindo ao Zappflow AI</h2>
          <p className="text-zinc-400 text-sm mt-1">Sua conta foi criada. Vamos configurar primeiros passos rápidos.</p>
          <span className="mt-3 inline-block text-xs font-medium text-indigo-300">Passo {step} de 3</span>
        </div>

        <div className="p-8 space-y-6">
          {step === 1 && (
            <div className="space-y-4 animate-in fade-in zoom-in-95">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Nome p/ Exibição</label>
                <input
                  value={formData.business_name} onChange={e => setFormData({...formData, business_name: e.target.value})}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500"
                  placeholder="Nome Fantasia"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Telefone de Contato</label>
                <input
                  value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500"
                  placeholder="(11) 99999-9999"
                  inputMode="tel"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Endereço Comercial</label>
                <input
                  value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500"
                  placeholder="Rua Exemplo, 123"
                />
              </div>
              <Button
                onClick={() => setStep(2)}
                disabled={!formData.business_name.trim() || !formData.phone.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >Continuar</Button>
              {(!formData.business_name.trim() || !formData.phone.trim()) && (
                <p className="text-center text-xs text-zinc-500">Informe o nome e o telefone para continuar.</p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 animate-in fade-in zoom-in-95">
              <div className="text-center mb-2">
                <p className="text-sm font-medium text-zinc-200">Qual o seu tipo de negócio?</p>
                <p className="text-xs text-zinc-500 mt-1">Deixamos o app pronto para o seu segmento — você ajusta depois em Configurações.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[320px] overflow-y-auto pr-1">
                {verticals.map(v => {
                  const sel = formData.vertical === v.key;
                  return (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => setFormData({ ...formData, vertical: v.key })}
                      className={`text-left rounded-xl border p-3 transition ${sel ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{v.icon}</span>
                        <span className="text-sm font-semibold text-zinc-100">{v.label}</span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1 leading-snug">{v.descricao}</p>
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-4 pt-1">
                <Button variant="outline" onClick={() => setStep(1)} className="w-full border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700">Voltar</Button>
                <Button onClick={() => setStep(3)} disabled={!formData.vertical} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50">Continuar</Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 animate-in fade-in zoom-in-95">
              <div className="text-center mb-6">
                <div className="w-20 h-20 mx-auto rounded-full bg-zinc-800 flex items-center justify-center mb-4">
                  {formData.logo_url ? <img src={formData.logo_url} className="w-full h-full object-cover rounded-full"/> : <span className="text-zinc-500 text-xs">Sem Logo</span>}
                </div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">URL da Logomarca (Opcional)</label>
                <input
                  value={formData.logo_url} onChange={e => setFormData({...formData, logo_url: e.target.value})}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 text-center"
                  placeholder="https://..."
                />
              </div>

              <div className="flex gap-4">
                <Button variant="outline" onClick={() => setStep(2)} className="w-full border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700">Voltar</Button>
                <Button onClick={finishOnboarding} disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700">{loading ? 'Finalizando...' : 'Concluir'}</Button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
