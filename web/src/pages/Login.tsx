import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../icons';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [devLink, setDevLink] = useState<string | null>(null);
  const { user } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    if (user) nav('/projects', { replace: true });
  }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setState('sending');
    try {
      const r = await api('/auth/request', { body: { email } });
      setDevLink(r.devLink || null);
      setState('sent');
    } catch (err: any) {
      setError(err.message);
      setState('idle');
    }
  };

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <Logo />
        {state !== 'sent' ? (
          <form onSubmit={submit} style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h1 style={{ fontSize: 20 }}>Log in</h1>
              <p className="muted" style={{ margin: '4px 0 0' }}>We'll email you a magic link — no password needed.</p>
            </div>
            <div>
              <label className="label" htmlFor="email">Work email</label>
              <input id="email" className="input" type="email" required autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && <div className="error-text">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={state === 'sending' || !email}>{state === 'sending' ? 'Sending…' : 'Send magic link'}</button>
          </form>
        ) : (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h1 style={{ fontSize: 20 }}>Check your email</h1>
            <p className="muted" style={{ margin: 0 }}>We sent a login link to <b style={{ color: 'var(--text)' }}>{email}</b>. It expires in 20 minutes.</p>
            {devLink && (
              <div className="attention-note">
                No email provider is configured on this server (evaluation mode).{' '}
                <a href={devLink} data-testid="dev-login-link">Open the login link</a>
              </div>
            )}
            <button className="btn btn-ghost" onClick={() => setState('idle')}>Use a different email</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const [error, setError] = useState('');
  const { setUser } = useAuth();
  const nav = useNavigate();
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    api('/auth/verify', { body: { token: params.get('token') } })
      .then((r) => {
        setUser(r.user);
        nav('/projects', { replace: true });
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <Logo />
        <div style={{ marginTop: 24 }}>
          {error ? (
            <>
              <h1 style={{ fontSize: 18 }}>Login failed</h1>
              <p className="error-text">{error}</p>
              <a className="btn" href="/login">Request a new link</a>
            </>
          ) : (
            <div className="row"><span className="spinner" /> Logging you in…</div>
          )}
        </div>
      </div>
    </div>
  );
}
