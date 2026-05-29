import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Image as ImageIcon, Briefcase, Users, CreditCard } from 'lucide-react';
import { Button } from '@/src/components/ui/button';

import { UsersSettingsView } from './UsersSettingsView';

export function SettingsView() {
  const [activeTab, setActiveTab] = useState('empresa');
  const [form, setForm] = useState({
    business_name: '',
    legal_name: '',
    cnpj_cpf: '',
    address: '',
    phone: '',
    email: '',
    logo_url: '',
    primary_color: '#6366f1',
    report_footer: ''
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/analytics/settings')
      .then(res => res.json())
      .then(data => {
        if (data.business_name) {
          setForm(data);
        }
      })
      .catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      alert('Configurações salvas com sucesso!');
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden bg-zinc-950">
      {/* Config Sidebar */}
      <div className="w-64 border-r border-zinc-800 bg-zinc-900/30 p-4 overflow-y-auto">
        <h3 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-4 px-3">Configurações</h3>
        <nav className="space-y-1">
          <button onClick={() => setActiveTab('empresa')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'empresa' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Briefcase className="w-4 h-4" /> Empresa
          </button>
          <button onClick={() => setActiveTab('usuarios')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'usuarios' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <Users className="w-4 h-4" /> Usuários e Permissões
          </button>
  <button onClick={() => setActiveTab('cobranca')} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${activeTab === 'cobranca' ? 'bg-indigo-500/10 text-indigo-400 font-medium' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'}`}>
            <CreditCard className="w-4 h-4" /> Cobrança e Plano
          </button>
        </nav>
      </div>

      <div className="flex-1 overflow-auto p-8">
        <div className="max-w-3xl">
          
          {activeTab === 'empresa' && (
            <>
              <div className="mb-6 flex items-center justify-between border-b border-zinc-800 pb-4">
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-indigo-400" />
                    Dados da Empresa
                  </h2>
                  <p className="text-zinc-400 text-sm mt-1">Configurações gerais e dados para geração de relatórios.</p>
                </div>
                <Button onClick={handleSubmit} disabled={loading} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                  <Save className="w-4 h-4 mr-2" />
                  {loading ? 'Salvando...' : 'Salvar'}
                </Button>
              </div>

              <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
                <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Nome Fantasia</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.business_name} onChange={e => setForm({...form, business_name: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Razão Social</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.legal_name} onChange={e => setForm({...form, legal_name: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">CNPJ / CPF</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.cnpj_cpf} onChange={e => setForm({...form, cnpj_cpf: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Telefone Comercial</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.phone} onChange={e => setForm({...form, phone: e.target.value})} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">E-mail</label>
                <input type="email" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.email} onChange={e => setForm({...form, email: e.target.value})} />
              </div>
              <div>
                <label className="text-sm font-medium text-zinc-400 mb-1 block">Cor Principal (Relatórios)</label>
                <div className="flex gap-2">
                  <input type="color" className="bg-zinc-950 border border-zinc-800 rounded p-1 w-12 h-10" 
                    value={form.primary_color} onChange={e => setForm({...form, primary_color: e.target.value})} />
                  <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 outline-none font-mono" 
                    value={form.primary_color} onChange={e => setForm({...form, primary_color: e.target.value})} />
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Logomarca (URL ou Arquivo)</label>
              <div className="flex items-center gap-4">
                <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                  value={form.logo_url} onChange={e => setForm({...form, logo_url: e.target.value})} placeholder="https://..." />
                
                <label className="cursor-pointer bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm py-2.5 px-4 rounded-lg transition-colors border border-zinc-700 font-medium">
                  Pesquisar
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                          setForm({ ...form, logo_url: reader.result as string });
                        };
                        reader.readAsDataURL(file);
                      }
                    }} 
                  />
                </label>

                {form.logo_url ? (
                  <img src={form.logo_url} alt="Logo preview" className="w-10 h-10 object-contain rounded bg-white p-1" />
                ) : (
                  <div className="w-10 h-10 rounded border border-zinc-800 flex items-center justify-center bg-zinc-950">
                    <ImageIcon className="w-4 h-4 text-zinc-600" />
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Endereço Completo</label>
              <input className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none" 
                value={form.address} onChange={e => setForm({...form, address: e.target.value})} />
            </div>

            <div>
              <label className="text-sm font-medium text-zinc-400 mb-1 block">Rodapé de Relatórios</label>
              <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-indigo-500 outline-none min-h-[80px]" 
                value={form.report_footer} onChange={e => setForm({...form, report_footer: e.target.value})} placeholder="Ex: Este documento é confidencial..." />
            </div>

          </form>
          </div>
          </>
          )}

          {activeTab === 'cobranca' && (
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
               <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2"><CreditCard className="w-5 h-5" /> Plano Atual</h2>
               <div className="p-4 bg-zinc-950 rounded-lg border border-zinc-800 mb-6">
                  <p className="text-sm text-zinc-400">Seu plano atual é o <strong className="text-indigo-400">Pro Zapp</strong>.</p>
                  <p className="text-sm text-zinc-400 mt-1">Status: <span className="bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-xs">Ativo</span></p>
               </div>
            </div>
          )}

          {activeTab === 'usuarios' && (
             <UsersSettingsView />
          )}
        </div>
      </div>
    </div>
  );
}
