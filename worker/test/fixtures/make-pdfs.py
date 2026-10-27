"""Makes the MADE-UP, password-protected statement PDFs the PDF tests read.

Every bank, card number, merchant, amount and password here is invented.
Run once (the outputs are committed next to this file):

    python3 -I make-pdfs.py <this folder>

Needs reportlab (to draw the PDF) and pypdf + cryptography (to encrypt it).
Each encryption a bank might use gets its own file, so the tests prove the
worker opens every one of them:
    rc4-40   (PDF 1.1-era "40-bit RC4", R2)
    rc4-128  (R3, still common on older bank systems)
    aes-128  (R4)
    aes-256  (R6, PDF 2.0 — what most modern bank systems emit)
plus a Traditional Chinese statement (font embedded, as a real one would be),
an unprotected copy, and a locked page with shapes but no text (a scanned
payment slip, which 台新 attaches beside each statement).
"""

import os
import sys

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
PASSWORD = "made-up-pw-1234"

LINES = [
    ("02 MAR", "KOPI CORNER SINGAPORE SG", "4.50"),
    ("03 MAR", "BOOKSHOP PTE LTD SINGAPORE SG", "30.00"),
    ("05 MAR", "TESTAIR.COM USD 100.00", "136.20"),
    ("05 MAR", "FOREIGN CURRENCY TRANSACTION FEE", "4.43"),
    ("10 MAR", "PAYMENT - THANK YOU", "100.00 CR"),
]


def english(path: str) -> None:
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle("Made-up statement")
    y = 800
    for text in [
        "TESTBANK CREDIT CARD STATEMENT",
        "TEST REWARDS CARD  4000 0000 0000 1111",
        "Statement Date: 15 Mar 2026",
        "Previous Balance            100.00",
    ]:
        c.drawString(50, y, text)
        y -= 18
    y -= 10
    c.drawString(50, y, "DATE")
    c.drawString(120, y, "DESCRIPTION")
    c.drawString(450, y, "AMOUNT (SGD)")
    y -= 18
    for d, desc, amt in LINES:
        c.drawString(50, y, d)
        c.drawString(120, y, desc)
        c.drawRightString(530, y, amt)
        y -= 16
    y -= 10
    c.drawString(50, y, "New Balance")
    c.drawRightString(530, y, "175.13")
    c.showPage()
    c.drawString(50, 800, "Page 2: important notes (made up).")
    c.showPage()
    c.save()


def chinese(path: str) -> None:
    pdfmetrics.registerFont(TTFont("Zen", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", subfontIndex=0))
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont("Zen", 11)
    y = 800
    for text in [
        "測試銀行 信用卡帳單",
        "卡號末四碼 4444",
        "帳單結帳日 2026/03/25",
        "上期應繳總額  1,000",
        "2026/03/05  夜市小吃  350",
        "2026/03/09  測試書店  1,200",
        "本期應繳總額  2,550",
    ]:
        c.drawString(50, y, text)
        y -= 18
    c.showPage()
    c.save()


def encrypt(src: str, dest: str, algorithm: str) -> None:
    reader = PdfReader(src)
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=PASSWORD, owner_password="made-up-owner-5678", algorithm=algorithm)
    with open(dest, "wb") as f:
        writer.write(f)


def scanned(path: str) -> None:
    """A page with no text at all: what a scanned payment slip looks like."""
    c = canvas.Canvas(path, pagesize=A4)
    c.rect(50, 600, 400, 150, fill=1)
    c.save()


if __name__ == "__main__":
    plain = os.path.join(OUT, "statement-plain.pdf")
    english(plain)
    for name, algorithm in [("rc4-40", "RC4-40"), ("rc4-128", "RC4-128"), ("aes-128", "AES-128"), ("aes-256", "AES-256")]:
        encrypt(plain, os.path.join(OUT, f"statement-{name}.pdf"), algorithm)
    zh = os.path.join(OUT, "_zh-plain.pdf")
    chinese(zh)
    encrypt(zh, os.path.join(OUT, "statement-zh-aes-256.pdf"), "AES-256")
    os.remove(zh)
    slip = os.path.join(OUT, "_slip-plain.pdf")
    scanned(slip)
    encrypt(slip, os.path.join(OUT, "slip-scanned-aes-256.pdf"), "AES-256")
    os.remove(slip)
    for f in sorted(os.listdir(OUT)):
        if f.endswith(".pdf"):
            print(f, os.path.getsize(os.path.join(OUT, f)))
