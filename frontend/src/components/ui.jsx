import React, { useState } from 'react';
import { Check, Copy, Database, LoaderCircle, Eye, EyeOff } from 'lucide-react';
export const date = (value) => (value ? new Date(value).toLocaleString() : 'Not used yet');
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Database size={21} />
      </span>
      <span>
        GSTIN <small>by sandbee</small>
      </span>
    </div>
  );
}
export function Busy() {
  return <LoaderCircle className="spin" size={17} />;
}
export function Field({ label, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input data-label={label} {...props} />
    </label>
  );
}
export function PasswordField({ label, ...props }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="password-control">
        <input data-label={label} {...props} type={visible ? 'text' : 'password'} />
        <button
          type="button"
          aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </label>
  );
}
export function Form({ children, onSubmit, ...props }) {
  const [validation, setValidation] = useState('');
  return (
    <form
      {...props}
      noValidate
      onInput={() => setValidation('')}
      onSubmit={(e) => {
        const invalid = Array.from(e.currentTarget.elements).find(
          (el) => el.willValidate && !el.validity.valid,
        );
        if (invalid) {
          e.preventDefault();
          const label = invalid.dataset.label || 'Verification code';
          setValidation(
            invalid.validity.valueMissing
              ? `Please enter ${label.toLowerCase()}.`
              : invalid.validity.typeMismatch
                ? 'Please enter a valid email address.'
                : invalid.validity.tooShort
                  ? `${label} needs at least ${invalid.minLength} characters.`
                  : invalid.validity.patternMismatch
                    ? 'Please enter the 6-digit code from your email.'
                    : `Please check ${label.toLowerCase()}.`,
          );
          invalid.focus();
          return;
        }
        setValidation('');
        onSubmit?.(e);
      }}
    >
      {children}
      {validation && (
        <div className="alert" role="alert">
          {validation}
        </div>
      )}
    </form>
  );
}
export function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="button ghost small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
export function WorkspaceFields({ company, setCompany, useCase, setUseCase }) {
  return (
    <>
      <Field
        label="Workspace / company name"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        required
        minLength={2}
        maxLength={100}
        placeholder="Your company"
      />
      <label className="field">
        <span>What will you use GSTIN for?</span>
        <select value={useCase} onChange={(e) => setUseCase(e.target.value)}>
          <option value="development">Building an integration</option>
          <option value="verification">Business verification</option>
          <option value="invoicing">Invoicing</option>
          <option value="other">Something else</option>
        </select>
      </label>
    </>
  );
}
export function Title({ eyebrow, title, description, action }) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
