import React, { useState } from 'react';
import { CopyButton, Title } from '../components/ui';
export default function Docs() {
  const base = window.location.origin,
    [language, setLanguage] = useState('curl');
  const snippets = {
    curl: `curl "${base}/api/v1/gstin/09AAFPC6958E1ZN" \\\n  -H "Authorization: Bearer $SANDBEE_API_KEY"`,
    JavaScript: `const response = await fetch(\n  '${base}/api/v1/gstin/09AAFPC6958E1ZN',\n  { headers: { Authorization: \`Bearer \${process.env.SANDBEE_API_KEY}\` } }\n);\nconst result = await response.json();\nif (!response.ok) throw new Error(result.error.message);\nconsole.log(result.data);`,
    Python: `import os, requests\n\nresponse = requests.get(\n    '${base}/api/v1/gstin/09AAFPC6958E1ZN',\n    headers={'Authorization': 'Bearer ' + os.environ['SANDBEE_API_KEY']},\n    timeout=75,\n)\nresponse.raise_for_status()\nprint(response.json()['data'])`,
  };
  return (
    <>
      <Title
        eyebrow="BUILD WITH GSTIN"
        title="A simple API. A quick start."
        description="Everything you need to connect your application."
      />
      <section className="card">
        <h2>1. Authenticate your request</h2>
        <p className="muted">
          Generate a key in API keys and keep it in a server environment variable. Send it as a
          Bearer token on every request.
        </p>
        <div className="endpoint">
          <span>GET</span>
          <code>{base}/api/v1/gstin/:gstin</code>
        </div>
        <div className="tabs">
          {Object.keys(snippets).map((item) => (
            <button
              key={item}
              onClick={() => setLanguage(item)}
              className={language === item ? 'selected' : ''}
            >
              {item}
            </button>
          ))}
          <CopyButton value={snippets[language]} />
        </div>
        <pre className="code-block">{snippets[language]}</pre>
      </section>
      <section className="card">
        <h2>2. Handle the response</h2>
        <p className="muted">
          Success contains <code>success</code>, <code>data</code>, and <code>meta</code>. Metadata
          includes source (live or database), fetchedAt, and elapsedMs. GSTINs are normalized and
          checksum-validated.
        </p>
        <p className="muted">
          The first successful portal response is saved and reused. Check{' '}
          <code>meta.fetchedAt</code> to understand its age. Repeated calls do not refresh that
          snapshot.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Meaning</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {[
                [200, 'Success', 'Read data and the snapshot timestamp.'],
                [400, 'Invalid input', 'Check the GSTIN format and checksum.'],
                [401, 'Invalid or revoked key', 'Use your current Bearer token.'],
                [404, 'GSTIN not found', 'Check the number with the business.'],
                [429, 'Rate limit reached', 'Observe rate-limit headers before retrying.'],
                [502, 'Portal response failed', 'Retry with bounded backoff.'],
                [503, 'Lookup temporarily unavailable', 'Observe Retry-After and retry later.'],
              ].map((row) => (
                <tr key={row[0]}>
                  {row.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="two-columns">
        <section className="card">
          <h2>Usage & limits</h2>
          <p className="muted">
            60 requests per minute per account, shared between the API and playground. Only
            successful responses increment usage.
          </p>
        </section>
        <section className="card">
          <h2>Key lifecycle</h2>
          <p className="muted">
            Your full key is displayed once. Replacing or revoking it blocks new calls with the old
            key immediately. Changing your password signs out all sessions and revokes your API key.
          </p>
        </section>
      </div>
    </>
  );
}
