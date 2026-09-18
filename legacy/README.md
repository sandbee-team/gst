# Legacy NestJS snippets

These are the original files from before the working app existed. They are kept
for reference only — **nothing in the running app imports them.**

| File | What it was |
|------|-------------|
| `getGstCaptcha.ts` | Bare class method that fetched the CAPTCHA and pulled `CaptchaCookie` out of the response headers |
| `getGstDetails.ts` | Bare class method that posted `{gstin, captcha}`, plus the GSTIN checksum helper |
| `gst-details.request.dto.ts` | `class-validator` DTO for the request body |
| `constants.js` | URLs, regexes and GST error codes |

They are **not compilable as-is**: the two `.ts` files are class methods sitting at
file top level, they reference `axios`, `ResultEntity`, `ErrorEntity`, `HttpStatus`
and `this.logger` without importing or defining them, and `constants.js` never
exports `CONSTANTS` even though both files import it.

Known bugs that the current app does not share:

- The error branch keys off `gstData?.message === null`, but the live API returns a
  CAPTCHA failure as a top-level `errorCode` and a bad GSTIN as a nested
  `error.error_cd`. An invalid GSTIN is never caught, and the response object is
  left `undefined` — a success with no data.
- `gstData.pradr.adr` throws for GSTINs with no principal address (cancelled
  registrations); it needs optional chaining.

The maintained implementation lives in [`../lib/`](../lib/).
