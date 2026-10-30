import { createContext, useCallback, useContext, useState, ReactNode } from 'react';

type T = { id: number; text: string; kind?: 'error' };
const Ctx = createContext<(text: string, kind?: 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((text: string, kind?: 'error') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.filter((i) => i.text !== text), { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind || ''}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
