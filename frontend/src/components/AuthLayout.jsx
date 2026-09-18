import React from 'react';
import { ArrowUpRight, Check, Fingerprint, ShieldCheck, Zap } from 'lucide-react';
import { Brand } from './ui';
export default function AuthLayout({ children, step = 0 }) {
  return (
    <div className="auth-layout refreshed-auth">
      <section className="auth-story">
        <Brand />
        <div className="story-content">
          <span className="eyebrow light">YOUR NEXT INTEGRATION STARTS HERE</span>
          <h1>
            Less friction.
            <br />
            More possibility.
          </h1>
          <p>A simpler way to connect your business with reliable GST details.</p>
          <div className="auth-preview">
            <div className="preview-heading">
              <span className="preview-logo">
                <Fingerprint size={24} />
              </span>
              <div>
                <strong>Your developer workspace</strong>
                <small>Everything in one place</small>
              </div>
              <ArrowUpRight size={18} />
            </div>
            <div className="preview-business">
              <div>
                <span className="business-monogram">S</span>
                <div>
                  <strong>Your next connection</strong>
                  <small>Business details, beautifully simple.</small>
                </div>
              </div>
              <span className="verified-tag">
                <Check size={12} /> Ready
              </span>
            </div>
            <div className="preview-features">
              <span>
                <ShieldCheck size={17} /> Private API access
              </span>
              <span>
                <Zap size={17} /> Faster repeat lookups
              </span>
            </div>
          </div>
          <div className="auth-promises">
            <span>
              <Check size={14} /> Free developer account
            </span>
            <span>
              <Check size={14} /> No credit card
            </span>
          </div>
        </div>
        <small>GSTIN by sandbee &middot; Made for people who build.</small>
      </section>
      <section className="auth-form">
        <div className="auth-top">
          <ShieldCheck size={14} /> A secure space to build{' '}
          <span className="pill">FREE FOREVER</span>
        </div>
        <div className="form-wrap">
          {step > 0 && (
            <ol className="setup-progress" aria-label="Account setup progress">
              {['Account', 'Verify email', 'Workspace'].map((label, i) => (
                <li
                  key={label}
                  className={i + 1 < step ? 'complete' : i + 1 === step ? 'current' : ''}
                  aria-current={i + 1 === step ? 'step' : undefined}
                >
                  <span>{i + 1 < step ? <Check size={12} /> : i + 1}</span>
                  {label}
                </li>
              ))}
            </ol>
          )}
          {children}
        </div>
        <p className="auth-bottom">
          <ShieldCheck size={14} /> Your details stay in your private workspace.
        </p>
      </section>
    </div>
  );
}
