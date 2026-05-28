import React from 'react';
import { useStore } from '@/src/store/useStore';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { BarChart3, TrendingUp, Users, Clock, MessageSquare, Briefcase } from 'lucide-react';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444']; // primary, emerald, amber, red

export function DashboardPanel() {
  const { tickets, messages, contacts } = useStore();

  const totalTickets = Object.keys(tickets).length;
  const inProgressTickets = Object.values(tickets).filter(t => t.stage === 'em_atendimento').length;
  const totalContacts = Object.keys(contacts).length;
  
  // Mocks for charts
  const ticketVolumeData = [
    { name: 'Seg', tickets: 12 },
    { name: 'Ter', tickets: 19 },
    { name: 'Qua', tickets: 15 },
    { name: 'Qui', tickets: 22 },
    { name: 'Sex', tickets: 28 },
    { name: 'Sáb', tickets: 10 },
    { name: 'Dom', tickets: 5 },
  ];

  const resolutionTimeData = [
    { name: 'Seg', tempo: 4.2 },
    { name: 'Ter', tempo: 3.8 },
    { name: 'Qua', tempo: 3.5 },
    { name: 'Qui', tempo: 4.0 },
    { name: 'Sex', tempo: 4.5 },
    { name: 'Sáb', tempo: 2.1 },
    { name: 'Dom', tempo: 1.5 },
  ];

  const sourceData = [
    { name: 'WhatsApp', value: 65 },
    { name: 'Instagram', value: 35 },
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 overflow-y-auto w-full">
      <div className="p-8 max-w-7xl mx-auto w-full space-y-8">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Visão Geral</h2>
            <p className="text-sm text-slate-400">Métricas de atendimento, SLA e produtividade da IA.</p>
          </div>
          <div className="flex gap-2">
            <select className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm rounded-lg px-3 py-2 outline-none focus:border-indigo-500 transition-colors">
              <option>Últimos 7 dias</option>
              <option>Este Mês</option>
              <option>Mês Passado</option>
            </select>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard 
            title="Total de Tickets" 
            value={totalTickets.toString()} 
            change="+12% vs última semana" 
            icon={<Briefcase className="w-5 h-5" />} 
          />
          <StatCard 
            title="Em Atendimento" 
            value={inProgressTickets.toString()} 
            change="3 urgentes" 
            icon={<Clock className="w-5 h-5 text-amber-500" />} 
          />
          <StatCard 
            title="Novos Contatos" 
            value={totalContacts.toString()} 
            change="+5 hoje" 
            icon={<Users className="w-5 h-5 text-emerald-500" />} 
          />
          <StatCard 
            title="Automação RAG" 
            value="43%" 
            change="Resolução automática" 
            icon={<BarChart3 className="w-5 h-5 text-indigo-500" />} 
          />
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
          
          {/* Main Chart */}
          <div className="lg:col-span-2 bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-zinc-100 mb-6 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-zinc-400" />
              Volume de Atendimentos
            </h3>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ticketVolumeData} margin={{ top: 5, right: 30, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="name" stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#52525b" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5' }}
                    itemStyle={{ color: '#818cf8' }}
                  />
                  <Bar dataKey="tickets" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="flex flex-col gap-6">
            {/* Speed Chart */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 flex-1">
              <h3 className="text-lg font-semibold text-zinc-100 mb-6 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-zinc-400" />
                Tempo de Resposta (h)
              </h3>
              <div className="h-[120px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={resolutionTimeData}>
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5' }}
                    />
                    <Line type="monotone" dataKey="tempo" stroke="#10b981" strokeWidth={3} dot={{ fill: '#10b981', r: 4, strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Source Chart */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 flex-1">
              <h3 className="text-lg font-semibold text-zinc-100 mb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-zinc-400" />
                Origem dos Contatos
              </h3>
              <div className="h-[120px] w-full flex items-center justify-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sourceData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={55}
                      paddingAngle={5}
                      dataKey="value"
                      stroke="none"
                    >
                      {sourceData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-center gap-4 mt-2">
                {sourceData.map((s, i) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                    <span className="text-xs text-zinc-400">{s.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, change, icon }: { title: string, value: string, change: string, icon: React.ReactNode }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 hover:bg-zinc-900/80 transition-colors">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-zinc-400">{title}</h3>
        <div className="p-2 bg-zinc-800/50 rounded-lg">
          {icon}
        </div>
      </div>
      <div>
        <p className="text-3xl font-bold text-white mb-1">{value}</p>
        <p className="text-xs text-zinc-500">{change}</p>
      </div>
    </div>
  );
}
