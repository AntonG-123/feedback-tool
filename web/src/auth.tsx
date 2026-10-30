import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api } from './api';

type User = { id: string; email: string; name: string | null };
const Ctx = createContext<{ user: User | null; loading: boolean; refresh: () => Promise<void>; setUser: (u: User | null) => void }>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Incremented on every explicit login/logout so that a slower /auth/me
  // response started earlier cannot overwrite the newer state.
  const version = useRef(0);
  const setUser = (u: User | null) => {
    version.current++;
    setUserState(u);
    setLoading(false);
  };
  const refresh = async () => {
    const v = version.current;
    try {
      const r = await api('/auth/me');
      if (v === version.current) setUserState(r.user);
    } catch {
      if (v === version.current) setUserState(null);
    } finally {
      if (v === version.current) setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  return <Ctx.Provider value={{ user, loading, refresh, setUser }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
