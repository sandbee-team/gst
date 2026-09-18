import React, { useState } from 'react';
import { Field, WorkspaceFields, Title, Form, PasswordField } from '../components/ui';
export default function Account({ user, api, accept, signedOut }) {
  const [company, setCompany] = useState(user.company),
    [useCase, setUseCase] = useState(user.useCase),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      accept(await api('/onboarding', { method: 'POST', body: { company, useCase } }));
      setMessage('Workspace updated.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function password(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/password', {
        method: 'POST',
        body: Object.fromEntries(new FormData(e.currentTarget)),
      });
      signedOut();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title
        eyebrow="YOUR ACCOUNT"
        title="Workspace settings"
        description="Manage your workspace and keep your account secure."
      />
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      <div className="two-columns">
        <section className="card">
          <h2>Workspace details</h2>
          <p className="muted">
            {user.name} · {user.email}
          </p>
          <Form onSubmit={save}>
            <WorkspaceFields {...{ company, setCompany, useCase, setUseCase }} />
            <button className="button primary" disabled={busy}>
              Save changes
            </button>
          </Form>
        </section>
        <section className="card">
          <h2>Change password</h2>
          <p className="muted">
            This signs out all sessions and revokes your current API key. Sign in again to generate
            a new key.
          </p>
          <Form onSubmit={password}>
            <PasswordField
              label="Current password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
            <PasswordField
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
            <button className="button primary" disabled={busy}>
              Change password & sign out
            </button>
          </Form>
        </section>
      </div>
    </>
  );
}
