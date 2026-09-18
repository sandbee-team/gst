import unittest
import json
from pathlib import Path
import cv2
import numpy as np
from captcha_ocr import decode_ctc, clean_grid, Solver, select_candidate
from captcha_preprocess import rectify_fisheye


class OcrTests(unittest.TestCase):
    def test_ctc_repeats_and_leading_zero(self):
        result = {'charsets': ['', '0', '1'], 'probability': [
            [.01, .98, .01], [.02, .97, .01], [.98, .01, .01],
            [.01, .97, .02], [.99, .005, .005], [.01, .01, .98]]}
        text, score = decode_ctc(result)
        self.assertEqual(text, '001')
        self.assertAlmostEqual(score, .97)

    def test_empty_ctc(self):
        self.assertEqual(decode_ctc({'charsets': [''], 'probability': [[1.0]]}), ('', 0.0))

    def test_cleanup_keeps_image_dimensions_and_type(self):
        image = np.full((50, 182, 3), 200, dtype=np.uint8)
        image[:, ::6] = 0
        image[::6, :] = 0
        cv2.line(image, (0, 20), (181, 30), (0, 0, 255), 1)
        cleaned = clean_grid(image)
        self.assertEqual(cleaned.shape, image.shape)
        self.assertEqual(cleaned.dtype, image.dtype)
        self.assertGreater(np.mean(cleaned[:, ::6]), np.mean(image[:, ::6]))

    def test_invalid_image_rejected_before_inference(self):
        solver = Solver.__new__(Solver)
        with self.assertRaises(ValueError):
            solver.solve(b'not an image')

    def test_flat_images_are_not_mistaken_for_fisheye(self):
        for intensity in [0, 100, 255]:
            self.assertIsNone(rectify_fisheye(np.full((50, 182, 3), intensity, np.uint8)))

    def test_real_grid_is_detected_with_unique_geometry(self):
        image = cv2.imread(str(Path(__file__).parent / 'fixtures/gst/dev-01.png'))
        result = rectify_fisheye(image)
        self.assertEqual(result['radius'], 51)
        self.assertEqual(result['fit'], 1.0)
        self.assertEqual(result['image'].shape, image.shape)

    def test_high_confidence_conflict_is_not_auto_submitted(self):
        candidates = [{'text': '111111', 'score': .999, 'variant': 'raw', 'model': 'beta'},
                      {'text': '111111', 'score': .99, 'variant': 'clean', 'model': 'standard'},
                      {'text': '111112', 'score': .99, 'variant': 'raw', 'model': 'standard'}]
        self.assertFalse(select_candidate(candidates)['autoSubmit'])

    def test_same_model_repeated_views_do_not_count_as_consensus(self):
        candidates = [{'text': '001122', 'score': .999, 'variant': variant, 'model': 'beta'} for variant in ['raw', 'clean']]
        self.assertFalse(select_candidate(candidates)['autoSubmit'])

    def test_agreement_preserves_zeroes(self):
        candidates = [{'text': '001122', 'score': .99, 'variant': 'raw', 'model': model} for model in ['beta', 'standard']]
        selected = select_candidate(candidates)
        self.assertTrue(selected['autoSubmit'])
        self.assertEqual(selected['text'], '001122')


class RealImageRegression(unittest.TestCase):
    def test_frozen_holdout_predictions_and_abstention(self):
        folder = Path(__file__).parent / 'fixtures/gst'
        solver = Solver()
        accepted = 0
        for sample in json.loads((folder / 'holdout.json').read_text()):
            with self.subTest(image=sample['image']):
                result = solver.solve((folder / sample['image']).read_bytes())
                self.assertEqual(result['text'], sample['label'])
                accepted += result['autoSubmit']
        self.assertGreaterEqual(accepted, 15)


if __name__ == '__main__':
    unittest.main()
