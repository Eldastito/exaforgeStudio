import { useCallback, useEffect, useState } from 'react';

// ADR-154 F9.2 — tema claro/escuro do app FalaTu STANDALONE.
//
// Fonte única do estado do tema: a classe `.falatu-theme-light` no <html>
// (ver index.css) faz TODOS os tokens semânticos ft-* virarem via cascata —
// nenhum componente precisa saber a cor, só usar `bg-ft-surface`/`text-ft-text`.
//
// Escopo: roda apenas no bundle standalone (Auth/Shell montam o hook). O painel
// ZappFlow nunca importa isto e nunca recebe a classe → segue no escuro default.
//
// Primeiro acesso segue a PREFERÊNCIA DO SISTEMA (prefers-color-scheme): abre
// claro ou escuro conforme o aparelho. Assim que o usuário alterna pelo botão,
// a escolha explícita passa a mandar e persiste — o sistema só decide enquanto
// não há escolha salva. Sem sinal do sistema, o default é a marca (claro/Nuvem).

export type FalatuTheme = 'light' | 'dark';
const STORAGE_KEY = 'falatu_theme';
const THEME_COLOR: Record<FalatuTheme, string> = { light: '#f4f6fc', dark: '#0e1a2e' };

function systemPref(): FalatuTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readStored(): FalatuTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light') return v; // escolha explícita manda
    return systemPref();                          // 1º acesso: segue o aparelho
  } catch {
    return 'light';
  }
}

function apply(theme: FalatuTheme) {
  try {
    document.documentElement.classList.toggle('falatu-theme-light', theme === 'light');
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = THEME_COLOR[theme];
  } catch { /* cosmético — nunca derruba o app */ }
}

export function useFalatuTheme(): { theme: FalatuTheme; toggle: () => void; setTheme: (t: FalatuTheme) => void } {
  const [theme, setThemeState] = useState<FalatuTheme>(readStored);

  // Reaplica sempre que muda (e no mount) — mantém <html> e o theme-color em dia.
  useEffect(() => { apply(theme); }, [theme]);

  const setTheme = useCallback((t: FalatuTheme) => {
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* modo privado */ }
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => setTheme(theme === 'light' ? 'dark' : 'light'), [theme, setTheme]);

  return { theme, toggle, setTheme };
}
