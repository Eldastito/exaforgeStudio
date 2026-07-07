/// <reference types="vite/client" />

// SVG importado como URL string (padrão do Vite):
//   import myUrl from "./x.svg";
// Necessário porque o tsconfig não referencia vite/client automaticamente.
declare module "*.svg" {
  const src: string;
  export default src;
}
