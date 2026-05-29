import React, { useState, useEffect } from 'react';
import { useStore } from '@/src/store/useStore';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { BarChart3, TrendingUp, Users, Clock, MessageSquare, Briefcase, Download, ArrowRightCircle } from 'lucide-react';
import { Button } from '@/src/components/ui/button';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444']; // primary, emerald, amber, red

export function DashboardPanel() {
  const [metrics, setMetrics] = useState<any>(null);
  const [period, setPeriod] = useState("month");
  const [loadingPdf, setLoadingPdf] = useState(false);

  useEffect(() => {
    fetch(`/api/analytics/metrics?period=${period}`)
      .then(res => res.json())
      .then(data => setMetrics(data))
      .catch(console.error);
  }, [period]);

  const handleDownloadPdf = async () => {
    setLoadingPdf(true);
    try {
      const res = await fetch('/api/analytics/reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'gerencial', period })
      });
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `relatorio_gerencial_${new Date().toISOString()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('Erro ao gerar relatório');
    } finally {
      setLoadingPdf(false);
    }
  };

  if (!metrics) {
    return <div className="flex-1 p-8 text-zinc-400">Carregando métricas...</div>;
  }

  // Fallback charts if no data
  const ticketVolumeData = metrics.chartData?.length > 0 ? metrics.chartData : [
    { name: 'Nenhum', tickets: 0 }
  ];

  const sourceData = metrics.channelData?.length > 0 ? metrics.channelData.map((c: any) => ({
    name: c.channel_id, value: c.count
  })) : [
    { name: 'Sem dados', value: 1 }
  ];

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 overflow-y-auto w-full relative">
      <div className="p-8 max-w-7xl mx-auto w-full space-y-8">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Visão Geral</h2>
            <p className="text-sm text-slate-400">Métricas de atendimento, conversões e agendamentos.</p>
          </div>
          <div className="flex gap-4">
            <select 
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm rounded-lg px-3 py-2 outline-none focus:border-indigo-500 transition-colors"
            >
              <option value="today">Hoje</option>
              <option value="week">Últimos 7 dias</option>
              <option value="month">Últimos 30 dias</option>
              <option value="all">Todo o período</option>
            </select>
            <Button onClick={handleDownloadPdf} disabled={loadingPdf} className="bg-fuchsia-600 hover:bg-fuchsia-700 text-white">
              <Download className="w-4 h-4 mr-2" />
              {loadingPdf ? 'Gerando PDF...' : 'Exportar PDF'}
            </Button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard 
            title="Total de Tickets" 
            value={metrics.totalTickets?.toString() || "0"} 
            change={`Filtro: ${period}`} 
            icon={<Briefcase className="w-5 h-5" />} 
          />
          <StatCard 
            title="Novos Leads" 
            value={metrics.newLeadsCount?.toString() || "0"} 
            change="Contatos Iniciais" 
            icon={<Users className="w-5 h-5 text-emerald-500" />} 
          />
          <StatCard 
            title="Vendas / Conversão" 
            value={metrics.salesCount?.toString() || "0"} 
            change="Tickets concluídos" 
            icon={<BarChart3 className="w-5 h-5 text-amber-500" />} 
          />
          <StatCard 
            title="Sessões IA" 
            value={metrics.aiResponseCount?.toString() || "0"} 
            change="Respostas Geradas" 
            icon={<MessageSquare className="w-5 h-5 text-fuchsia-500" />} 
          />
          <StatCard 
            title="Tempo Médio Resposta (IA)" 
            value={`${metrics.averageFirstResponseTime || 0}s`} 
            change="Média estimada" 
            icon={<Clock className="w-5 h-5 text-indigo-500" />} 
          />
          <StatCard 
            title="Taxa de Resolução IA" 
            value={`${metrics.resolutionRateAI || 0}%`} 
            change="Sucesso estimado" 
            icon={<ArrowRightCircle className="w-5 h-5 text-emerald-500" />} 
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
              <h3 className="text-lg font-semibold text-zinc-100 mb-2 flex items-center gap-2">
                <Clock className="w-4 h-4 text-zinc-400" />
                Agendamentos / Status
              </h3>
              <div className="flex flex-col justify-center items-center h-full pb-4">
                 <p className="text-4xl font-bold text-white mb-2">{metrics.appointmentCount}</p>
                 <p className="text-sm text-zinc-400 uppercase tracking-wider font-semibold">Agendamentos Válidos</p>
              </div>
            </div>

            {/* Source Chart */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 flex-1 hover:bg-zinc-900/80 transition-colors">
              <h3 className="text-lg font-semibold text-zinc-100 mb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-zinc-400" />
                Canais de Origem
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
                      {sourceData.map((entry: any, index: number) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', color: '#f4f4f5' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-center gap-4 mt-2 flex-wrap">
                {sourceData.map((s: any, i: number) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                    <span className="text-xs text-zinc-400 max-w-[80px] truncate">{s.name}</span>
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

