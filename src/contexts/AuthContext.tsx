import React, { createContext, useContext, useState, useEffect } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationId: string;
  onboarding_status?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  login: () => {},
  logout: () => {},
  loading: true
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('zappflow_token');
    const storedUser = localStorage.getItem('zappflow_user');

    if (storedToken && storedUser) {
      // Valida o token no servidor. Se estiver inválido/expirado (ex.: o
      // JWT_SECRET mudou), limpamos a sessão para não deixar o usuário num
      // estado "logado mas com 401 em tudo" (Kanban vazio, socket recusado).
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${storedToken}` } })
        .then(res => {
          // ADR-082 (Fase 0, D8): SÓ 401/403 encerram a sessão (token realmente
          // inválido/expirado). Qualquer outro status (5xx) ou erro de rede/DNS
          // NÃO desloga — mantém a sessão e entra em modo de contingência. Antes,
          // qualquer falha apagava as credenciais e caía no login (bug: refresh
          // durante queda de internet deslogava sessão válida).
          if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('zappflow_token');
            localStorage.removeItem('zappflow_user');
            setToken(null);
            setUser(null);
            return;
          }
          // Sucesso OU indisponibilidade temporária → confia na sessão local.
          setToken(storedToken);
          try { setUser(JSON.parse(storedUser)); } catch (e) {}
        })
        .catch(() => {
          // Erro de rede (offline/DNS/servidor fora): mantém a sessão. As telas
          // já lidam com API indisponível; o usuário não deve ser deslogado.
          setToken(storedToken);
          try { setUser(JSON.parse(storedUser)); } catch (e) {}
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = (newToken: string, newUser: User) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('zappflow_token', newToken);
    localStorage.setItem('zappflow_user', JSON.stringify(newUser));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('zappflow_token');
    localStorage.removeItem('zappflow_user');
    // ADR-082 (D7): apaga o armazenamento local da camada de continuidade
    // (outbox no IndexedDB). É dado por-usuário e não pode sobreviver ao logout
    // num dispositivo compartilhado. Best-effort: não bloqueia a saída.
    import('@/src/lib/continuity/outbox')
      .then(m => m.clearContinuityStorage())
      .catch(() => {});
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
