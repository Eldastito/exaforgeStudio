// Tipos do snapshot do Revenue Intelligence (espelham RevenueIntelligenceService).
export type RicPeriod = 'today' | 'week' | 'month' | 'all';

export interface RicDriver {
  score: number;
  breakdown: Record<string, number>;
}

export interface RicLossSource {
  key: string;
  label: string;
  count: number;
  prob: number;
  recoverable: boolean;
  amount: number;
}

export interface RicRecoveredSource {
  key: string;
  label: string;
  orders: number;
  amount: number;
}

export interface RicSnapshot {
  period: RicPeriod;
  iqr: {
    score: number;
    weights: { atendimento: number; comercial: number; operacional: number };
    weakestDriver: 'atendimento' | 'comercial' | 'operacional';
    narrative: string;
  };
  drivers: {
    atendimento: RicDriver;
    comercial: RicDriver;
    operacional: RicDriver;
  };
  money: {
    estimatedLoss: number;
    recoverable: number;
    recovered: number;
    ticket: { value: number; source: 'custom' | 'history' | 'fallback' };
    formula: string;
  };
  lossSources: RicLossSource[];
  recoveredSources: RicRecoveredSource[];
  attributionWindowDays: number;
  config: Record<string, number | null>;
}
