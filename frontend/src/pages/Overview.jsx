import React from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Database,
  Play,
  ShieldCheck,
  Terminal,
  Zap,
} from 'lucide-react';
import { Title } from '../components/ui';
export default function Overview({ user, navigate }) {
  const total = user.usage.total || 0,
    cached = user.usage.cached || 0;
  return (
    <>
      <Title
        eyebrow="YOUR DEVELOPER WORKSPACE"
        title={`Hello, ${user.name.split(' ')[0]}.`}
        description="A clear view of your GST integration, all in one place."
        action={
          <button className="button primary" onClick={() => navigate('playground')}>
            <Play size={16} /> Try a lookup
          </button>
        }
      />
      <section className="welcome-banner">
        <div>
          <span className="pill">BUILD SOMETHING GREAT</span>
          <h2>GST details, one request away.</h2>
          <p>Generate a key, make your first call, and let us handle the lookup.</p>
          <button className="button light" onClick={() => navigate(user.apiKey ? 'docs' : 'keys')}>
            {user.apiKey ? 'Explore the documentation' : 'Generate your API key'}
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="banner-art" aria-hidden="true">
          <div>
            <Database size={38} />
          </div>
          <span className="art-tag">
            <Check size={14} /> Ready to integrate
          </span>
        </div>
      </section>
      <section className="stats">
        {[
          [Zap, 'Successful requests', total, 'Across your account'],
          [Database, 'Saved responses served', cached, 'Fast reads from our database'],
          [
            ArrowUpRight,
            'Live responses served',
            user.usage.live || 0,
            'Verified through the GST portal',
          ],
        ].map(([Icon, label, value, hint]) => (
          <article className="card stat" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={19} />
            </div>
            <strong>{value.toLocaleString()}</strong>
            <small>{hint}</small>
          </article>
        ))}
      </section>
      <div className="two-columns">
        <section className="card">
          <div className="card-heading">
            <h2>Your launch checklist</h2>
            <span className="pill">{1 + Number(!!user.apiKey) + Number(total > 0)}/3 complete</span>
          </div>
          {[
            ['Create your workspace', 'Your account is ready to go.', true, 'settings'],
            ['Generate an API key', 'A private token for your application.', !!user.apiKey, 'keys'],
            ['Make your first request', 'Test a GSTIN in the playground.', total > 0, 'playground'],
          ].map(([title, sub, done, target], i) => (
            <button className="check-row" key={title} onClick={() => navigate(target)}>
              <span className={`step ${done ? 'done' : ''}`}>
                {done ? <Check size={16} /> : i + 1}
              </span>
              <span>
                <strong>{title}</strong>
                <small>{sub}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </section>
        <section className="card integration">
          <span className="icon-box">
            <Terminal size={22} />
          </span>
          <h2>Small API. Big possibilities.</h2>
          <p className="muted">
            Use a single authenticated endpoint to fetch business details from a GSTIN.
          </p>
          <code>GET /api/v1/gstin/:gstin</code>
          <button className="text-button" onClick={() => navigate('docs')}>
            Read the integration guide <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <div className="info-line">
        <ShieldCheck size={17} />
        <span>
          Only successful requests count toward your usage. Your account is free, with 60 requests
          per minute.
        </span>
      </div>
    </>
  );
}
