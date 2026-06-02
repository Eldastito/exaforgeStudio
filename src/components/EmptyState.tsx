import React from 'react';
import { Button } from '@/src/components/ui/button';

/**
 * Estado vazio orientativo: ícone, título, descrição e (opcional) uma ação
 * que leva o usuário ao próximo passo. Usado nas telas sem dados ainda.
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center text-center py-14 px-6 border border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/60 border border-zinc-700/60 text-zinc-400 mb-4">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
      {description && <p className="text-sm text-zinc-500 mt-1.5 max-w-md">{description}</p>}
      {actionLabel && onAction && (
        <Button onClick={onAction} className="mt-5 bg-indigo-600 hover:bg-indigo-700 text-white">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
