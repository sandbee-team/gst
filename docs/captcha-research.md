# CAPTCHA research and implementation decision

Research performed for this repository on 18 September 2026. Sources below are upstream repositories, research papers or official documentation. The final implementation reverses a detected distortion pattern and uses two local models with abstention and bounded retries. Its small evaluation set does not establish universal accuracy.

## Supplied repositories

| Project | What the upstream code provides | Fit for this repository |
| --- | --- | --- |
| [decryptr/captcha](https://github.com/decryptr/captcha) | R/Torch tooling for labeling, training and inference, with published models for several Brazilian CAPTCHA sources. Its listed pretrained models do not include Indian GST. | Useful training workflow reference. Introducing R and assuming its released weights recognize GST would be unjustified. |
| [ninadpatil09/Captcha-Recognition](https://github.com/ninadpatil09/Captcha-Recognition) | A character CNN with five fixed image crops. The [notebook](https://github.com/ninadpatil09/Captcha-Recognition/blob/main/Captcha_Recognition.ipynb) reports 1,070 samples and 19 characters; the vocabulary excludes `0`, `1`, and `9`. | The portal here uses six digits, including digits absent from that vocabulary. The model/crop layout cannot be dropped into this flow unchanged. |

Neither project's reported accuracy can be transferred to GST images without testing on labeled GST data. No code or model weights from these two repositories were copied into the application.

## Other approaches investigated

- [Tesseract's quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html) recommends preprocessing, suitable page segmentation and character restrictions. The existing script already restricts digits but runs OCR repeatedly across fixed slices. In a local check it returned an empty whole-image result and an incomplete sliced result, taking about 1.09 seconds. This is one observation, not a general comparison of OCR engines.
- [ddddocr](https://github.com/sml2h3/ddddocr) provides local model inference, a beta model, character restrictions and probability output. Its documentation recommends initializing once. We installed and inspected **1.5.6**: that version's probability output is per CTC timestep, so it needs repeat/blank decoding. The script preserves repeated digits separated by blank and does not coerce predictions into integers.
- [Keras' CAPTCHA OCR example](https://keras.io/examples/vision/captcha_ocr/) demonstrates CNN/RNN recognition with CTC and labeled image data. It is a useful future training reference when a representative GST dataset exists; its example dataset is not proof of GST accuracy.
- [ONNX Runtime threading documentation](https://onnxruntime.ai/docs/performance/tune-performance/threading.html) describes CPU session thread controls. This implementation retains the packaged model runtime defaults and runs one persistent worker, avoiding repeated model loading. Thread tuning should follow workload measurement, rather than being presented as a universal optimization.

## Why the initial OCR was insufficient

The first version removed long grid lines and used one model's score. More varied development images revealed heavily enlarged central digits, and some wrong predictions had high model scores. A high score alone was insufficient. This is consistent with the distinction between neural-network confidence and calibrated correctness discussed in [Guo et al., On Calibration of Modern Neural Networks](https://arxiv.org/abs/1706.04599). We did not fit a statistical calibration model on this small dataset.

Generic erosion and broader row removal did not reliably solve the distortion. We evaluated raw images, two inpainting methods, morphological opening and both packaged models on development samples before selecting the final approach.

## Main improvement: recognize and reverse the distortion

[SimpleCaptcha's official documentation](https://simplecaptcha.sourceforge.net/custom_images.html) describes a fish-eye renderer. Its [FishEyeGimpyRenderer source in the JBoss component archive](https://lists.jboss.org/archives/list/gatein-commits%40lists.jboss.org/thread/QMFY4AZFWVEHYHTLN5SECUE6QPA6YENY/) supplies a radial transformation and regular grid geometry. The normalized radial formula is `g(s) = -0.75s³ + 1.5s² + 0.25s`, with a radius selected between one-quarter and one-third of the image width.

**Inference from image evidence:** the portal samples match this geometry. This is not a claim that we inspected or know the portal's server implementation. The best radius predicted the dark grid positions exactly in all 16 development images, and was distinctly better than neighboring radii.

`captcha_preprocess.py` independently implements detection and inverse pixel accumulation. It requires a strong, unambiguous grid fit before applying this transformation; uniform dark images and unrelated dimensions are rejected by the style detector. Unknown styles keep the generic preprocessing path. The implementation preserves Java's truncation semantics when matching the pixel geometry.

After reconstruction, grid positions, red strokes and unsampled pixels are filled using [OpenCV inpainting](https://docs.opencv.org/4.13.0/df/d3d/tutorial_py_inpainting.html). A cropped variant is tried only for the detected style when the full reconstruction remains uncertain. There is no training on the evaluation labels.

## Agreement and recovery

The beta and standard ddddocr models both evaluate each candidate. Submission requires the same six digits, adequate scores from both models, and no conflicting high-score prediction among evaluated candidates. Alternate views of the same model do not count as a second model. These models are related, so their agreement is not statistical independence and is not a guarantee.

Low-confidence images are refreshed within a three-challenge budget without submitting guesses. Remaining uncertainty becomes editable manual input. An OCR startup failure immediately allows manual entry. Worker crashes, malformed output and timeouts reject outstanding work and permit a clean worker restart.

The image and complete response cookie values stay paired in memory. CAPTCHA GET retries one transient connection failure. A transient automatic POST failure starts a new challenge rather than replaying a possibly consumed challenge. An explicit rejected CAPTCHA likewise starts fresh. HTTP 403/429 stops the flow. Native HTTPS keeps TLS verification enabled, requests have 15-second deadlines, and an automatic lookup has a 60-second cancellation deadline. Browser expiry and lost-response handling prevent reuse of stale manual submissions.

## Reproducible measured results

32 unique, same-day images were split into 16 development and 16 holdout images. The final preprocessing and agreement rules were selected using development images, before running recognition on the holdout. Labels were visually reviewed; these offline labels were not portal-verified. The [fixture notes](../test/fixtures/gst/README.md) state the provenance and limitations.

| Metric on 16 holdout images | Initial solver | Improved solver |
| --- | ---: | ---: |
| Exact six-digit matches | 7/16 | 16/16 |
| Eligible for automatic submission | 2/16 | 15/16 |
| Wrong eligible predictions | 1 | 0 |
| Median warm OCR time | 28.69 ms | 32.28 ms |

Reports: [frozen baseline](ocr-baseline-holdout.json), [improved holdout](ocr-improved-holdout.json), and [development results](ocr-development.json). All images remain available for review and regression tests. Reusing these holdout results for future tuning would turn the set into development/regression data; future evaluations should use new images.

A separate [fresh live experiment](ocr-live-verification.json) used the user-supplied GSTIN and the completed lookup flow. All **10/10 lookups succeeded**. It fetched 11 images, abstained on one uncertain image, and submitted 10 predictions: **all 10 were accepted**, with zero CAPTCHA rejections. Median total lookup latency was **1,010.5 ms**; median OCR across those 11 images was **33.85 ms**. These are observed timings, not service guarantees. No cookies or taxpayer details are included in the report.

The build also passes 30 Node tests, 10 Python tests and 4 browser tests, including worker lifecycle, stale sessions, network recovery and mobile interactions.

## Limits and next validation

Sixteen same-day holdout images and ten live successes are too few to claim that every future CAPTCHA will work. Format changes, information lost through distortion, new fonts, nonnumeric challenges and portal availability remain real limits. The small set also does not establish leading-zero image accuracy; leading-zero handling is covered by decoder/transport tests.

The geometry detector falls back when its visual evidence does not fit. The portal's response, not the OCR score, determines successful lookup. If measured coverage drops on new samples, collect separately reviewed data, keep a fresh holdout, and evaluate a GST-specific sequence model. `scripts/benchmark-ocr.py` rejects duplicate images and reports exact matches, abstention coverage and wrong eligible guesses; `scripts/verify-live.js` measures bounded live acceptance without persisting sessions or taxpayer details.
