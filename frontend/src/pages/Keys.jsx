import React, { useState } from 'react';
import { Check, KeyRound, Plus, ShieldCheck, X } from 'lucide-react';
import { Busy, Field, CopyButton, Title, date, Form } from '../components/ui';
export default function Keys({ user, api, refresh }) {
  const [name, setName] = useState('Production key'),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState('');
  async function execute(action) {
    setBusy(true);
    setError('');
    try {
      if (action === 'revoke') {
        await api('/keys', { method: 'DELETE' });
        setToken('');
      } else {
        const data = await api('/keys', { method: 'POST', body: { name } });
        setToken(data.token);
      }
      await refresh();
      setConfirm('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title
        eyebrow="AUTHENTICATION"
        title="API keys"
        description="Give your application secure access to the GSTIN API."
      />
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {token && (
        <section className="card key-reveal">
          <div className="card-heading">
            <h2>
              <Check size={18} /> Your new API key is ready
            </h2>
            <button className="icon-button" aria-label="Hide API key" onClick={() => setToken('')}>
              <X size={18} />
            </button>
          </div>
          <p>
            Copy and store this key securely. You can only see it now; it will be hidden when you
            leave this page.
          </p>
          <div className="secret">
            <code data-testid="new-api-key">{token}</code>
            <CopyButton value={token} />
          </div>
        </section>
      )}
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Your active key</h2>
            <p className="muted">One active key per account. Replace or revoke it at any time.</p>
          </div>
          <span className="pill">{user.apiKey ? '1 active' : 'No active key'}</span>
        </div>
        {user.apiKey ? (
          <>
            <div className="key-row">
              <span className="icon-box">
                <KeyRound size={23} />
              </span>
              <div>
                <strong>{user.apiKey.name}</strong>
                <code>{user.apiKey.prefix}••••••••</code>
              </div>
              <span className="status-dot">Active</span>
            </div>
            <div className="key-meta">
              <div>
                <small>CREATED</small>
                {date(user.apiKey.createdAt)}
              </div>
              <div>
                <small>LAST USED</small>
                {date(user.apiKey.lastUsedAt)}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <KeyRound size={30} />
            <h3>Your integration starts with a key.</h3>
            <p>Generate one below to unlock the API and playground.</p>
          </div>
        )}
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            user.apiKey ? setConfirm('rotate') : execute('generate');
          }}
        >
          <Field
            label="Key name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
          />
          <div className="actions">
            <button className="button primary" disabled={busy}>
              {busy ? <Busy /> : <Plus size={17} />}{' '}
              {user.apiKey ? 'Replace API key' : 'Generate API key'}
            </button>
            {user.apiKey && (
              <button type="button" className="button danger" onClick={() => setConfirm('revoke')}>
                Revoke key
              </button>
            )}
          </div>
        </Form>
      </section>
      <div className="info-line">
        <ShieldCheck size={18} />
        <span>
          Keep your API key on your server. Never put it in browser code, public repositories, or
          shared screenshots.
        </span>
      </div>
      {confirm && (
        <div className="modal-backdrop">
          <section
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <h2 id="confirm-title">
              {confirm === 'revoke' ? 'Revoke this API key?' : 'Replace your API key?'}
            </h2>
            <p>
              Your current key will stop working immediately for new requests. Update connected
              applications after replacing it.
            </p>
            <div className="actions">
              <button className="button ghost" onClick={() => setConfirm('')} disabled={busy}>
                Cancel
              </button>
              <button className="button primary" disabled={busy} onClick={() => execute(confirm)}>
                {busy ? <Busy /> : 'Confirm'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
