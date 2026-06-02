import { motion } from 'motion/react';
import { Sun, Moon } from 'lucide-react';
import type { Mode } from './types';
import { hexToRgba } from './utils';

interface Props {
  mode: Mode;
  accent: string;
  onToggle: () => void;
}

// Cápsula fosca sol/lua que inverte o tema da página inteira.
export function ThemeToggle({ mode, accent, onToggle }: Props) {
  const night = mode === 'night';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={night}
      aria-label="Alternar dia e noite"
      onClick={onToggle}
      className={[
        'relative flex h-10 w-[76px] items-center rounded-full border p-1 backdrop-blur-xl transition-colors',
        night ? 'border-white/15 bg-white/10' : 'border-white/70 bg-white/50',
      ].join(' ')}
      style={{ boxShadow: `0 0 18px ${hexToRgba(accent, night ? 0.35 : 0.2)}` }}
    >
      <span className="pointer-events-none absolute left-2 text-amber-400">
        <Sun className="h-4 w-4" style={{ opacity: night ? 0.3 : 1 }} />
      </span>
      <span className="pointer-events-none absolute right-2 text-indigo-300">
        <Moon className="h-4 w-4" style={{ opacity: night ? 1 : 0.3 }} />
      </span>
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        className="z-10 grid h-8 w-8 place-items-center rounded-full text-white shadow-lg"
        style={{
          marginLeft: night ? 36 : 0,
          backgroundColor: accent,
        }}
      >
        {night ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      </motion.span>
    </button>
  );
}
