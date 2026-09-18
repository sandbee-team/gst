// Controllable subprocess for lifecycle tests; no Python or portal dependency.
const readline = require('node:readline');
const mode = process.argv[2];
if (mode !== 'startup-hang') console.log(JSON.stringify({ ready: true }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id } = JSON.parse(line);
  if (mode === 'crash') process.exit(7);
  if (mode === 'malformed') { console.log('not json'); return; }
  if (mode === 'hang' || mode === 'startup-hang') return;
  setTimeout(() => console.log(JSON.stringify({ id, result: { text: String(id).padStart(6, '0'), score: .99, autoSubmit: true } })), id % 2 ? 20 : 1);
});
