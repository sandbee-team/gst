'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/saas');
const { readConfig } = require('../backend/config');
const password = 'Initial-password-129!';
let env, sequence = 0;
before(async () => { env = await startTestApp(); });
after(async () => { await env?.close(); });
async function signup() {
  const email = `otp-${++sequence}@example.test`;
  const result = await env.request('/api/auth/signup', { method: 'POST', body: { name: 'OTP User', email, password } });
  assert.equal(result.status, 200);
  return { email, cookie: result.cookie, csrf: result.body.csrfToken, result, code: env.mailbox.findLast(m => m.to === email).code };
}
const post = (route, auth, body) => env.request(route, { ...auth, method: 'POST', body });
async function resetCode(email) {
  const res = await post('/api/auth/forgot-password', {}, { email });
  await Promise.allSettled(env.app.locals.otp.deliveries);
  return { response: res, code: env.mailbox.findLast(m => m.to === email && m.purpose === 'reset')?.code };
}
test('email verification gates onboarding and API keys without exposing OTPs', async () => {
  const auth = await signup();
  assert.equal(auth.result.body.user.emailVerified, false);
  const saved = await env.db.collection('users').findOne({ email: auth.email });
  assert.notEqual(saved.emailOtp.hash, auth.code); assert.equal(saved.emailOtp.hash.length, 64);
  assert.ok(!JSON.stringify(auth.result.body).includes(saved.emailOtp.hash));
  for(const [route, body] of [['/api/onboarding',{company:'Workspace',useCase:'development'}],['/api/keys',{name:'Key'}],['/api/playground',{gstin:'09AAFPC6958E1ZN'}]]) {
    assert.equal((await post(route,auth,body)).body.error.code,'EMAIL_NOT_VERIFIED');
  }
  const confirmed = await post('/api/auth/verification/confirm', auth, { code: auth.code });
  assert.equal(confirmed.status,200); assert.equal(confirmed.body.user.emailVerified,true);
  assert.equal((await post('/api/auth/verification/confirm', auth, { code: auth.code })).status,400);
  assert.equal((await post('/api/onboarding',auth,{company:'Workspace',useCase:'development'})).status,200);
  assert.equal((await post('/api/keys',auth,{name:'Key'})).status,201);
});
test('OTP expiry, five-attempt limit, resend cooldown and replacement are enforced', async () => {
  const auth = await signup(), wrong = auth.code === '000000' ? '111111' : '000000';
  assert.equal((await post('/api/auth/verification/send',auth,{})).status,429);
  for(let i=0;i<5;i++) assert.equal((await post('/api/auth/verification/confirm',auth,{code:wrong})).status,400);
  assert.equal((await post('/api/auth/verification/confirm',auth,{code:auth.code})).status,400);
  await env.db.collection('users').updateOne({email:auth.email},{$set:{'emailOtp.sentAt':new Date(0)}});
  const sends=await Promise.all([post('/api/auth/verification/send',auth,{}),post('/api/auth/verification/send',auth,{})]);
  assert.deepEqual(sends.map(r=>r.status).sort(),[200,429]);
  const latest=env.mailbox.findLast(m=>m.to===auth.email).code;
  await env.db.collection('users').updateOne({email:auth.email},{$set:{'emailOtp.expiresAt':new Date(0)}});
  assert.equal((await post('/api/auth/verification/confirm',auth,{code:latest})).status,400);
});
test('only one concurrent verification can consume a code', async () => {
  const auth=await signup();
  const results=await Promise.all(Array.from({length:3},()=>post('/api/auth/verification/confirm',auth,{code:auth.code})));
  assert.equal(results.filter(r=>r.status===200).length,1);
});
test('forgot-password responses do not reveal accounts and purposes cannot be swapped', async () => {
  const auth=await signup();
  const known=await resetCode(auth.email),unknown=await resetCode('unknown@example.test');
  assert.deepEqual(known.response.body,unknown.response.body);
  assert.equal(unknown.code,undefined);
  if(known.code!==auth.code) assert.equal((await post('/api/auth/reset/verify',{}, {email:auth.email,code:auth.code})).status,400);
  const count=env.mailbox.length;await resetCode(auth.email);assert.equal(env.mailbox.length,count);
  assert.equal((await post('/api/auth/reset/verify',{}, {email:'unknown@example.test',code:known.code})).status,400);
});
test('password reset requires a one-time grant and revokes sessions and API keys', async () => {
  const auth=await signup();await post('/api/auth/verification/confirm',auth,{code:auth.code});
  await post('/api/onboarding',auth,{company:'Reset workspace',useCase:'development'});
  const key=(await post('/api/keys',auth,{name:'Before reset'})).body.token;
  const {code}=await resetCode(auth.email);
  const verify=await post('/api/auth/reset/verify',{}, {email:auth.email,code});assert.equal(verify.status,200);
  assert.equal((await post('/api/auth/reset/verify',{}, {email:auth.email,code})).status,400);
  const body={email:auth.email,resetToken:verify.body.resetToken,password:'Updated-password-837!'};
  assert.equal((await post('/api/auth/reset-password',{}, {...body,email:'different@example.test'})).status,400);
  const results=await Promise.all([post('/api/auth/reset-password',{},body),post('/api/auth/reset-password',{},body)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  assert.equal((await env.request('/api/auth/me',auth)).status,401);
  assert.equal((await env.request('/api/v1/gstin/09AAFPC6958E1ZN',{key})).status,401);
  assert.equal((await post('/api/auth/login',{}, {email:auth.email,password})).status,401);
  assert.equal((await post('/api/auth/login',{}, {email:auth.email,password:body.password})).status,200);
  const saved=await env.db.collection('users').findOne({email:auth.email});
  assert.equal(saved.passwordReset,undefined);assert.equal(saved.resetOtp,undefined);assert.equal(saved.apiKey,undefined);
});
test('expired grants cannot change passwords and SMTP failure never verifies an account', async () => {
  const auth=await signup(), {code}=await resetCode(auth.email);
  const grant=await post('/api/auth/reset/verify',{}, {email:auth.email,code});
  await env.db.collection('users').updateOne({email:auth.email},{$set:{'passwordReset.expiresAt':new Date(0)}});
  assert.equal((await post('/api/auth/reset-password',{}, {email:auth.email,resetToken:grant.body.resetToken,password:'Should-not-change-187!'})).status,400);
  const failed=await startTestApp({mailer:{send:async()=>{throw Error('private SMTP diagnostic');}}});
  try {
    const res=await failed.request('/api/auth/signup',{method:'POST',body:{name:'Failure User',email:'mail-failure@example.test',password}});
    assert.equal(res.status,200);assert.equal(res.body.user.emailVerified,false);assert.ok(res.body.verificationError);assert.ok(!JSON.stringify(res.body).includes('private SMTP'));
    assert.equal((await failed.db.collection('users').findOne({email:'mail-failure@example.test'})).emailOtp,undefined);
  } finally {await failed.close();}
});
test('Gmail configuration uses TLS and accepts spaced app passwords', () => {
  const config=readConfig({NODE_ENV:'production',APP_URL:'https://gstapi.sandbee.in',MONGODB_URI:'mongodb://localhost/test',SESSION_SECRET:'a'.repeat(48),GMAIL_USER:'sender@example.com',GMAIL_APP_PASSWORD:'abcd efgh ijkl mnop'});
  assert.equal(config.mail.host,'smtp.gmail.com');assert.equal(config.mail.port,465);assert.equal(config.mail.password,'abcdefghijklmnop');
  assert.throws(()=>readConfig({NODE_ENV:'production',APP_URL:'https://gstapi.sandbee.in',MONGODB_URI:'mongodb://localhost/test',SESSION_SECRET:'a'.repeat(48)}),/Gmail/);
});
