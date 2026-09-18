'use strict';
const { randomInt, createHmac } = require('node:crypto');
const { newToken, equalToken, hashToken } = require('./security');
const { AppError } = require('./errors');
const invalid = () =>
  new AppError(
    400,
    'OTP_INVALID',
    'This code is incorrect, expired, or already used. Request a new code if needed.',
  );
class OtpService {
  constructor({ db, config, mailer }) {
    this.users = db.collection('users');
    this.secret = config.secret;
    this.mailer = mailer;
    this.deliveries = new Set();
  }
  digest(userId, purpose, nonce, code) {
    return createHmac('sha256', this.secret)
      .update(`${userId}:${purpose}:${nonce}:${code}`)
      .digest('hex');
  }
  async send(user, purpose) {
    const now = new Date(),
      field = purpose === 'verify' ? 'emailOtp' : 'resetOtp';
    const recent = (user.otpSends || []).filter((date) => date > new Date(now - 3600000));
    if (recent.length >= 5 || (user[field]?.sentAt && now - user[field].sentAt < 60000))
      throw new AppError(
        429,
        'OTP_COOLDOWN',
        'Please wait before requesting another code. You can request up to five codes per hour.',
      );
    const nonce = newToken(),
      code = randomInt(0, 1000000).toString().padStart(6, '0');
    const record = {
      nonce,
      hash: this.digest(user._id, purpose, nonce, code),
      sentAt: now,
      expiresAt: new Date(+now + 600000),
      attempts: 0,
    };
    // CAS makes concurrent resend requests share the same cooldown and hourly budget.
    const updated = await this.users.updateOne(
      { _id: user._id, otpVersion: user.otpVersion ?? { $exists: false } },
      {
        $set: { [field]: record, otpSends: [...recent, now] },
        $inc: { otpVersion: 1 },
      },
    );
    if (!updated.matchedCount)
      throw new AppError(
        429,
        'OTP_COOLDOWN',
        'A code was recently requested. Please wait a minute before trying again.',
      );
    try {
      await this.mailer.send({ to: user.email, code, purpose });
    } catch (error) {
      // Remove only this failed delivery, never a newer code. Retain the hourly abuse budget.
      await this.users.updateOne(
        { _id: user._id, [`${field}.nonce`]: nonce },
        { $unset: { [field]: '' } },
      );
      throw error;
    }
  }
  queueReset(email) {
    if (this.deliveries.size >= 16) return; // Bounded background delivery; public response stays uniform.
    const job = this.users
      .findOne({ email })
      .then((user) => user && this.send(user, 'reset'))
      .catch((error) => {
        if (error.code !== 'OTP_COOLDOWN')
          console.warn(JSON.stringify({ event: 'otp_delivery_failed', code: 'MAIL_UNAVAILABLE' }));
      });
    this.deliveries.add(job);
    job.finally(() => this.deliveries.delete(job));
  }
  notifyPasswordChanged(email) {
    if (!this.mailer.passwordChanged) return;
    const job = this.mailer
      .passwordChanged(email)
      .catch(() => console.warn(JSON.stringify({ event: 'password_notice_failed' })));
    this.deliveries.add(job);
    job.finally(() => this.deliveries.delete(job));
  }
  async consume(query, purpose, code) {
    const field = purpose === 'verify' ? 'emailOtp' : 'resetOtp';
    const user = await this.users.findOneAndUpdate(
      { ...query, [`${field}.expiresAt`]: { $gt: new Date() }, [`${field}.attempts`]: { $lt: 5 } },
      { $inc: { [`${field}.attempts`]: 1 } },
      { returnDocument: 'after' },
    );
    if (
      !user ||
      !equalToken(user[field].hash, this.digest(user._id, purpose, user[field].nonce, code))
    )
      throw invalid();
    const token = purpose === 'reset' ? newToken() : null;
    const result = await this.users.findOneAndUpdate(
      {
        _id: user._id,
        [`${field}.nonce`]: user[field].nonce,
        [`${field}.expiresAt`]: { $gt: new Date() },
      },
      {
        $unset: { [field]: '' },
        $set:
          purpose === 'verify'
            ? { emailVerifiedAt: new Date() }
            : {
                passwordReset: { hash: hashToken(token), expiresAt: new Date(Date.now() + 600000) },
              },
      },
      { returnDocument: 'after' },
    );
    if (!result) throw invalid();
    return { user: result, token };
  }
}
module.exports = { OtpService };
