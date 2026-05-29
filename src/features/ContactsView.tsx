import React from 'react';
import { Users, Phone, Search } from 'lucide-react';
import { useStore } from '@/src/store/useStore';

export function ContactsView() {
  const { contacts } = useStore();

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-400" />
            Contatos
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Gerencie a base de clientes e leads</p>
        </div>
      </div>
      
      <div className="mb-6 relative">
          <Search className="w-5 h-5 absolute left-3 top-2.5 text-zinc-500" />
          <input 
            type="text" 
            placeholder="Buscar contatos..." 
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Object.values(contacts).length === 0 ? (
          <div className="col-span-full py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
            Nenhum contato encontrado.
          </div>
        ) : (
          Object.values(contacts).map(c => (
            <div key={c.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 flex align-middle items-start gap-4 hover:bg-zinc-900 transition-colors">
              <img src={c.avatar || 'https://via.placeholder.com/150'} alt={c.name} className="w-12 h-12 rounded-full bg-zinc-800 object-cover" />
              <div>
                 <h3 className="font-semibold text-zinc-100">{c.name}</h3>
                 <div className="flex items-center gap-1 mt-1 text-xs text-zinc-500">
                    <Phone className="w-3 h-3" />
                    {c.number}
                 </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
