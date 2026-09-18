import React, { useState } from 'react';
import {
  ArrowRight,
  Building2,
  Check,
  Code2,
  FileCheck2,
  Layers,
  Receipt,
  Sparkles,
} from 'lucide-react';
import { Busy, Field, Form } from '../components/ui';
import AuthLayout from '../components/AuthLayout';
const cases = [
  ['development', 'Build an integration', 'Connect GST data with your product.', Code2],
  ['verification', 'Verify businesses', 'Check details before getting started.', FileCheck2],
  ['invoicing', 'Simplify invoicing', 'Bring business details into your workflow.', Receipt],
  ['other', 'Explore what’s possible', 'Start simple and find your own way.', Layers],
];
export default function Onboarding({ user, api, accept, logout }) {
  const [company, setCompany] = useState(user.company || ''),
    [useCase, setUseCase] = useState(user.useCase || 'development'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [ready, setReady] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setReady(await api('/onboarding', { method: 'POST', body: { company, useCase } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (ready)
    return (
      <AuthLayout step={3}>
        <span className="auth-symbol celebration">
          <Sparkles size={29} />
        </span>
        <span className="eyebrow">ALL SET, {user.name.split(' ')[0].toUpperCase()}</span>
        <h2>Your workspace is ready.</h2>
        <p className="muted">
          Welcome to {company}. Your next integration is just a few clicks away.
        </p>
        <div className="ready-summary">
          <span className="workspace-letter">{company.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{company}</strong>
            <small>Free developer workspace</small>
          </div>
          <span className="verified-tag">
            <Check size={12} /> Ready
          </span>
        </div>
        <ul className="ready-list">
          <li>
            <Check size={16} /> Email verified and account secured
          </li>
          <li>
            <Check size={16} /> Workspace created just for you
          </li>
          <li>
            <ArrowRight size={16} /> Next up: generate your first API key
          </li>
        </ul>
        <button className="button primary wide" onClick={() => accept(ready)}>
          Go to dashboard <ArrowRight size={17} />
        </button>
      </AuthLayout>
    );
  return (
    <AuthLayout step={3}>
      <span className="auth-symbol">
        <Building2 size={27} />
      </span>
      <span className="eyebrow">MAKE IT YOURS</span>
      <h2>A home for your next idea.</h2>
      <p className="muted">A few details to make this workspace feel like yours.</p>
      <Form onSubmit={submit}>
        <Field
          label="Workspace / company name"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
          minLength={2}
          maxLength={100}
          autoComplete="organization"
          placeholder="e.g. Sandbee Studio"
        />
        <fieldset className="usecase-fieldset">
          <legend>What brings you to GSTIN?</legend>
          <div className="usecase-grid">
            {cases.map(([value, title, description, Icon]) => (
              <label className={`usecase-card ${useCase === value ? 'selected' : ''}`} key={value}>
                <input
                  type="radio"
                  name="useCase"
                  value={value}
                  checked={useCase === value}
                  onChange={() => setUseCase(value)}
                />
                <span className="usecase-icon">
                  <Icon size={19} />
                </span>
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                <span className="choice-check">{useCase === value && <Check size={11} />}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <button className="button primary wide" disabled={busy}>
          {busy ? (
            <>
              <Busy />
              Setting things up…
            </>
          ) : (
            <>
              Create workspace <ArrowRight size={17} />
            </>
          )}
        </button>
      </Form>
      <div className="setup-account">
        <span>
          Signed in as <strong>{user.email}</strong>
        </span>
        <button className="text-button" onClick={logout}>
          Sign out
        </button>
      </div>
    </AuthLayout>
  );
}
