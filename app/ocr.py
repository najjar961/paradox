"""Make scanned PDFs and photos readable: OCR with Tesseract, in memory.

The result is a "searchable PDF": the original page image with an invisible
text layer on top. Chat, search and redaction then work on it, and a redaction
also blanks the pixels underneath, so the scanned text is really gone.
"""
from __future__ import annotations

import os

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
# Every language whose data is installed is used: German, English, French, Arabic.
WANTED = os.environ.get("OCR_LANGS", "deu+eng+fra+ara")


def _tessdata() -> str | None:
    for p in (os.environ.get("TESSDATA_PREFIX"), "/usr/share/tesseract-ocr/5/tessdata", "/usr/share/tesseract-ocr/4.00/tessdata",
              "/usr/share/tessdata"):
        if p and os.path.isdir(p):
            return p
    return None


def langs() -> str:
    """The wanted languages that are installed (Docker image: all four)."""
    path = _tessdata()
    have = [l for l in WANTED.split("+") if path and os.path.exists(os.path.join(path, f"{l}.traineddata"))]
    return "+".join(have) or "eng"


def needs_ocr(data: bytes) -> bool:
    """A PDF whose pages are mostly images with (almost) no text."""
    import pymupdf

    doc = pymupdf.open(stream=data, filetype="pdf")
    try:
        if not doc.page_count:
            return False
        chars = sum(len(p.get_text().strip()) for p in doc)
        images = sum(len(p.get_images()) for p in doc)
        return images > 0 and chars < 40 * doc.page_count
    finally:
        doc.close()


def image_to_pdf(data: bytes) -> bytes:
    import pymupdf

    img = pymupdf.open(stream=data)  # PyMuPDF opens common image formats as a 1-page document
    pdf_bytes = img.convert_to_pdf()
    img.close()
    return pdf_bytes


def _tesseract(png: bytes, dpi: int, out: str) -> bytes:
    """Run Tesseract on one page image via stdin/stdout (no temporary files)."""
    import subprocess

    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    tessdata = _tessdata()
    if tessdata:
        env["TESSDATA_PREFIX"] = tessdata
    r = subprocess.run(["tesseract", "stdin", "stdout", "-l", langs(), "--dpi", str(dpi), out],
                       input=png, capture_output=True, timeout=180, env=env, check=False)
    if r.returncode != 0:
        raise RuntimeError("Text recognition failed for this scan.")
    return r.stdout


def _ocr_page(png: bytes, dpi: int) -> bytes:
    """One page image -> one-page searchable PDF."""
    pdf = _tesseract(png, dpi, "pdf")
    if not pdf.startswith(b"%PDF"):
        raise RuntimeError("Text recognition failed for this scan.")
    return pdf



def available() -> bool:
    """Needs the program as well as the language data."""
    import shutil

    return shutil.which("tesseract") is not None and _tessdata() is not None


def ocr_pdf(data: bytes, dpi: int = 300, max_pages: int = 40) -> bytes:
    """Return a searchable copy of a scanned PDF (same page sizes, image + invisible text)."""
    return ocr_pdf_text(data, dpi, max_pages)[0]


def ocr_pdf_text(data: bytes, dpi: int = 300, max_pages: int = 40) -> tuple[bytes, str]:
    """Searchable PDF plus its text in reading order.

    The text comes from Tesseract's plain-text output: its PDF text layer keeps Arabic in
    visual (left-to-right) order and can lose accents, so it is only used for search and redaction.
    """
    import pymupdf

    if not available():
        raise RuntimeError("Text recognition (OCR) is not installed on this server.")
    src = pymupdf.open(stream=data, filetype="pdf")
    if src.page_count > max_pages:
        raise RuntimeError(f"Scanned documents with more than {max_pages} pages are not supported.")
    out = pymupdf.open()
    texts = []
    for page in src:
        d = dpi
        png = page.get_pixmap(dpi=d, colorspace=pymupdf.csGRAY).tobytes("png")
        page_pdf = pymupdf.open(stream=_ocr_page(png, d), filetype="pdf")
        texts.append(_tesseract(png, d, "txt").decode("utf-8", "replace"))
        out.insert_pdf(page_pdf)
        page_pdf.close()
    result = out.tobytes(garbage=3, deflate=True)
    out.close()
    src.close()
    return result, "\n\n".join(t.strip() for t in texts)
