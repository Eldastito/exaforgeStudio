import { useEffect, useState } from 'react';
import { Radar, CheckCircle2, Plug } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import type { RicPeriod } from '../types';
import { ExportAuditButton } from './ExportAuditButton';

interface Trial {
  status: 'not_started' | 'active' | 'completed';
  totalDays: number;
  day: number;
  daysRemaining: number;
  pct: number;
  startedAt: string | null;
}

/**
 * Banner da auditoria-trial de 14 dias (GTM). Mostra o progresso "dia X de 14"
 * enquanto o trial roda e destaca a entrega do relatório ao concluir. Início do
 * relógio = conexão do 1º canal (conecta → mede ao vivo → entrega o relatório).
 */
export function TrialBanner({ period }: { period: RicPeriod }) {
  const [trial, setTrial] = useState<Trial | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/analytics/revenue-intelligence/trial')
      .then(r => r.json())
      .then(d => { if (alive) setTrial(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!trial) return null;

  // Ainda não conectou canal: convida a iniciar a auditoria ao vivo.
  if (trial.status === 'not_started') {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-ric-card border border-ric-ai/30 bg-ric-ai/10 p-4">
        <Plug className="h-5 w-5 flex-shrink-0 text-ric-ai" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-100">Sua auditoria ao vivo de 14 dias começa quando você conectar um canal.</p>
          <p className="text-xs text-slate-400">Conecte o WhatsApp em "Canais e I.A." — a partir daí medimos tudo automaticamente.</p>
        </div>
      </div>
    );
  }

  // Concluída: relatório pronto.
  if (trial.status === 'completed') {
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-ric-card border p-4 sm:flex-row sm:items-center" style={{ borderColor: '#36e39a55', backgroundColor: '#36e39a12' }}>
        <CheckCircle2 className="h-5 w-5 flex-shrink-0" style={{ color: '#36e39a' }} />
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-100">Auditoria de 14 dias concluída — seu relatório está pronto.</p>
          <p className="text-xs text-slate-400">Baixe o relatório completo (10 seções + plano 30/60/90) para apresentar os resultados.</p>
        </div>
        <ExportAuditButton period={period} />
      </div>
    );
  }

  // Em andamento: progresso dia X de 14.
  return (
    <div className="mt-6 rounded-ric-card border border-ric-ai/30 bg-ric-ai/10 p-4">
      <div className="flex items-center gap-3">
        <Radar className="h-5 w-5 flex-shrink-0 text-ric-ai" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-100">
            Auditoria ao vivo · Dia {trial.day} de {trial.totalDays}
          </p>
          <p className="text-xs text-slate-400">
            {trial.daysRemaining > 0
              ? `Faltam ${trial.daysRemaining} dia(s) — o relatório fica mais rico a cada dia. Você já pode exportar o parcial.`
              : 'Último dia — gere seu relatório.'}
          </p>
        </div>
        <span className="text-2xl font-bold tabular-nums text-ric-ai">{trial.pct}%</span>
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ric-border">
        <div
          className="h-full rounded-full"
          style={{ width: `${trial.pct}%`, backgroundColor: '#29d3ff', transition: 'width 700ms cubic-bezier(0.22,1,0.36,1)' }}
        />
      </div>
    </div>
  );
}
