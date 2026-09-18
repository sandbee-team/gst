import React, { useState } from 'react';
import { ArrowRight, Check, KeyRound, Search, Terminal } from 'lucide-react';
import { Busy, Field, CopyButton, Title, date, Form } from '../components/ui';
export default function Playground({ user, api, refresh, navigate }) {
  const [gstin, setGstin] = useState(''),
    [result, setResult] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [raw, setRaw] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api('/playground', { method: 'POST', body: { gstin } }));
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title
        eyebrow="TEST YOUR INTEGRATION"
        title="API playground"
        description="Run a real GST lookup without leaving your workspace."
      />
      {!user.apiKey ? (
        <section className="card empty-state">
          <KeyRound size={30} />
          <h2>First, create your API key.</h2>
          <p>Your key unlocks secure access to lookups.</p>
          <button className="button primary" onClick={() => navigate('keys')}>
            Go to API keys <ArrowRight size={16} />
          </button>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="endpoint">
              <span>GET</span>
              <code>/api/v1/gstin/:gstin</code>
              <span className="pill">Authenticated</span>
            </div>
            <Form onSubmit={submit} className="lookup-form">
              <Field
                label="GST identification number"
                value={gstin}
                onChange={(e) => setGstin(e.target.value.toUpperCase().trim())}
                placeholder="e.g. 09AAFPC6958E1ZN"
                required
                minLength={15}
                maxLength={15}
                spellCheck={false}
              />
              <button className="button primary" disabled={busy}>
                {busy ? <Busy /> : <Search size={17} />} {busy ? 'Looking up…' : 'Run lookup'}
              </button>
            </Form>
            <small className="muted">
              Successful requests here count toward your usage. A live lookup can take up to a
              minute.
            </small>
          </section>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {result ? (
            <section className="card result">
              <div className="card-heading">
                <h2>
                  <span className="success-mark">
                    <Check size={16} />
                  </span>{' '}
                  Lookup successful
                </h2>
                <span className="pill">{result.meta.elapsedMs} ms</span>
              </div>
              <div className="result-meta">
                <span>
                  {result.meta.source === 'database' ? 'Saved response' : 'Live response'}
                </span>
                <span>Fetched {date(result.meta.fetchedAt)}</span>
              </div>
              <div className="tabs">
                <button className={!raw ? 'selected' : ''} onClick={() => setRaw(false)}>
                  Details
                </button>
                <button className={raw ? 'selected' : ''} onClick={() => setRaw(true)}>
                  JSON response
                </button>
                <CopyButton value={JSON.stringify(result, null, 2)} />
              </div>
              {raw ? (
                <pre className="code-block">{JSON.stringify(result, null, 2)}</pre>
              ) : (
                <dl className="details">
                  {Object.entries(result.data).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}</dt>
                      <dd>
                        {value === null || value === ''
                          ? '—'
                          : typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <p className="muted small-text">
                Saved data reflects the first successful lookup, at the timestamp above. It is not a
                real-time status guarantee.
              </p>
            </section>
          ) : (
            !busy && (
              <section className="card empty-state">
                <Terminal size={30} />
                <h3>Your response will appear here.</h3>
                <p>Enter a valid GSTIN and run your first request.</p>
              </section>
            )
          )}
        </>
      )}
    </>
  );
}
