import type { ChosenOption, Product, SaleOptions } from './types';

// Formatação de moeda em BRL (R$ x,xx).
export function formatBRL(value: number, currency = 'BRL'): string {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: currency || 'BRL',
    }).format(value);
  } catch {
    return `R$ ${value.toFixed(2).replace('.', ',')}`;
  }
}

// Defaults sensatos quando sale_options vem vazio.
export function getSizes(opts: SaleOptions): string[] {
  return opts.sizes && opts.sizes.length ? opts.sizes : ['P', 'M', 'G', 'GG'];
}

export function getWeightSteps(opts: SaleOptions): number[] {
  return opts.steps && opts.steps.length ? opts.steps : [100, 250, 500, 1000];
}

export function getVolumeSteps(opts: SaleOptions): number[] {
  return opts.steps && opts.steps.length ? opts.steps : [250, 500, 1000];
}

// Rótulo amigável para gramas (g/kg).
export function gramsLabel(grams: number): string {
  if (grams >= 1000) {
    const kg = grams / 1000;
    return `${Number.isInteger(kg) ? kg : kg.toFixed(2).replace('.', ',')} kg`;
  }
  return `${grams} g`;
}

// Rótulo amigável para ml (ml/L).
export function mlLabel(ml: number): string {
  if (ml >= 1000) {
    const l = ml / 1000;
    return `${Number.isInteger(l) ? l : l.toFixed(2).replace('.', ',')} L`;
  }
  return `${ml} ml`;
}

// Preço "por unidade" exibido no card / modal.
export function unitPriceLabel(p: Product): string {
  const base = formatBRL(p.price, p.currency);
  if (p.sale_mode === 'weight') return `${base}/kg`;
  if (p.sale_mode === 'volume') return `${base}/L`;
  if (p.sale_mode === 'slice') return `${base}/fatia`;
  return base;
}

// Preço efetivo de uma linha dado o produto e a opção escolhida.
export function computeUnitPrice(p: Product, option: ChosenOption): number {
  if (!option) return p.price;
  if (option.type === 'weight') return p.price * (option.grams / 1000);
  if (option.type === 'volume') return p.price * (option.ml / 1000);
  return p.price; // size não altera o preço base
}

// Rótulo da opção escolhida, para exibir no carrinho.
export function optionLabel(p: Product, option: ChosenOption): string {
  if (!option) return 'Unidade';
  if (option.type === 'size') return `Tamanho ${option.value}`;
  if (option.type === 'weight') return gramsLabel(option.grams);
  if (option.type === 'volume') return mlLabel(option.ml);
  return 'Unidade';
}

// Chave estável por produto + opção (para agrupar variações no carrinho).
export function cartKey(productId: string, option: ChosenOption): string {
  if (!option) return `${productId}:unit`;
  if (option.type === 'size') return `${productId}:size:${option.value}`;
  if (option.type === 'weight') return `${productId}:weight:${option.grams}`;
  if (option.type === 'volume') return `${productId}:volume:${option.ml}`;
  return `${productId}:unit`;
}

// Util de localStorage tolerante a falhas.
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
}

// Converte hex (#rrggbb) para rgba com alpha — usado em glows/borders.
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const int = parseInt(h, 16);
  if (Number.isNaN(int) || h.length !== 6) return `rgba(99,102,241,${alpha})`;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
