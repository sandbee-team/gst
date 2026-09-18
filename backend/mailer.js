'use strict';
const nodemailer = require('nodemailer');
const { AppError } = require('./errors');
function createMailer(config) {
  const mail = config.mail;
  const transport = mail?.host
    ? nodemailer.createTransport({
        host: mail.host,
        port: mail.port,
        secure: mail.port === 465,
        ...(mail.user ? { auth: { user: mail.user, pass: mail.password } } : {}),
        requireTLS: mail.host === 'smtp.gmail.com',
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
        logger: false,
        debug: false,
      })
    : null;
  return {
    async passwordChanged(to) {
      if (!transport) return;
      await transport.sendMail({
        from: { name: 'GSTIN by sandbee', address: mail.from },
        to,
        subject: 'Your password was changed | GSTIN by sandbee',
        text: 'Your GSTIN by sandbee password was changed. All previous sessions and your API key have been revoked. If you did not make this change, use Forgot password on the sign-in page to secure your account immediately.',
      });
    },
    async send({ to, code, purpose }) {
      if (!transport)
        throw new AppError(
          503,
          'MAIL_UNAVAILABLE',
          'Email delivery is temporarily unavailable. Please try again shortly.',
        );
      const reset = purpose === 'reset';
      const title = reset ? 'Reset your password' : 'Verify your email';
      // Only a server-generated numeric code enters the HTML. No account input is interpolated.
      const message = `Your GSTIN by sandbee ${reset ? 'password reset' : 'email verification'} code is ${code}. It expires in 10 minutes. Never share this code. If you did not request it, ignore this email.`;
      try {
        await transport.sendMail({
          from: { name: 'GSTIN by sandbee', address: mail.from },
          to,
          subject: `${title} | GSTIN by sandbee`,
          text: message,
          html: `<div style="background:#f4f7f4;padding:40px 16px;font-family:Arial,sans-serif;color:#193d30"><div style="max-width:460px;margin:auto;background:white;border:1px solid #dfe9e0;border-radius:16px;padding:32px"><p style="font-weight:bold;font-size:20px">GSTIN <span style="font-size:12px;color:#758a7b">by sandbee</span></p><h1 style="font-size:25px">${title}</h1><p style="color:#617567;line-height:1.7">Enter this one-time code to ${reset ? 'securely reset your password' : 'continue setting up your workspace'}.</p><div style="padding:24px;background:#edf5eb;text-align:center;font-size:34px;letter-spacing:9px;font-weight:bold;border-radius:10px">${code}</div><p style="font-size:12px;color:#788879;line-height:1.7">Expires in 10 minutes. Never share this code.<br>If you did not request this email, you can safely ignore it.</p></div></div>`,
        });
      } catch {
        throw new AppError(
          503,
          'MAIL_UNAVAILABLE',
          'Email delivery is temporarily unavailable. Please try again shortly.',
        );
      }
    },
  };
}
module.exports = { createMailer };
