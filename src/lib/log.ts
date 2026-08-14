/**
 * devLog — logger de desenvolvimento (SEC-F12 / achado FE4).
 *
 * A auditoria de frontend achou `console.log` da mensagem WebSocket INTEIRA (telefone = PII +
 * corpo da mensagem) rodando também em PRODUÇÃO — qualquer pessoa com o console aberto via
 * dados de contato de outros. `devLog` só emite em DEV; em produção vira no-op, então nenhum
 * dado sensível aterrissa no console do navegador do cliente.
 *
 * Use `devLog` para diagnósticos de desenvolvimento; use `console.error`/`console.warn`
 * diretamente (sem PII) quando o alerta precisar aparecer em produção.
 */
const IS_PROD = typeof import.meta !== "undefined" && !!(import.meta as any).env?.PROD;

export function devLog(...args: unknown[]): void {
  if (IS_PROD) return;
  // eslint-disable-next-line no-console
  console.log(...args);
}
