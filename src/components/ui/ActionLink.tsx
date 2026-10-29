import type { ReactNode } from 'react';

// Texto de aviso que leva o usuário direto ao lugar do acerto (ver src/lib/actionLinks.ts).
export function ActionLink({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" onClick={onClick} title={title || 'Ir direto para o campo'} className="underline underline-offset-2 decoration-dotted font-medium text-amber-100 hover:text-white">
      {children}
    </button>
  );
}
