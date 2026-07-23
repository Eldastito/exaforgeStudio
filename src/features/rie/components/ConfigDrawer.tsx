import React, { useEffect, useState } from 'react';
import { X, Save, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

interface Cfg {
  prob_lead_slow_response: number;
  prob_quote_no_response: number;
  prob_abandoned: number;
  prob_inactive: number;
  slow_response_seconds: number;
  quote_stale_hours: number;
  inactive_days: number;
  attribution_window_days: number;
  custom_ticket_amount: number | null;
  weight_atendimento: number;
  weight_comercial: number;
  weight_operacional: number;
  sla_by_channel: Record<string, number>;
}

/**
 * Drawer de calibração da engine do RIC. Reforça a mensagem central: "estes
 * números são seus, ajuste-os". Salvar recarrega o snapshot (onSaved).
 */
export function ConfigDrawer({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    apiFetch('/api/analytics/revenue-intelligence/config')
      .then(r => r.json())
      .then(setCfg)
      .catch(() => setCfg(null));
    // Canais da organização — para o SLA por canal (ADR-026); falha só
    // esconde a seção, nunca quebra o drawer.
    apiFetch('/api/channels')
      .then(r => r.json())
      .then(d => setChannels(Array.isArray(d) ? d.map((c: any) => ({ id: c.id, name: c.name || c.identifier || c.provider })) : []))
      .catch(() => setChannels([]));
  }, [open]);

  const set = (k: keyof Cfg, v: number | null) => setCfg(c => (c ? { ...c, [k]: v } : c));

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      await apiFetch('/api/analytics/revenue-intelligence/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      onSaved();
      onClose();
    } catch { /* noop */ } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  const weightSum = cfg ? cfg.weight_atendimento + cfg.weight_comercial + cfg.weight_operacional : 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-ric-border bg-ric-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-ric-border p-5">
          <div>
            <h3 className="text-base font-bold text-slate-100">Calibrar a fórmula</h3>
            <p className="text-xs text-slate-500">Estes números são seus. Ajuste para a sua realidade.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200"><X className="h-5 w-5" /></button>
        </div>

        {!cfg ? (
          <div className="flex flex-1 items-center justify-center text-slate-500">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="custom-scroll flex-1 overflow-y-auto p-5">
            <Group title="Probabilidade de perda">
              <Pct label="Lead com 1ª resposta lenta" value={cfg.prob_lead_slow_response} onChange={v => set('prob_lead_slow_response', v)} />
              <Pct label="Orçamento sem retorno" value={cfg.prob_quote_no_response} onChange={v => set('prob_quote_no_response', v)} />
              <Pct label="Conversa abandonada" value={cfg.prob_abandoned} onChange={v => set('prob_abandoned', v)} />
              <Pct label="Cliente inativo" value={cfg.prob_inactive} onChange={v => set('prob_inactive', v)} />
            </Group>

            <Group title="Janelas">
              <Num label="1ª resposta lenta acima de (s)" value={cfg.slow_response_seconds} onChange={v => set('slow_response_seconds', v)} />
              <Num label="Orçamento parado após (h)" value={cfg.quote_stale_hours} onChange={v => set('quote_stale_hours', v)} />
              <Num label="Cliente inativo após (dias)" value={cfg.inactive_days} onChange={v => set('inactive_days', v)} />
              <Num label="Janela de atribuição do RRI (dias)" value={cfg.attribution_window_days} onChange={v => set('attribution_window_days', v)} />
            </Group>

            {channels.length > 0 && (
              <Group title="SLA por canal (s) — vazio herda o padrão acima">
                {channels.map((ch) => (
                  <div key={ch.id}>
                    <Num
                      label={ch.name}
                      value={cfg.sla_by_channel?.[ch.id] ?? 0}
                      onChange={(v) => setCfg((c) => {
                        if (!c) return c;
                        const next = { ...(c.sla_by_channel || {}) };
                        if (v > 0) next[ch.id] = v; else delete next[ch.id];
                        return { ...c, sla_by_channel: next };
                      })}
                    />
                  </div>
                ))}
              </Group>
            )}

            <Group title="Ticket médio">
              <Num
                label="Override (R$) — vazio = média histórica"
                value={cfg.custom_ticket_amount ?? 0}
                onChange={v => set('custom_ticket_amount', v > 0 ? v : null)}
              />
            </Group>

            <Group title={`Pesos do IQR (soma ${weightSum})`}>
              <Num label="Atendimento" value={cfg.weight_atendimento} onChange={v => set('weight_atendimento', v)} />
              <Num label="Comercial" value={cfg.weight_comercial} onChange={v => set('weight_comercial', v)} />
              <Num label="Operacional" value={cfg.weight_operacional} onChange={v => set('weight_operacional', v)} />
              {weightSum !== 100 && (
                <p className="text-[11px] text-amber-400">Os pesos são normalizados; somar 100 deixa a leitura mais clara.</p>
              )}
            </Group>
          </div>
        )}

        <div className="border-t border-ric-border p-5">
          <button
            onClick={save}
            disabled={saving || !cfg}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-ric-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-ric-primary-2 disabled:opacity-50"
          >
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Salvar e recalcular
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex-1 text-[12px] text-slate-300">{label}</label>
      {children}
    </div>
  );
}

// Input de porcentagem (mostra 0-100, guarda 0-1).
function Pct({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-1">
        <input
          type="number" min={0} max={100}
          value={Math.round(value * 100)}
          onChange={e => onChange(Math.max(0, Math.min(100, Number(e.target.value))) / 100)}
          className="w-20 rounded-md border border-ric-border bg-ric-surface px-2 py-1 text-right text-[12px] text-slate-100 outline-none focus:border-ric-primary-2"
        />
        <span className="text-[11px] text-slate-500">%</span>
      </div>
    </Row>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Row label={label}>
      <input
        type="number" min={0}
        value={value}
        onChange={e => onChange(Math.max(0, Number(e.target.value)))}
        className="w-24 rounded-md border border-ric-border bg-ric-surface px-2 py-1 text-right text-[12px] text-slate-100 outline-none focus:border-ric-primary-2"
      />
    </Row>
  );
}
