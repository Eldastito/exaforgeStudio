import { useEffect, useRef, useState } from 'react';
import { Loader2, X, TriangleAlert } from 'lucide-react';

// Formatos 1D de etiqueta de varejo (EAN-13/8 do produto, Code128/ITF de
// etiqueta interna, UPC importado). QR fica de fora de propósito — etiqueta
// de peça não é QR e ler QR de cartaz/promo aqui só geraria bipe errado.
const FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'itf'];

type Props = {
  /** Chamado UMA vez com o código lido; o overlay se fecha sozinho. */
  onDetected: (code: string) => void;
  onClose: () => void;
  /** Texto de apoio embaixo da moldura (ex.: "Aponte para a etiqueta da peça"). */
  hint?: string;
};

/**
 * Overlay de leitura de código de barras pela CÂMERA do aparelho.
 *
 * Estratégia em 2 níveis (decidida em runtime, não em build):
 *  1. `BarcodeDetector` nativo (Chrome/Edge/Android — o hardware da loja) —
 *     zero custo de bundle e decodificação por hardware quando disponível;
 *  2. fallback ZXing via import dinâmico (Safari/iOS não tem o nativo) — o
 *     chunk só é baixado quando um aparelho sem suporte abre a câmera.
 *
 * Exige contexto seguro (HTTPS) — getUserMedia não existe em HTTP. Erros de
 * permissão/ausência de câmera não quebram o fluxo: o overlay mostra o aviso
 * e o campo de digitação/leitor físico continua funcionando por trás.
 */
export function BarcodeCameraScanner({ onDetected, onClose, hint }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let done = false;
    const cleanups: Array<() => void> = [];
    const stopAll = () => cleanups.splice(0).forEach((fn) => { try { fn(); } catch { /* noop */ } });

    const finish = (code: string) => {
      if (done || cancelled) return;
      done = true;
      try { (navigator as any).vibrate?.(80); } catch { /* sem vibração — ok */ }
      stopAll();
      onDetected(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStarting(false);
        setError('Este navegador não dá acesso à câmera (precisa de HTTPS). Digite o código ou use um leitor físico.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        cleanups.push(() => stream.getTracks().forEach((t) => t.stop()));
        if (cancelled) { stopAll(); return; }

        const video = videoRef.current;
        if (!video) { stopAll(); return; }
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stopAll(); return; }
        setStarting(false);

        const NativeDetector = (window as any).BarcodeDetector;
        let nativeFormats: string[] = [];
        if (NativeDetector?.getSupportedFormats) {
          try {
            const supported: string[] = await NativeDetector.getSupportedFormats();
            nativeFormats = FORMATS.filter((f) => supported.includes(f));
          } catch { nativeFormats = []; }
        }

        if (nativeFormats.length) {
          const detector = new NativeDetector({ formats: nativeFormats });
          const timer = setInterval(async () => {
            if (done || cancelled || video.readyState < 2) return;
            try {
              const codes = await detector.detect(video);
              const raw = codes?.[0]?.rawValue;
              if (raw) finish(String(raw));
            } catch { /* frame ruim — tenta o próximo */ }
          }, 200);
          cleanups.push(() => clearInterval(timer));
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (cancelled) { stopAll(); return; }
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoElement(video, (result) => {
            if (result) finish(result.getText());
          });
          cleanups.push(() => controls.stop());
        }
      } catch (e: any) {
        if (cancelled) return;
        setStarting(false);
        setError(
          e?.name === 'NotAllowedError'
            ? 'Permissão da câmera negada. Libere a câmera nas configurações do navegador e tente de novo.'
            : e?.name === 'NotFoundError'
              ? 'Nenhuma câmera encontrada neste aparelho. Digite o código ou use um leitor físico.'
              : 'Não consegui abrir a câmera. Digite o código ou use um leitor físico.'
        );
      }
    })();

    return () => { cancelled = true; stopAll(); };
    // onDetected/onClose estáveis por render do chamador — abrir 1x por montagem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black" onClick={onClose}>
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />

      {/* Moldura de mira */}
      {!error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="relative h-40 w-[78%] max-w-md rounded-2xl border-2 border-[var(--color-flow)] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]">
            <span className="absolute inset-x-4 top-1/2 h-0.5 -translate-y-1/2 animate-pulse bg-[var(--color-flow)]/80" />
          </div>
        </div>
      )}

      {starting && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--color-flow)]" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-amber-500/40 bg-zinc-950/90 p-6 text-center">
            <TriangleAlert className="h-8 w-8 text-amber-400" />
            <p className="text-sm text-zinc-200">{error}</p>
            <button onClick={onClose}
              className="mt-1 rounded-xl bg-[var(--color-flow)] px-5 py-2.5 text-sm font-semibold text-zinc-950">
              Voltar
            </button>
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4">
        <p className="text-sm font-semibold text-white drop-shadow">{hint || 'Aponte para o código de barras'}</p>
        <button onClick={onClose} title="Fechar"
          className="rounded-full bg-black/50 p-2.5 text-white backdrop-blur transition-colors hover:bg-black/70">
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
