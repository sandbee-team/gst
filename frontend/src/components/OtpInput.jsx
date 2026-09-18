import React, { useEffect, useState } from 'react';
export function useCountdown(until) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.ceil((new Date(until || 0).getTime() - now) / 1000));
}
export default function OtpInput({ value, onChange, disabled }) {
  return (
    <label className="field otp-field">
      <span>Verification code</span>
      <input
        name="code"
        className="otp-input"
        aria-label="Verification code"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        minLength={6}
        placeholder="000000"
        autoFocus
        required
        disabled={disabled}
      />
      <small>Enter the 6-digit code from your email. Valid for 10 minutes.</small>
    </label>
  );
}
