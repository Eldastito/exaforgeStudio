import React, { useState } from 'react';

type AvatarProps = {
  name?: string | null;
  src?: string | null;
  /** Diâmetro em pixels (default 40). */
  size?: number;
  /** Classes extras (ex.: borda). */
  className?: string;
};

// Paleta de cores sólidas, agradáveis sobre o tema escuro e com bom contraste
// para texto branco. A cor é escolhida de forma determinística pelo nome, então
// o mesmo contato sempre aparece com a mesma cor.
const COLORS = [
  '#e11d48', '#db2777', '#c026d3', '#9333ea', '#7c3aed', '#4f46e5',
  '#2563eb', '#0284c7', '#0891b2', '#0d9488', '#059669', '#16a34a',
  '#ca8a04', '#d97706', '#ea580c', '#dc2626',
];

function hashIndex(str: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

function getInitials(name?: string | null): string {
  const clean = (name || '').trim();
  if (!clean) return '?';
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Avatar do contato: mostra a foto quando disponível (e carregável) e, caso
 * contrário, exibe as iniciais do nome sobre uma cor determinística — bem mais
 * agradável que o antigo ícone cinza genérico.
 */
export function Avatar({ name, src, size = 40, className = '' }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const showImg = src && !errored;

  const dimension = { width: size, height: size };

  if (showImg) {
    return (
      <img
        src={src!}
        alt={name || ''}
        onError={() => setErrored(true)}
        style={dimension}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  const initials = getInitials(name);
  const bg = COLORS[hashIndex(name?.trim() || initials, COLORS.length)];

  return (
    <div
      aria-label={name || 'Contato'}
      style={{ ...dimension, backgroundColor: bg, fontSize: Math.max(11, Math.round(size * 0.4)) }}
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white ${className}`}
    >
      {initials}
    </div>
  );
}
