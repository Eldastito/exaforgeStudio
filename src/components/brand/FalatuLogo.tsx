import React from 'react';

// Marca oficial Fala Tu (Brand Book v1.0, ADR-154 F9.1) — componente único de
// logo pro app STANDALONE. Distinta da ZappFlow por construção: usa só os
// tokens --color-ft-* (nunca os --color-zf-*/--color-flow) e vive fora de
// qualquer chrome da suíte.
//
// "Ciclo Inteligente": anel Cobalto (marca-mãe) → Coral (ação/energia) →
// Menta (conclusão/confiança) com o check no centro — o ciclo "falar → agir →
// conferir" que É o produto. A geometria (raio 150, arcos, check) é a MESMA do
// public/falatu-brand/icon.svg: mudar um, mudar o outro.
//
// Uma fonte de verdade pro símbolo: header do Shell, tela de auth e o "herói"
// do inbox limpo importam este componente — nunca redesenham o SVG à mão.

export interface FalatuLogoProps {
  /** Lado do símbolo em px (o wordmark escala junto). */
  size?: number;
  /** Mostra o wordmark "Fala Tu" ao lado do símbolo. */
  withWordmark?: boolean;
  /** Mostra a tagline "Do pensamento para a vida." sob o wordmark. */
  withTagline?: boolean;
  /** Desenha o tile Ink arredondado atrás do anel (estilo ícone de app). */
  tile?: boolean;
  className?: string;
  /** Rótulo acessível do símbolo isolado (default "Fala Tu"). */
  title?: string;
}

// Símbolo puro (anel + check). O anel (marca) é fixo. O check adapta ao FUNDO:
// com tile, fica sempre sobre Ink → Nuvem; sem tile (header/hero), segue o texto
// do tema (--color-ft-text) pra não sumir no claro. Idem o tile: usa Ink no
// escuro, mas no tema claro o Ink continua valendo como fundo do ícone (o
// ícone é sempre "app icon" escuro, mesmo no app claro — igual ao favicon).
function Mark({ size = 40, tile = false, title = 'Fala Tu' }: { size?: number; tile?: boolean; title?: string }) {
  const check = tile ? '#f4f6fc' : 'var(--color-ft-text)';
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label={title}>
      {tile && <rect x="16" y="16" width="480" height="480" rx="116" fill="#0e1a2e" />}
      <g fill="none" strokeWidth={44} strokeLinecap="round">
        <path d="M370.9 352.4 A 150 150 0 0 1 141.1 352.4" stroke="var(--color-ft-menta)" />
        <path d="M115.1 307.3 A 150 150 0 0 1 229.9 108.3" stroke="var(--color-ft-cobalto)" />
        <path d="M282.1 108.3 A 150 150 0 0 1 396.9 307.3" stroke="var(--color-ft-coral)" />
      </g>
      <path d="M179 266 L236 323 L348 195" fill="none" stroke={check}
        strokeWidth={46} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FalatuLogo({
  size = 40,
  withWordmark = false,
  withTagline = false,
  tile = false,
  className = '',
  title = 'Fala Tu',
}: FalatuLogoProps) {
  if (!withWordmark && !withTagline) {
    return <span className={className}><Mark size={size} tile={tile} title={title} /></span>;
  }
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <Mark size={size} tile={tile} title={title} />
      <span className="flex flex-col leading-none">
        <span
          className="font-semibold tracking-tight"
          style={{ fontFamily: 'var(--font-sans)', fontSize: size * 0.62, color: 'var(--color-ft-text)' }}
        >
          Fala&nbsp;Tu
        </span>
        {withTagline && (
          <span
            className="uppercase tracking-[0.14em] mt-1"
            style={{ fontSize: Math.max(9, size * 0.19), color: 'var(--color-ft-cobalto)', fontWeight: 700 }}
          >
            Do pensamento para a vida.
          </span>
        )}
      </span>
    </span>
  );
}
