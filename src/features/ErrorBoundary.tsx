// @ts-nocheck — o projeto não tem @types/react instalado; class components não
// conseguem tipar a base Component (props/setState). O componente é simples e
// correto em runtime; o build (vite/esbuild) o compila normalmente.
import React, { Component } from "react";

/**
 * Captura erros de render de uma view e mostra uma mensagem em vez de derrubar
 * o app inteiro (tela em branco). A navegação (sidebar/topo) continua funcionando,
 * e o erro real fica visível para diagnóstico.
 *
 * `resetKey` (ex.: o viewMode atual) faz o boundary se resetar ao trocar de tela.
 */
type Props = { children: React.ReactNode; resetKey?: any };
type State = { error: Error | null };

export class ErrorBoundary extends Component<any, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error("[ErrorBoundary] Erro ao renderizar a tela:", error, info);
  }

  componentDidUpdate(prev: any) {
    // Ao mudar de tela, limpa o erro para tentar renderizar a nova.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-center">
            <p className="text-lg font-semibold text-rose-300">Ops, esta tela teve um problema</p>
            <p className="text-sm text-zinc-400 mt-2">
              O restante do sistema continua funcionando — use o menu para navegar. Se persistir, envie o detalhe abaixo ao suporte.
            </p>
            <pre className="mt-4 text-left text-[11px] text-rose-200/80 bg-zinc-950 border border-zinc-800 rounded p-3 overflow-auto max-h-40 whitespace-pre-wrap">
              {String(this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 text-xs px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 hover:bg-zinc-700"
            >Tentar de novo</button>
          </div>
        </div>
      );
    }
    return this.props.children as React.ReactElement;
  }
}
