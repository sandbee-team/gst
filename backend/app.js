'use strict';
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { z, ZodError } = require('zod');
const { AppError } = require('./errors');
const {
  hashToken,
  newToken,
  hashPassword,
  verifyPassword,
  csrfToken,
  equalToken,
} = require('./security');
const { GstService } = require('./gst-service');
const { createMailer } = require('./mailer');
const { OtpService } = require('./otp-service');

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(12, 'Use at least 12 characters.').max(128);
const credentials = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const signupSchema = z
  .object({ name: z.string().trim().min(2).max(80), email: emailSchema, password: passwordSchema })
  .strict();
const profileSchema = z
  .object({
    company: z.string().trim().min(2).max(100),
    useCase: z.enum(['invoicing', 'verification', 'development', 'other']),
  })
  .strict();
const keySchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const emptyBody = z.object({}).strict();
function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    company: user.company || '',
    useCase: user.useCase || '',
    onboarded: user.onboarded === true,
    emailVerified: Boolean(user.emailVerifiedAt),
    verificationResendAt: user.emailOtp?.sentAt ? new Date(+user.emailOtp.sentAt + 60000) : null,
    createdAt: user.createdAt,
    usage: user.usage || { total: 0, cached: 0, live: 0 },
    apiKey: user.apiKey
      ? {
          name: user.apiKey.name,
          prefix: user.apiKey.prefix,
          createdAt: user.apiKey.createdAt,
          lastUsedAt: user.apiKey.lastUsedAt,
        }
      : null,
  };
}
function createApp({
  db,
  config,
  liveLookup,
  mailer = createMailer(config),
  service = new GstService({ db, liveLookup, cacheMax: config.cacheMax }),
}) {
  const app = express(),
    users = db.collection('users');
  const otp = new OtpService({ db, config, mailer });
  const codeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.');
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Request-Id', randomUUID());
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  app.use(cookieParser());
  const limiter = (limit, windowMs, keyGenerator) =>
    rateLimit({
      limit,
      windowMs,
      keyGenerator,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
        }),
    });
  app.use('/api', limiter(300, 60000));
  const authLimiter = limiter(config.authLimit, 15 * 60000);
  const accountLimiter = limiter(config.apiLimit, 60000, (req) => req.user._id.toString());
  const cookies = {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionMs,
  };
  function originGuard(req, _res, next) {
    if (req.get('origin') !== config.appUrl)
      throw new AppError(403, 'ORIGIN_DENIED', 'This request must come from your Sandbee panel.');
    next();
  }
  async function sessionAuth(req, _res, next) {
    const token = req.cookies[config.cookieName];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
    const user = await users.findOne({
      sessions: { $elemMatch: { hash: hashToken(token), expiresAt: { $gt: new Date() } } },
    });
    if (!user)
      throw new AppError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.');
    req.user = user;
    req.sessionToken = token;
    next();
  }
  function csrf(req, _res, next) {
    if (!equalToken(req.get('x-csrf-token'), csrfToken(req.sessionToken, config.secret)))
      throw new AppError(403, 'CSRF_INVALID', 'Please reload the panel and try again.');
    next();
  }
  function verified(req, _res, next) {
    if (!req.user.emailVerifiedAt)
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before continuing.');
    next();
  }
  async function issueSession(res, user, extra = {}) {
    const token = newToken(),
      now = new Date();
    const sessionWrite = await users.updateOne(
      { _id: user._id, passwordHash: user.passwordHash },
      {
        $push: {
          sessions: {
            $each: [
              { hash: hashToken(token), expiresAt: new Date(now.getTime() + config.sessionMs) },
            ],
            $slice: -5,
          },
        },
      },
    );
    if (!sessionWrite.matchedCount)
      throw new AppError(401, 'UNAUTHENTICATED', 'Your credentials changed. Please sign in again.');
    res.cookie(config.cookieName, token, cookies);
    res.json({ user: publicUser(user), csrfToken: csrfToken(token, config.secret), ...extra });
  }
  app.get('/api/health', async (_req, res) => {
    await db.command({ ping: 1 });
    res.json({ status: 'ok', service: 'GSTIN by sandbee' });
  });
  app.post('/api/auth/signup', originGuard, authLimiter, async (req, res) => {
    const input = signupSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const user = {
      name: input.name,
      email: input.email,
      passwordHash,
      onboarded: false,
      createdAt: new Date(),
      sessions: [],
      usage: { total: 0, cached: 0, live: 0 },
    };
    try {
      const inserted = await users.insertOne(user);
      user._id = inserted.insertedId;
    } catch (error) {
      if (error.code === 11000)
        throw new AppError(
          409,
          'ACCOUNT_EXISTS',
          'An account with this email already exists. Please sign in.',
        );
      throw error;
    }
    let verificationError = '';
    try {
      await otp.send(user, 'verify');
    } catch {
      verificationError =
        'We could not send your verification email. Please request a new code shortly.';
    }
    await issueSession(res, await users.findOne({ _id: user._id }), { verificationError });
  });
  app.post('/api/auth/login', originGuard, authLimiter, async (req, res) => {
    const input = credentials.parse(req.body),
      user = await users.findOne({ email: input.email });
    if (!(await verifyPassword(input.password, user?.passwordHash)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    await issueSession(res, user);
  });
  app.get('/api/auth/me', sessionAuth, (req, res) =>
    res.json({ user: publicUser(req.user), csrfToken: csrfToken(req.sessionToken, config.secret) }),
  );
  app.post(
    '/api/auth/verification/send',
    originGuard,
    sessionAuth,
    csrf,
    authLimiter,
    async (req, res) => {
      emptyBody.parse(req.body);
      if (req.user.emailVerifiedAt) return res.json({ user: publicUser(req.user) });
      await otp.send(req.user, 'verify');
      res.json({ user: publicUser(await users.findOne({ _id: req.user._id })) });
    },
  );
  app.post(
    '/api/auth/verification/confirm',
    originGuard,
    sessionAuth,
    csrf,
    authLimiter,
    async (req, res) => {
      const { code } = z.object({ code: codeSchema }).strict().parse(req.body);
      const result = await otp.consume({ _id: req.user._id }, 'verify', code);
      res.json({ user: publicUser(result.user) });
    },
  );
  app.post('/api/auth/forgot-password', originGuard, authLimiter, async (req, res) => {
    const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
    otp.queueReset(email);
    res.json({
      ok: true,
      message: 'If an account exists for this email, a reset code will arrive shortly.',
      resendAfter: 60,
    });
  });
  app.post('/api/auth/reset/verify', originGuard, authLimiter, async (req, res) => {
    const { email, code } = z
      .object({ email: emailSchema, code: codeSchema })
      .strict()
      .parse(req.body);
    const { token } = await otp.consume({ email }, 'reset', code);
    res.json({ resetToken: token });
  });
  app.post('/api/auth/reset-password', originGuard, authLimiter, async (req, res) => {
    const { email, resetToken, password } = z
      .object({
        email: emailSchema,
        resetToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        password: passwordSchema,
      })
      .strict()
      .parse(req.body);
    const query = {
      email,
      'passwordReset.hash': hashToken(resetToken),
      'passwordReset.expiresAt': { $gt: new Date() },
    };
    if (!(await users.findOne(query, { projection: { _id: 1 } })))
      throw new AppError(
        400,
        'RESET_EXPIRED',
        'This reset session expired. Please request another code.',
      );
    const passwordHash = await hashPassword(password);
    query['passwordReset.expiresAt'] = { $gt: new Date() };
    const result = await users.updateOne(query, {
      $set: { passwordHash, sessions: [], emailVerifiedAt: new Date() },
      $unset: { apiKey: '', passwordReset: '', resetOtp: '', emailOtp: '' },
    });
    if (!result.matchedCount)
      throw new AppError(
        400,
        'RESET_EXPIRED',
        'This reset session expired. Please request another code.',
      );
    otp.notifyPasswordChanged(email);
    res.clearCookie(config.cookieName, { ...cookies, maxAge: undefined });
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', originGuard, sessionAuth, csrf, async (req, res) => {
    emptyBody.parse(req.body);
    await users.updateOne(
      { _id: req.user._id },
      { $pull: { sessions: { hash: hashToken(req.sessionToken) } } },
    );
    res.clearCookie(config.cookieName, { ...cookies, maxAge: undefined });
    res.json({ ok: true });
  });
  app.post('/api/auth/password', originGuard, sessionAuth, csrf, authLimiter, async (req, res) => {
    const input = z
      .object({ currentPassword: z.string().min(1).max(128), password: passwordSchema })
      .strict()
      .parse(req.body);
    if (!(await verifyPassword(input.currentPassword, req.user.passwordHash)))
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    await users.updateOne(
      { _id: req.user._id },
      {
        $set: { passwordHash: await hashPassword(input.password), sessions: [] },
        $unset: { apiKey: '', passwordReset: '', resetOtp: '', emailOtp: '' },
      },
    );
    otp.notifyPasswordChanged(req.user.email);
    res.clearCookie(config.cookieName, { ...cookies, maxAge: undefined });
    res.json({ ok: true });
  });
  app.post('/api/onboarding', originGuard, sessionAuth, csrf, verified, async (req, res) => {
    const profile = profileSchema.parse(req.body);
    await users.updateOne({ _id: req.user._id }, { $set: { ...profile, onboarded: true } });
    res.json({ user: publicUser({ ...req.user, ...profile, onboarded: true }) });
  });
  app.post('/api/keys', originGuard, sessionAuth, csrf, verified, async (req, res) => {
    if (!req.user.onboarded)
      throw new AppError(403, 'ONBOARDING_REQUIRED', 'Complete your workspace setup first.');
    const { name } = keySchema.parse(req.body),
      token = `sb_live_${newToken()}`;
    const apiKey = {
      name,
      hash: hashToken(token),
      prefix: token.slice(0, 16),
      createdAt: new Date(),
      lastUsedAt: null,
    };
    await users.updateOne({ _id: req.user._id }, { $set: { apiKey } });
    res.status(201).json({ token, apiKey: publicUser({ ...req.user, apiKey }).apiKey });
  });
  app.delete('/api/keys', originGuard, sessionAuth, csrf, async (req, res) => {
    await users.updateOne({ _id: req.user._id }, { $unset: { apiKey: '' } });
    res.json({ ok: true });
  });
  async function apiAuth(req, _res, next) {
    const match = /^Bearer (sb_live_[A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
    if (!match)
      throw new AppError(
        401,
        'INVALID_API_KEY',
        'Provide a valid API key using Authorization: Bearer <key>.',
      );
    const user = await users.findOne({
      'apiKey.hash': hashToken(match[1]),
      onboarded: true,
      emailVerifiedAt: { $type: 'date' },
    });
    if (!user)
      throw new AppError(401, 'INVALID_API_KEY', 'API key is invalid or has been revoked.');
    req.user = user;
    next();
  }
  async function respondLookup(req, res, gstin) {
    const started = Date.now();
    const result = await service.get(gstin);
    // Identity always comes from verified authentication, never request input.
    const update = {
      $inc: { 'usage.total': 1, [`usage.${result.source === 'database' ? 'cached' : 'live'}`]: 1 },
      $set: { 'usage.lastUsedAt': new Date() },
    };
    await users.updateOne({ _id: req.user._id }, update);
    if (req.user.apiKey)
      await users.updateOne(
        { _id: req.user._id, 'apiKey.hash': req.user.apiKey.hash },
        { $set: { 'apiKey.lastUsedAt': new Date() } },
      );
    res.json({
      success: true,
      data: result.data,
      meta: { source: result.source, fetchedAt: result.fetchedAt, elapsedMs: Date.now() - started },
    });
  }
  app.get('/api/v1/gstin/:gstin', apiAuth, accountLimiter, async (req, res) =>
    respondLookup(req, res, req.params.gstin),
  );
  app.post(
    '/api/playground',
    originGuard,
    sessionAuth,
    csrf,
    verified,
    accountLimiter,
    async (req, res) => {
      if (!req.user.onboarded || !req.user.apiKey)
        throw new AppError(
          403,
          'API_KEY_REQUIRED',
          'Generate your API key before using the playground.',
        );
      const { gstin } = z
        .object({ gstin: z.string().max(30) })
        .strict()
        .parse(req.body);
      await respondLookup(req, res, gstin);
    },
  );
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'API endpoint not found.')),
  );
  const dist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(dist, { index: false, maxAge: config.production ? '1h' : 0 }));
  app.get('/{*path}', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(dist, 'index.html'));
  });
  app.use((error, req, res, _next) => {
    let status = error.status || 500,
      code = error.code || 'INTERNAL_ERROR',
      message = error.message;
    if (error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Request body must contain valid JSON.';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body exceeds the 8 KB limit.';
    } else if (error instanceof ZodError) {
      status = 400;
      code = 'INVALID_INPUT';
      message = error.issues[0]?.message || 'Invalid request.';
    } else if (error.code === 'INVALID_GSTIN') status = 400;
    else if (error.code === 'GSTIN_NOT_FOUND') status = 404;
    else if (error.code === 'RATE_LIMITED') status = 429;
    else if (
      ['LOOKUP_TIMEOUT', 'TIMEOUT', 'CAPTCHA_UNCERTAIN', 'SERVICE_BUSY'].includes(error.code)
    )
      status = 503;
    else if (
      [
        'HTTP_ERROR',
        'ACCESS_DENIED',
        'INVALID_RESPONSE',
        'MISSING_COOKIE',
        'PORTAL_ERROR',
        'RESPONSE_TOO_LARGE',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ETIMEDOUT',
      ].includes(error.code)
    ) {
      status = 502;
      message = 'GST portal is temporarily unavailable. Please retry shortly.';
    }
    if (status >= 500 && !(error instanceof AppError) && ![502, 503].includes(status)) {
      console.error(
        JSON.stringify({
          event: 'request_failed',
          requestId: res.get('X-Request-Id'),
          type: error.name,
        }),
      );
      message = 'Service is temporarily unavailable. Please try again.';
      code = 'INTERNAL_ERROR';
    }
    if (status === 503) res.set('Retry-After', '30');
    res.status(status).json({ success: false, error: { code, message } });
  });
  app.locals.service = service;
  app.locals.otp = otp;
  return app;
}
module.exports = { createApp };
