import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message?: string };

/**
 * Limite de erro simples: evita a "tela branca" capturando exceções de
 * renderização dos componentes filhos e exibindo um fallback amigável.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ErrorBoundary] Erro capturado:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-[#09090b] p-6 text-center text-zinc-200">
          <h1 className="text-xl font-semibold">Algo deu errado</h1>
          <p className="max-w-md text-sm text-zinc-400">
            Ocorreu um erro inesperado na interface. Tente recarregar a página.
          </p>
          {this.state.message && (
            <code className="max-w-md break-all text-xs text-red-400">{this.state.message}</code>
          )}
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
