"""Offline exact-match benchmark. Manifest: [{"image":"path.png","label":"001122"}]."""
import argparse
import hashlib
import json
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from captcha_ocr import Solver, decode_ctc
from captcha_preprocess import clean_grid
import cv2
import ddddocr
import numpy as np


class BaselineSolver:
    """Frozen initial version: beta model, cleaned/raw variants, score >= 0.8."""
    def __init__(self):
        self.model = ddddocr.DdddOcr(show_ad=False, beta=True)
        self.model.set_ranges('0123456789')

    def solve(self, data):
        import time
        start = time.perf_counter()
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        candidates = []
        for name, variant in [('cleaned', clean_grid(image)), ('original', image)]:
            text, score = decode_ctc(self.model.classification(cv2.imencode('.png', variant)[1].tobytes(), probability=True))
            candidates.append({'text': text, 'score': score, 'variant': name})
            if re.fullmatch(r'[0-9]{6}', text) and score >= .9:
                break
        valid = [c for c in candidates if re.fullmatch(r'[0-9]{6}', c['text'])]
        best = max(valid or candidates, key=lambda c: c['score'])
        return {**best, 'valid': bool(valid), 'autoSubmit': bool(valid) and best['score'] >= .8,
                'elapsedMs': (time.perf_counter() - start) * 1000}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('manifest', type=Path)
parser.add_argument('--baseline', action='store_true', help='Run the frozen original solver for comparison')
parser.add_argument('--output', type=Path, help='Write the complete JSON report')
args = parser.parse_args()
samples = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
if not samples:
    parser.error('Manifest must contain labeled samples')
seen = set()
for sample in samples:
    if not isinstance(sample.get('label'), str) or not re.fullmatch(r'[0-9]{6}', sample['label']):
        parser.error('Every label must be a string of exactly six digits')
    digest = hashlib.sha256((args.manifest.parent / sample['image']).read_bytes()).hexdigest()
    if digest in seen:
        parser.error('Duplicate image content would inflate accuracy')
    seen.add(digest)
solver = BaselineSolver() if args.baseline else Solver()
# Warm up separately; startup and first-inference latency are excluded below.
solver.solve((args.manifest.parent / samples[0]['image']).read_bytes())
rows = []
for sample in samples:
    prediction = solver.solve((args.manifest.parent / sample['image']).read_bytes())
    rows.append({**prediction, 'image': sample['image'], 'expected': sample['label'],
                 'correct': prediction['text'] == sample['label']})
accepted = [r for r in rows if r['autoSubmit'] and r['score'] >= .8]
report = {'solver': 'baseline' if args.baseline else 'ensemble-fisheye',
                  'samples': len(rows), 'correct': sum(r['correct'] for r in rows),
                  'autoSubmitted': len(accepted), 'autoSubmitErrors': sum(not r['correct'] for r in accepted),
                  'exactMatch': sum(r['correct'] for r in rows) / len(rows),
                  'autoSubmitCoverage': len(accepted) / len(rows),
                  'acceptedExactMatch': sum(r['correct'] for r in accepted) / len(accepted) if accepted else None,
                  'medianMs': round(statistics.median(r['elapsedMs'] for r in rows), 2), 'results': rows}
if args.output:
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'results'}, indent=2))
