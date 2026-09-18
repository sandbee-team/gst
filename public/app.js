'use strict';
const $ = id => document.getElementById(id);
let challenge = null, result = null, busy = false;
let challengeConsumed = false;
function updateExpiry() {
  if (!challenge || $('captcha-form').hidden) return;
  const remaining = Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000));
  $('verify').disabled = busy || challengeConsumed || remaining === 0;
  $('captcha').disabled = busy || challengeConsumed || remaining === 0;
  $('captcha-expiry').textContent = challengeConsumed ? 'Get a new image before submitting again.'
    : remaining ? `Check the suggested digits. Image expires in ${remaining}s.` : 'This image expired. Choose New image to continue.';
}
setInterval(updateExpiry, 1000);
function setBusy(value) { busy = value; document.querySelectorAll('button,input').forEach(el => { el.disabled = value; }); updateExpiry(); }
function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
function render(data) {
  if (data.status === 'needs_captcha') {
    challenge = data; challengeConsumed = false; $('captcha-form').hidden = false; $('captcha-image').src = data.image;
    $('captcha').value = data.suggestion || ''; $('captcha-reason').textContent = data.reason;
    status(data.ocrMs ? `OCR processed in ${data.ocrMs} ms. Please check the image.` : 'Manual CAPTCHA entry needed.');
    updateExpiry(); $('captcha').focus(); return;
  }
  challenge = null; result = data.details; $('captcha-form').hidden = true; $('result').hidden = false;
  $('business-name').textContent = result.tradeName || result.legalName;
  $('business-status').textContent = result.status;
  const labels = { gstin: 'GSTIN', legalName: 'Legal name', tradeName: 'Trade name', companyType: 'Business type', taxpayerType: 'Taxpayer type', registrationDate: 'Registered on', cancellationDate: 'Cancelled on', businessNature: 'Business activities', address: 'Principal address', stateJurisdiction: 'State jurisdiction', centreJurisdiction: 'Centre jurisdiction' };
  $('details').replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = Array.isArray(result[key]) ? result[key].join(', ') : result[key] || '—';
    row.append(dt, dd); $('details').append(row);
  }
  status(data.elapsedMs ? `Retrieved in ${(data.elapsedMs / 1000).toFixed(2)} s · ${data.attempts} automatic attempt(s).` : 'GST details retrieved.');
}
async function send(url, body) {
  if (busy) return;
  setBusy(true); status('Contacting the GST portal…'); $('result').hidden = true;
  let receivedReply = false;
  try {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(75000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    receivedReply = true;
    if (!response.ok) { if (data.challengeConsumed) challengeConsumed = true; throw new Error(data.error || 'Request failed.'); }
    setBusy(false); render(data);
  } catch (error) {
    if (url === '/api/submit' && !receivedReply) challengeConsumed = true;
    status(error.name === 'TimeoutError' ? 'The lookup took too long. Please try again.' : error.message, true);
  }
  finally { setBusy(false); }
}
$('lookup-form').addEventListener('submit', event => { event.preventDefault(); $('captcha-form').hidden = true; send('/api/lookup', { gstin: $('gstin').value, previousId: challenge?.id }); });
$('captcha-form').addEventListener('submit', event => { event.preventDefault(); if (challenge) send('/api/submit', { id: challenge.id, captcha: $('captcha').value.trim() }); });
$('refresh').addEventListener('click', () => send('/api/lookup', { gstin: challenge?.gstin || $('gstin').value, manual: true, previousId: challenge?.id }));
$('gstin').addEventListener('input', () => { $('captcha-form').hidden = true; $('result').hidden = true; });
$('download').addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${result.gstin}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
