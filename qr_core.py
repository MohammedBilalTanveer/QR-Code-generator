"""QR code logic for QR Studio.

This is the web version of the functions in the original Tkinter app:

* ``make_qr_png`` replaces ``createQR`` / ``saveQR``: text in, PNG out (qrcode).
* ``decode_qr`` replaces ``scan``: picture in, text out (OpenCV QRCodeDetector).
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass

import qrcode
from qrcode.constants import ERROR_CORRECT_H, ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q
from qrcode.exceptions import DataOverflowError

ERROR_LEVELS = {
    "L": ERROR_CORRECT_L,  # the code still reads with ~7% of it damaged
    "M": ERROR_CORRECT_M,  # ~15%
    "Q": ERROR_CORRECT_Q,  # ~25%
    "H": ERROR_CORRECT_H,  # ~30%
}
MAX_TEXT_BYTES = 2953  # the most any QR code can hold (version 40, level L)
BOX_SIZES = range(4, 21)  # allowed pixels per QR module
BORDER = 4  # quiet zone around the code, in modules (the QR spec asks for 4)
MAX_DECODE_SIDE = 2000  # bigger pictures are shrunk before decoding, which is much faster
_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


class QRInputError(ValueError):
    """Input the user can fix. The message is shown to them as-is."""


@dataclass(frozen=True)
class GeneratedQR:
    png: bytes
    version: int  # 1-40: how dense the code is
    modules: int  # modules per side, not counting the quiet zone
    pixels: int  # width (and height) of the PNG


@dataclass(frozen=True)
class DecodedQR:
    data: str
    points: list[list[float]]  # the code's four corners as [x, y] in picture pixels


def make_qr_png(text, *, error="M", box_size=10, fill="#000000", back="#ffffff") -> GeneratedQR:
    """Render ``text`` as a QR code PNG."""
    if not isinstance(text, str) or not text.strip():
        raise QRInputError("Enter some text or a link first.")
    text = text.strip()
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise QRInputError(f"That's too long for a QR code. The limit is {MAX_TEXT_BYTES} bytes.")

    level = ERROR_LEVELS.get(str(error).upper())
    if level is None:
        raise QRInputError("Error correction must be L, M, Q or H.")

    try:
        box_size = int(box_size)
    except (TypeError, ValueError):
        box_size = 0
    if box_size not in BOX_SIZES:
        raise QRInputError(f"Size must be {BOX_SIZES.start}-{BOX_SIZES.stop - 1} pixels per module.")

    for color in (fill, back):
        if not isinstance(color, str) or not _HEX_COLOR.fullmatch(color):
            raise QRInputError("Colors must be hex values like #1a2b3c.")

    qr = qrcode.QRCode(error_correction=level, box_size=box_size, border=BORDER)
    qr.add_data(text)
    try:
        qr.make(fit=True)
    except (DataOverflowError, ValueError):  # qrcode 8 raises ValueError("Invalid version (was 41...)")
        raise QRInputError(
            "That's too much text for this error-correction level. "
            "Shorten it or pick a lower level, like L."
        ) from None

    buffer = io.BytesIO()
    qr.make_image(fill_color=fill, back_color=back).save(buffer)
    return GeneratedQR(
        png=buffer.getvalue(),
        version=qr.version,
        modules=qr.modules_count,
        pixels=(qr.modules_count + 2 * BORDER) * box_size,
    )


def decode_qr(image_bytes: bytes) -> list[DecodedQR]:
    """Find and decode every QR code in a picture (PNG, JPEG, WebP, ...)."""
    if not image_bytes:
        raise QRInputError("The uploaded file is empty.")

    # OpenCV is by far the heaviest dependency, so it is only loaded once a
    # picture actually needs decoding. Creating codes never pays for it.
    import cv2
    import numpy as np

    try:
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error:
        image = None
    if image is None:
        raise QRInputError("That file couldn't be read as a picture. Try a PNG or JPG.")

    scale = min(1.0, MAX_DECODE_SIDE / max(image.shape[:2]))
    if scale < 1:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    detectors = [cv2.QRCodeDetector()]
    if hasattr(cv2, "QRCodeDetectorAruco"):  # OpenCV 4.8+, copes better with photos
        detectors.append(cv2.QRCodeDetectorAruco())

    for detector in detectors:
        try:
            found, texts, corners, _ = detector.detectAndDecodeMulti(image)
            if found:
                codes = [DecodedQR(t, _points(c, scale)) for t, c in zip(texts, corners) if t]
                if codes:
                    return codes
            # The single-code call used by the Tkinter app sometimes succeeds where
            # the multi-code one gives up.
            text, corners, _ = detector.detectAndDecode(image)
            if text and corners is not None:
                return [DecodedQR(text, _points(corners, scale))]
        except (cv2.error, UnicodeDecodeError):
            continue  # this detector choked on the picture; try the next one
    return []


def _points(corners, scale: float) -> list[list[float]]:
    """OpenCV corners -> four [x, y] pairs in the original picture's pixels."""
    return [[round(float(x) / scale, 1), round(float(y) / scale, 1)] for x, y in corners.reshape(-1, 2)[:4]]
