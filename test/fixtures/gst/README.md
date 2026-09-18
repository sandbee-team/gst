# Small GST OCR regression set

32 distinct CAPTCHA images collected sequentially from the public GST CAPTCHA endpoint on 2026-09-18. No cookies, session tokens or taxpayer details are stored. Images are for local regression/evaluation; they are no longer usable sessions.

`dev.json` contains 16 development images used to investigate preprocessing. `holdout.json` contains 16 other images kept out of preprocessing and threshold selection. Labels were visually reviewed against the original and rectified images. Holdout labels were written before running the finalized recognizer on those images. They were not verified through portal submissions; the live acceptance experiment is separate.

This small, same-day set does not represent every CAPTCHA style or establish a universal accuracy guarantee. Do not describe development-set results as held-out performance. If future changes are tuned using the holdout results, treat this set as regression data and collect a new evaluation set.
