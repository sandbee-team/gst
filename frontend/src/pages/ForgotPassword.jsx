import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, KeyRound, Mail, RefreshCw } from 'lucide-react';
import { Busy, Field, Form, PasswordField } from '../components/ui';
import OtpInput, { useCountdown } from '../components/OtpInput';
export default function ForgotPassword({ api, back }) {
  const [step, setStep] = useState('email'),
    [email, setEmail] = useState(''),
    [code, setCode] = useState(''),
    [token, setToken] = useState(''),
    [until, setUntil] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const remaining = useCountdown(until);
  async function send(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setUntil(Date.now() + 60000);
      setMessage(data.message);
      setCode('');
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/reset/verify', { method: 'POST', body: { email, code } });
      setToken(data.resetToken);
      setStep('password');
      setMessage('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function reset(e) {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setError('');
    if (values.password !== values.confirmPassword) {
      setError('Your passwords do not match. Please check both fields.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { email, resetToken: token, password: values.password },
      });
      setToken('');
      setStep('done');
    } catch (err) {
      setError(err.message);
      if (err.code === 'RESET_EXPIRED') {
        setStep('email');
        setToken('');
      }
    } finally {
      setBusy(false);
    }
  }
  const titles = {
    email: 'Forgot your password?',
    code: 'Check your email.',
    password: 'Choose a new password.',
    done: 'You’re all set.',
  };
  return (
    <>
      <span className="auth-symbol">
        {step === 'done' ? (
          <Check size={28} />
        ) : step === 'code' ? (
          <Mail size={27} />
        ) : (
          <KeyRound size={26} />
        )}
      </span>
      <span className="eyebrow">ACCOUNT RECOVERY</span>
      <h2>{titles[step]}</h2>
      <p className="muted">
        {step === 'email'
          ? 'We’ll send a verification code to help you get back in.'
          : step === 'code'
            ? `Enter the reset code sent to ${email}.`
            : step === 'password'
              ? 'Make it unique, with at least 12 characters.'
              : 'Your password has been updated. Sign in with your new password to continue.'}
      </p>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {message && step === 'code' && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {step === 'email' && (
        <Form onSubmit={send}>
          <Field
            label="Email address"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            maxLength={254}
            placeholder="you@company.com"
          />
          <button className="button primary wide" disabled={busy}>
            {busy ? (
              <Busy />
            ) : (
              <>
                Send reset code <ArrowRight size={17} />
              </>
            )}
          </button>
        </Form>
      )}
      {step === 'code' && (
        <>
          <Form onSubmit={verify}>
            <OtpInput value={code} onChange={setCode} disabled={busy} />
            <button className="button primary wide" disabled={busy || code.length !== 6}>
              {busy ? <Busy /> : 'Verify reset code'}
            </button>
          </Form>
          <div className="resend-line">
            <button className="text-button" onClick={send} disabled={busy || remaining > 0}>
              <RefreshCw size={13} />
              {remaining > 0 ? `Resend in ${remaining}s` : 'Resend code'}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                setStep('email');
                setError('');
              }}
            >
              Change email
            </button>
          </div>
        </>
      )}
      {step === 'password' && (
        <Form onSubmit={reset}>
          <PasswordField
            label="New password"
            name="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
          <PasswordField
            label="Confirm new password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
          <p className="helper-copy">
            For your security, all existing sessions and your API key will be revoked.
          </p>
          <button className="button primary wide" disabled={busy}>
            {busy ? <Busy /> : 'Reset password'}
          </button>
        </Form>
      )}
      {step === 'done' && (
        <div className="recovery-success">
          <span>
            <Check size={15} /> Password securely updated
          </span>
          <span>
            <Check size={15} /> Previous sessions signed out
          </span>
          <button className="button primary wide" onClick={back}>
            Back to sign in <ArrowRight size={17} />
          </button>
        </div>
      )}
      {step !== 'done' && (
        <button className="back-link" disabled={busy} onClick={back}>
          <ArrowLeft size={14} /> Back to sign in
        </button>
      )}
    </>
  );
}
