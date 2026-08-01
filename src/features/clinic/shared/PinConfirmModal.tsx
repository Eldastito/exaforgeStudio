/**
 * PinConfirmModal — modal compartilhado para os 3 fluxos com PIN da
 * Jornada de Tratamento (ADR-146 D3): discharge (F52), reopen (F52),
 * issueGuide (F55). Reusa o lockout do backend F28 (`verifyPin` +
 * timingSafeEqual + 5 tentativas / 15min) — o modal só coleta PIN +
 * profissional e delega ao caller, mostrando `PIN_INVALID` /
 * `PIN_LOCKED` de volta.
 *
 * Contrato:
 *   - open: controla visibilidade (o pai gerencia o boolean).
 *   - title / message: cabeçalho + descrição contextual (ex.: "Alta do
 *     Sr. João da Silva na especialidade Psicologia").
 *   - professionals: lista pra o select (apenas nome+id — sem cor,
 *     sem badge, o modal é sóbrio).
 *   - defaultProfessionalId: pré-selecionado (útil pra usar o
 *     `primaryProfessionalId` do episódio como default).
 *   - onConfirm({professionalId, pin}) — Promise que resolve OK ou
 *     throw com error.message. Erros com prefixo "PIN_" viram inline.
 *   - onClose: fecha o modal (sem passar por onConfirm).
 *   - confirmLabel (opcional): "Confirmar alta", "Confirmar reabertura",
 *     "Assinar guia". Default: "Confirmar".
 *   - danger (opcional): pinta o botão de vermelho (padrão pra alta e
 *     cancelamento).
 *   - children (opcional): campos extras renderizados ANTES do PIN
 *     (ex.: <select dischargeType>, <textarea summary>). O caller
 *     gerencia o state desses extras — o modal só encapsula PIN.
 *
 * Guardrail: nunca chama endpoint sozinho. Recepção clica → modal
 * confirma → caller faz o POST. Assim o backend continua sendo a
 * fonte da verdade do lockout.
 */
import React, { useState, useEffect } from 'react';
import { X, Loader2, KeyRound, AlertTriangle } from 'lucide-react';
import { Button } from '@/src/components/ui/button';

export type PinModalProfessional = { id: string; name: string };

type Props = {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  professionals: PinModalProfessional[];
  defaultProfessionalId?: string | null;
  confirmLabel?: string;
  danger?: boolean;
  children?: React.ReactNode;
  onConfirm: (input: { professionalId: string; pin: string }) => Promise<void>;
  onClose: () => void;
};

export default function PinConfirmModal(props: Props) {
  const {
    open, title, message, professionals,
    defaultProfessionalId, confirmLabel, danger, children,
    onConfirm, onClose,
  } = props;

  const [professionalId, setProfessionalId] = useState<string>(defaultProfessionalId || '');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reseta ao abrir/fechar.
  useEffect(() => {
    if (open) {
      setProfessionalId(defaultProfessionalId || '');
      setPin('');
      setError(null);
      setBusy(false);
    }
  }, [open, defaultProfessionalId]);

  if (!open) return null;

  const submit = async () => {
    if (!professionalId) { setError('Selecione o profissional responsável.'); return; }
    if (!pin || pin.length < 4) { setError('Informe o PIN (mínimo 4 dígitos).'); return; }
    setError(null);
    setBusy(true);
    try {
      await onConfirm({ professionalId, pin });
      // Pai deve fechar via onClose após sucesso — não fechamos aqui pra
      // deixar o pai controlar (ex.: mostrar toast antes).
    } catch (e: any) {
      setError(e?.message || 'Falha ao confirmar.');
      setPin(''); // limpa PIN após erro pra evitar re-envio acidental
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <KeyRound className={`w-4 h-4 ${danger ? 'text-rose-400' : 'text-emerald-400'}`} />
              {title}
            </h3>
            {message && <p className="text-xs text-zinc-400 mt-1">{message}</p>}
          </div>
          <button onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 shrink-0"
            aria-label="Fechar">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {children}

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Profissional responsável</span>
            <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">— selecione —</option>
              {professionals.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">PIN de assinatura</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="••••"
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 tracking-widest"
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
            <span className="text-[10px] text-zinc-600 mt-0.5">
              O sistema bloqueia após 5 tentativas erradas em 15 minutos (padrão CFM/LGPD).
            </span>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} disabled={busy}
            className="h-8 px-3 text-xs text-zinc-300 hover:text-zinc-100 disabled:opacity-60">
            Cancelar
          </button>
          <Button onClick={submit} disabled={busy}
            className={`h-8 px-3 text-xs text-white ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}>
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
            {confirmLabel || 'Confirmar'}
          </Button>
        </div>
      </div>
    </div>
  );
}
