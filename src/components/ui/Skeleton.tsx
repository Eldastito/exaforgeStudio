import React from 'react';

/**
 * Bloco de carregamento com efeito shimmer. Use para montar placeholders que
 * imitam o layout final, evitando que a tela "pisque" vazia durante o fetch.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-zinc-800/70 ${className}`} />;
}
