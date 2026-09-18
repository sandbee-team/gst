import React, { useState } from 'react';
import { ArrowRight, MailCheck, RefreshCw } from 'lucide-react';
import AuthLayout from '../components/AuthLayout';
import OtpInput, { useCountdown } from '../components/OtpInput';
import { Busy, Form } from '../components/ui';
export default function VerifyEmail({ user, api, accept, logout, notice }) {
  const [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [error, setError] = useState(notice || ''),
    [sent, setSent] = useState(false);
  const remaining = useCountdown(user.verificationResendAt);
  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      accept(await api('/auth/verification/confirm', { method: 'POST', body: { code } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    setSending(true);
    setError('');
    try {
      accept(await api('/auth/verification/send', { method: 'POST', body: {} }));
      setSent(true);
      setCode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }
  return (
    <AuthLayout step={2}>
      <span className="auth-symbol">
        <MailCheck size={27} />
      </span>
      <span className="eyebrow">ONE SMALL STEP FOR SECURITY</span>
      <h2>Check your inbox.</h2>
      <p className="muted">Verify your email to unlock your workspace.</p>
      <div className="email-destination">
        <span>Verification email</span>
        <strong>{user.email}</strong>
      </div>
      <Form onSubmit={confirm}>
        <OtpInput value={code} onChange={setCode} disabled={busy} />
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {sent && (
          <div className="notice" role="status">
            A fresh code is on its way. Use the most recent email.
          </div>
        )}
        <button className="button primary wide" disabled={busy || code.length !== 6}>
          {busy ? (
            <Busy />
          ) : (
            <>
              Verify email <ArrowRight size={17} />
            </>
          )}
        </button>
      </Form>
      <div className="resend-line">
        <span>Didn't receive a code?</span>
        <button className="text-button" onClick={resend} disabled={sending || remaining > 0}>
          {sending ? <Busy /> : <RefreshCw size={13} />}{' '}
          {remaining > 0 ? `Resend in ${remaining}s` : 'Resend code'}
        </button>
      </div>
      <p className="helper-copy">Check your spam folder, or request a new code after one minute.</p>
      <button className="back-link" onClick={logout}>
        Use a different account
      </button>
    </AuthLayout>
  );
}
