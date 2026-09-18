import { Brand, Busy } from './components/ui';
import Auth from './pages/Auth';
import VerifyEmail from './pages/VerifyEmail';
import { readResponse } from './lib/http';
import Onboarding from './pages/Onboarding';
import Overview from './pages/Overview';
import Keys from './pages/Keys';
import Playground from './pages/Playground';
import Docs from './pages/Docs';
import Account from './pages/Account';
import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
const navigation = [
  ['overview', 'Overview', LayoutDashboard],
  ['keys', 'API keys', KeyRound],
  ['playground', 'Playground', Terminal],
  ['docs', 'Documentation', BookOpen],
  ['settings', 'Settings', Settings],
];

export default function App() {
  const [user, setUser] = useState(null),
    [csrf, setCsrf] = useState(''),
    [loading, setLoading] = useState(true);
  const [page, setPage] = useState('overview'),
    [menu, setMenu] = useState(false),
    [notice, setNotice] = useState('');
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    try {
      return await readResponse(response);
    } catch (error) {
      if (error.code === 'UNAUTHENTICATED') {
        setUser(null);
        setCsrf('');
      }
      throw error;
    }
  }
  function accept(data) {
    setUser(data.user);
    if (data.csrfToken) setCsrf(data.csrfToken);
    setNotice(data.verificationError || '');
  }
  async function refresh() {
    accept(await api('/auth/me'));
  }
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status !== 401) accept(await readResponse(res));
      })
      .catch(() => setNotice('Unable to connect. Please reload the page.'))
      .finally(() => setLoading(false));
  }, []);
  function navigate(next) {
    setPage(next);
    setMenu(false);
    setNotice('');
  }
  if (loading)
    return (
      <div className="loading">
        <Brand />
        <Busy />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!user) return <Auth api={api} accept={accept} notice={notice} />;
  if (!user.emailVerified)
    return <VerifyEmail user={user} api={api} accept={accept} logout={logout} notice={notice} />;
  if (!user.onboarded) return <Onboarding user={user} api={api} accept={accept} logout={logout} />;
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      setUser(null);
      setCsrf('');
      setPage('overview');
    } catch (error) {
      setNotice(error.message);
    }
  }
  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <Brand />
        <div className="workspace">
          <span className="avatar">{user.company.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user.company}</strong>
            <small>Developer workspace</small>
          </div>
          <span className="free">FREE</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => navigate(id)}>
              <Icon size={19} />
              {label}
              {page === id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={22} />
          <strong>Your integration, secured.</strong>
          <p>Private API keys. Account-level usage. One simple workspace.</p>
          <button onClick={() => navigate('docs')}>
            Read the API guide <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="profile">
          <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button title="Sign out" aria-label="Sign out" onClick={logout}>
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header>
          <button className="mobile-menu" aria-label="Toggle menu" onClick={() => setMenu(!menu)}>
            {menu ? <X /> : <Menu />}
          </button>
          <span>
            Workspace <ChevronRight size={14} />{' '}
            <strong>{navigation.find((x) => x[0] === page)?.[1]}</strong>
          </span>
          <span className="header-badge">
            <span /> Free developer access
          </span>
        </header>
        <main>
          {notice && (
            <div className="alert" role="alert">
              {notice}
            </div>
          )}
          {page === 'overview' && <Overview user={user} navigate={navigate} />}
          {page === 'keys' && <Keys user={user} api={api} refresh={refresh} />}
          {page === 'playground' && (
            <Playground user={user} api={api} refresh={refresh} navigate={navigate} />
          )}
          {page === 'docs' && <Docs />}
          {page === 'settings' && (
            <Account
              user={user}
              api={api}
              accept={accept}
              signedOut={() => {
                setUser(null);
                setCsrf('');
                setPage('overview');
              }}
            />
          )}
        </main>
        <footer>
          GSTIN by sandbee <span>Built for straightforward integrations.</span>
        </footer>
      </div>
    </div>
  );
}
