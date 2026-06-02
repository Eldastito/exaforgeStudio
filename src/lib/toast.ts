import { useToast } from '@/src/store/useToast';

// API imperativa de notificações — pode ser chamada de qualquer lugar
// (handlers, funções utilitárias), sem precisar de hook.
export const toast = {
  success: (message: string) => useToast.getState().push('success', message),
  error: (message: string) => useToast.getState().push('error', message),
  info: (message: string) => useToast.getState().push('info', message),
};

type ConfirmOptions = {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

// Substitui o window.confirm(): retorna uma Promise<boolean> resolvida quando
// o usuário escolhe no modal. Use com await.
export const confirmDialog = (message: string, options?: ConfirmOptions): Promise<boolean> =>
  useToast.getState().requestConfirm(message, options);
