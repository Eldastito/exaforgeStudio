import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export type Toast = {
  id: string;
  type: ToastType;
  message: string;
};

export type ConfirmRequest = {
  id: string;
  title?: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: (value: boolean) => void;
};

type ConfirmOptions = {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

interface ToastState {
  toasts: Toast[];
  confirms: ConfirmRequest[];
  push: (type: ToastType, message: string, ttl?: number) => void;
  dismiss: (id: string) => void;
  requestConfirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  resolveConfirm: (id: string, value: boolean) => void;
}

const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  confirms: [],

  push: (type, message, ttl = 4000) => {
    const id = uid();
    set(s => ({ toasts: [...s.toasts, { id, type, message }] }));
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl);
    }
  },

  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  requestConfirm: (message, options = {}) =>
    new Promise<boolean>((resolve) => {
      const id = uid();
      set(s => ({
        confirms: [
          ...s.confirms,
          {
            id,
            message,
            title: options.title,
            confirmText: options.confirmText || 'Confirmar',
            cancelText: options.cancelText || 'Cancelar',
            danger: options.danger ?? false,
            resolve,
          },
        ],
      }));
    }),

  resolveConfirm: (id, value) => {
    const req = get().confirms.find(c => c.id === id);
    if (req) req.resolve(value);
    set(s => ({ confirms: s.confirms.filter(c => c.id !== id) }));
  },
}));
