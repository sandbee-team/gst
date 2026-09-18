import React, { useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Busy, Field, Form, PasswordField } from '../components/ui';
import AuthLayout from '../components/AuthLayout';
import ForgotPassword from './ForgotPassword';
export default function Auth({ api, accept, notice }) {
  const [mode, setMode] = useState('login'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const signup = mode === 'signup';
  async function submit(e) {
    e.preventDefault();
    setError('');
    const values = Object.fromEntries(new FormData(e.currentTarget));
    if (signup && values.password !== values.confirmPassword) {
      setError('Your passwords do not match. Please check both fields.');
      return;
    }
    delete values.confirmPassword;
    setBusy(true);
    try {
      accept(await api(`/auth/${signup ? 'signup' : 'login'}`, { method: 'POST', body: values }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const switchMode = (next) => {
    setMode(next);
    setError('');
  };
  return (
    <AuthLayout step={signup ? 1 : 0}>
      {mode === 'forgot' ? (
        <ForgotPassword api={api} back={() => switchMode('login')} />
      ) : (
        <>
          <span className="eyebrow">{signup ? 'YOUR NEXT CHAPTER' : 'WELCOME TO SANDBEE'}</span>
          <h2>{signup ? 'Let’s build something.' : 'Welcome back.'}</h2>
          <p className="muted">
            {signup
              ? 'Create your free account. We’ll help you get set up.'
              : 'Sign in and pick up where you left off.'}
          </p>
          <div className="auth-mode-tabs">
            <button
              aria-label="Switch to sign in"
              className={!signup ? 'selected' : ''}
              onClick={() => switchMode('login')}
            >
              Sign in
            </button>
            <button className={signup ? 'selected' : ''} onClick={() => switchMode('signup')}>
              Create an account
            </button>
          </div>
          <Form onSubmit={submit} key={mode}>
            {signup && (
              <Field
                label="Full name"
                name="name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={80}
                placeholder="Your full name"
              />
            )}
            <Field
              label="Email address"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              placeholder="you@company.com"
            />
            <PasswordField
              label="Password"
              name="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              required
              minLength={signup ? 12 : 1}
              maxLength={128}
              placeholder={signup ? 'Create a strong password' : 'Enter your password'}
            />
            {signup ? (
              <>
                <PasswordField
                  label="Confirm password"
                  name="confirmPassword"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  placeholder="Enter your password again"
                />
                <p className="helper-copy">
                  Use at least 12 characters. A mix of words makes a strong password.
                </p>
              </>
            ) : (
              <div className="forgot-row">
                <button type="button" className="text-button" onClick={() => switchMode('forgot')}>
                  Forgot password?
                </button>
              </div>
            )}
            {(error || notice) && (
              <div className="alert" role="alert">
                {error || notice}
              </div>
            )}
            <button className="button primary wide" disabled={busy}>
              {busy ? (
                <>
                  <Busy />
                  {signup ? 'Creating your account…' : 'Signing you in…'}
                </>
              ) : (
                <>
                  {signup ? 'Create free account' : 'Sign in'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </Form>
          <p className="form-foot">
            <ShieldCheck size={16} />
            {signup ? 'Verify your email, then make it yours.' : 'Secure access. Simple by design.'}
          </p>
        </>
      )}
    </AuthLayout>
  );
}
