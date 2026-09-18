"""Image-based recognition and inversion of SimpleCaptcha-style fish-eye grids.

This detects a visual pattern; it does not assume the portal's server software.
Formula reference: SimpleCaptcha FishEyeGimpyRenderer (see research notes).
"""
from functools import lru_cache

import cv2
import numpy as np


@lru_cache(maxsize=2)
def fisheye_maps(height, width):
    yy, xx = np.indices((height, width))
    dx, dy = xx - width // 2, yy - height // 2
    distance = np.hypot(dx, dy)
    x_step, y_step = width // (width // 7 + 1), height // (height // 7 + 1)
    maps = []
    for radius in range(width // 4, width // 3 + 1):
        s = distance / radius
        factor = (-0.75 * s ** 3 + 1.5 * s ** 2 + 0.25 * s) * radius / np.maximum(distance, 1e-8)
        # Java's cast truncates towards zero, including negative offsets.
        sx = np.where(distance < radius, width // 2 + np.trunc(factor * dx), xx).astype(np.int32)
        sy = np.where(distance < radius, height // 2 + np.trunc(factor * dy), yy).astype(np.int32)
        expected_grid = ((sx % x_step == 0) | (sy % y_step == 0))
        evidence = expected_grid & (distance < radius) & (xx > 0) & (yy > 0) & (yy < height - 1)
        indices = (sy * width + sx).ravel()
        maps.append((radius, indices, evidence))
    return maps


def rectify_fisheye(image):
    height, width = image.shape[:2]
    # Limit geometry search and only use it where the supported style is plausible.
    if not (120 <= width <= 320 and 30 <= height <= 100 and 2 <= width / height <= 6):
        return None
    black = np.max(image, axis=2) < 60
    ranked = sorted(((float(black[evidence].mean()), radius, indices)
                     for radius, indices, evidence in fisheye_maps(height, width)),
                    key=lambda item: item[0], reverse=True)
    fit, radius, indices = ranked[0]
    margin = fit - ranked[1][0]
    # Flat/dark images can match many radii; require an unambiguous grid fit.
    if fit < 0.98 or margin < 0.02:
        return None
    counts = np.bincount(indices, minlength=height * width)
    channels = [np.bincount(indices, weights=image[:, :, c].ravel(), minlength=height * width)
                / np.maximum(counts, 1) for c in range(3)]
    restored = np.stack(channels, axis=1).reshape(height, width, 3).astype(np.uint8)
    yy, xx = np.indices((height, width))
    x_step, y_step = width // (width // 7 + 1), height // (height // 7 + 1)
    mask = ((xx % x_step == 0) | (yy % y_step == 0) | (xx == width - 1)
            | (yy == height - 1) | (counts.reshape(height, width) == 0))
    b, g, r = [restored[:, :, i].astype(np.int16) for i in range(3)]
    mask |= (r > g + 50) & (r > b + 50)
    cleaned = cv2.inpaint(restored, mask.astype(np.uint8) * 255, 2, cv2.INPAINT_TELEA)
    # Crop only in this recognized style. Full image stays the first candidate.
    cropped = cleaned[round(height * .12):round(height * .88), 3:-3]
    return {'image': cleaned, 'cropped': cropped, 'fit': round(fit, 4), 'radius': radius}


def clean_grid(image):
    black = np.max(image, axis=2) < 80
    mask = np.zeros(image.shape[:2], dtype=np.uint8)
    mask[:, black.mean(axis=0) > 0.75] = 255
    mask[black.mean(axis=1) > 0.75, :] = 255
    b, g, r = [image[:, :, i].astype(np.int16) for i in range(3)]
    mask[(r > g + 50) & (r > b + 50)] = 255
    return cv2.inpaint(image, mask, 2, cv2.INPAINT_TELEA)
