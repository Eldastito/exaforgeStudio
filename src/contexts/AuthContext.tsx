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
          if (!res.ok) throw new Error('invalid token');
          setToken(storedToken);
          try { setUser(JSON.parse(storedUser)); } catch (e) {}
        })
        .catch(() => {
          localStorage.removeItem('zappflow_token');
          localStorage.removeItem('zappflow_user');
          setToken(null);
          setUser(null);
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
