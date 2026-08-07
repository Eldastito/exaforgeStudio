// ADR-154 F9.1 — identidade visual oficial do Fala Tu no app standalone.
//
// Fatia puramente de frontend/marca: o gate real é o tsc (npm run lint) + o
// build. Este teste trava os INVARIANTES estáticos da marca que um refactor
// futuro poderia quebrar sem o compilador reclamar:
//   - assets de marca existem (SVG + PNGs) com a paleta oficial;
//   - manifest do Fala Tu tem nome/tema/ícones corretos;
//   - tokens --color-ft-* existem no index.css;
//   - as superfícies standalone consomem o <FalatuLogo> (e largaram o
//     placeholder Smartphone);
//   - SEPARAÇÃO da ZappFlow preservada: o index.html compartilhado continua
//     ZappFlow (a marca Fala Tu é aplicada em runtime, só no subdomínio).
//
// Sem DB, sem rede — só leitura de arquivos do repo.

import fs from 'node:fs';
import path from 'node:path';

// npm run executa a partir da raiz do repo.
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(root, p));

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures++;
}

// Paleta oficial (Brand Book v1.0).
const COBALTO = '#3b4de0';
const CORAL = '#ff6a4d';
const MENTA = '#12b981';
const INK = '#0e1a2e';
const NUVEM = '#f4f6fc';

// 1) Ícone SVG do "Ciclo Inteligente" com a paleta oficial.
const iconSvg = exists('public/falatu-brand/icon.svg') ? read('public/falatu-brand/icon.svg').toLowerCase() : '';
check('icon.svg existe', iconSvg.length > 0);
check('icon.svg usa Cobalto', iconSvg.includes(COBALTO));
check('icon.svg usa Coral', iconSvg.includes(CORAL));
check('icon.svg usa Menta', iconSvg.includes(MENTA));
check('icon.svg usa tile Ink', iconSvg.includes(INK));
check('icon.svg tem o check (path do checkmark)', iconSvg.includes('m179 266'));

// 2) PNGs de app/PWA rasterizados e válidos (magic bytes PNG + tamanho real).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
for (const [file, min] of [
  ['public/falatu-brand/icon-192.png', 2000],
  ['public/falatu-brand/icon-512.png', 5000],
  ['public/falatu-brand/apple-touch-icon.png', 2000],
] as const) {
  const ok = exists(file);
  const buf = ok ? fs.readFileSync(path.join(root, file)) : Buffer.alloc(0);
  check(`${file} é PNG válido (${buf.length}B)`, ok && buf.length >= min && buf.subarray(0, 4).equals(PNG_MAGIC));
}

// 3) Manifest do Fala Tu — nome/tema/ícones oficiais.
let manifest: any = {};
try { manifest = JSON.parse(read('public/falatu.webmanifest')); } catch { /* fica {} → falha abaixo */ }
check('manifest.name === "Fala Tu"', manifest.name === 'Fala Tu');
check('manifest.theme_color === Ink', String(manifest.theme_color).toLowerCase() === INK);
check('manifest.background_color === Ink', String(manifest.background_color).toLowerCase() === INK);
check(
  'manifest: todos os ícones apontam pra /falatu-brand/',
  Array.isArray(manifest.icons) && manifest.icons.length >= 2 &&
    manifest.icons.every((i: any) => typeof i.src === 'string' && i.src.startsWith('/falatu-brand/')),
);
check('manifest mantém o share_target (F8.5 não regrediu)', !!manifest.share_target?.action);

// 4) Tokens --color-ft-* no design system.
const css = read('src/index.css').toLowerCase();
for (const [name, hex] of [
  ['--color-ft-cobalto', COBALTO], ['--color-ft-coral', CORAL],
  ['--color-ft-menta', MENTA], ['--color-ft-ink', INK], ['--color-ft-nuvem', NUVEM],
] as const) {
  check(`index.css define ${name} = ${hex}`, css.includes(`${name}: ${hex}`));
}

// 5) Componente de logo único e reutilizável.
const logo = exists('src/components/brand/FalatuLogo.tsx') ? read('src/components/brand/FalatuLogo.tsx') : '';
check('FalatuLogo.tsx existe', logo.length > 0);
check('FalatuLogo usa tokens --color-ft-*', logo.includes('var(--color-ft-cobalto)') && logo.includes('var(--color-ft-menta)'));
check('FalatuLogo renderiza o wordmark "Fala Tu"', /Fala(&nbsp;|\s)?Tu/.test(logo));

// 6) Superfícies standalone consomem o logo (e largaram o Smartphone placeholder).
const appTsx = read('src/falatu-app/FalatuApp.tsx');
const authTsx = read('src/falatu-app/FalatuAuth.tsx');
check('FalatuApp importa FalatuLogo', appTsx.includes("brand/FalatuLogo"));
check('FalatuAuth importa FalatuLogo', authTsx.includes("brand/FalatuLogo"));
check('FalatuApp largou o ícone Smartphone (placeholder)', !appTsx.includes('Smartphone'));
check('FalatuAuth largou o ícone Smartphone (placeholder)', !authTsx.includes('Smartphone'));
check('FalatuApp aplica branding de documento em runtime', appTsx.includes('applyFalatuDocumentBrand'));
check('FalatuApp aponta o manifest do Fala Tu', appTsx.includes('/falatu.webmanifest'));

// 7) Hero do inbox limpo mostra o logo oficial.
const viewTsx = read('src/features/FalaTuView.tsx');
check('FalaTuView (hero) usa FalatuLogo', viewTsx.includes('brand/FalatuLogo') && viewTsx.includes('<FalatuLogo'));

// 8) SEPARAÇÃO ZappFlow ↔ Fala Tu — o HTML compartilhado continua ZappFlow.
const html = read('index.html');
check('index.html compartilhado permanece ZappFlow (marca Fala Tu é só runtime)', html.includes('<title>ZappFlow</title>'));

console.log(failures === 0 ? '\nOK — 100% PASS' : `\nFALHOU — ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
