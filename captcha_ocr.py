"""Local GST OCR. Use an image path or --worker (JSON lines on stdin/stdout)."""
import argparse
import base64
import io
import json
import re
import sys
import time
from pathlib import Path

import cv2
import ddddocr
import numpy as np
from PIL import Image
from captcha_preprocess import clean_grid, rectify_fisheye


def decode_ctc(result):
    """Collapse repeats, preserving repeated digits separated by blank."""
    chars, scores = [], []
    previous = None
    for row in result['probability']:
        index = int(np.argmax(row))
        char = result['charsets'][index]
        score = float(row[index])
        if char and char != previous:
            chars.append(char)
            scores.append(score)
        elif char and char == previous:
            scores[-1] = max(scores[-1], score)
        previous = char
    return ''.join(chars), min(scores, default=0.0)


def select_candidate(candidates):
    """Require two models to agree; never turn an OCR score into a probability."""
    groups = {}
    for item in candidates:
        if re.fullmatch(r'[0-9]{6}', item['text']):
            group = groups.setdefault(item['text'], {})
            old = group.get(item['model'])
            if old is None or item['score'] > old['score']:
                group[item['model']] = item
    eligible = []
    for text, models in groups.items():
        if len(models) == 2:
            score = min(item['score'] for item in models.values())
            if score >= 0.8:
                eligible.append({'text': text, 'score': score, 'variant': max(models.values(), key=lambda c: c['score'])['variant']})
    # A conflicting high-score output is cause for manual review or a fresh image.
    strong_texts = {c['text'] for c in candidates if re.fullmatch(r'[0-9]{6}', c['text']) and c['score'] >= .9}
    if len(eligible) == 1 and len(strong_texts - {eligible[0]['text']}) == 0:
        return {**eligible[0], 'valid': True, 'autoSubmit': True, 'reason': 'Two models agree.'}
    valid = [c for c in candidates if re.fullmatch(r'[0-9]{6}', c['text'])]
    best = max(valid or candidates, key=lambda c: c['score'])
    return {**best, 'valid': bool(valid), 'autoSubmit': False,
            'reason': 'Conflicting predictions.' if len(strong_texts) > 1 else 'Insufficient model agreement.'}


class Solver:
    def __init__(self):
        self.models = {'beta': ddddocr.DdddOcr(show_ad=False, beta=True),
                       'standard': ddddocr.DdddOcr(show_ad=False)}
        for model in self.models.values():
            model.set_ranges('0123456789')

    def solve(self, data):
        started = time.perf_counter()
        if not data or len(data) > 2 * 1024 * 1024:
            raise ValueError('Image is too large')
        try:
            with Image.open(io.BytesIO(data)) as header:
                width, height = header.size
                if min(width, height) < 10 or max(width, height) > 1024 or width * height > 262144:
                    raise ValueError('Invalid CAPTCHA image dimensions')
        except (OSError, Image.DecompressionBombError) as error:
            raise ValueError('Invalid CAPTCHA image') from error
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or min(image.shape[:2]) < 10 or max(image.shape[:2]) > 2048:
            raise ValueError('Invalid CAPTCHA image dimensions')
        geometry = rectify_fisheye(image)
        if geometry:
            variants = [('rectified', geometry['image']), ('rectified-crop', geometry['cropped'])]
        else:
            ink = (np.max(image, axis=2) < 60).astype(np.uint8) * 255
            opened = 255 - cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
            variants = [('cleaned', clean_grid(image)), ('original', image), ('opened', opened)]
        candidates = []
        for name, variant in variants:
            encoded = cv2.imencode('.png', variant)[1].tobytes()
            for model_name, model in self.models.items():
                text, score = decode_ctc(model.classification(encoded, probability=True))
                candidates.append({'text': text, 'score': round(score, 4), 'variant': name, 'model': model_name})
            best = select_candidate(candidates)
            if best['autoSubmit']:
                break
        return {**best, 'elapsedMs': round((time.perf_counter() - started) * 1000, 2),
                'candidates': candidates, 'engine': 'ddddocr-ensemble',
                'preprocessing': {'style': 'fisheye-grid', 'fit': geometry['fit'], 'radius': geometry['radius']}
                if geometry else {'style': 'generic'}}


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', nargs='?')
    parser.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    solver = Solver()
    if args.worker:
        emit({'ready': True})
        for line in sys.stdin:
            message = {}
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError('Expected a JSON object')
                result = solver.solve(base64.b64decode(message['image'], validate=True))
                emit({'id': message['id'], 'result': result})
            except Exception as error:
                emit({'id': message.get('id') if isinstance(message, dict) else None, 'error': str(error)})
    elif args.image:
        emit(solver.solve(Path(args.image).read_bytes()))
    else:
        parser.error('Provide an image path or --worker')


if __name__ == '__main__':
    main()
