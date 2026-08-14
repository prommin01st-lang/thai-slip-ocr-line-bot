"""pdf_text.py — PDF → ข้อความ (stdlib + poppler เท่านั้น ไม่มี Python dependency ใหม่)

**ลองชั้นข้อความก่อนเสมอ ค่อยตกไป OCR**

สลิปและ statement ที่ธนาคารไทยส่งทางอีเมล/ให้กดโหลดจากแอป เป็น PDF ที่มีข้อความจริง
ฝังอยู่ข้างใน ไม่ใช่รูปสแกน ดึงชั้นข้อความออกมาตรง ๆ จึงได้ตัวเลขที่ **ถูก 100%**
(ไม่ใช่ ~96% แบบ OCR) และเร็วกว่าหลายสิบเท่า — ทั้งไฟล์ใช้เวลาไม่ถึง 0.1 วิ เทียบกับ
OCR ~8.5 วิต่อหน้าบน VPS 2 cores

จะ OCR ก็ต่อเมื่อหน้านั้นไม่มีข้อความจริง (เช่นถ่ายรูปสลิปแล้วแปะลง PDF)

ใช้ `pdftotext` / `pdftoppm` จาก poppler-utils ผ่าน subprocess — ตั้งใจไม่ใช้ PyMuPDF
หรือ pdfplumber เพราะทั้งคู่เป็น dependency หนักที่ต้องคอมไพล์ ส่วน poppler เป็นแพ็กเกจ
ระบบขนาด ~15 MB ที่ apt ลงให้ในบรรทัดเดียว

รัน self-test:  python pdf_text.py
"""
import os
import re
import shutil
import subprocess
import tempfile

# กันไฟล์ใหญ่ผิดปกติมาถล่มเครื่อง — statement ของจริงไม่เกิน 2-3 หน้า
MAX_PAGES = int(os.environ.get("SLIP_PDF_MAX_PAGES", "10"))
# poppler ค้างกับไฟล์ที่จงใจทำให้พังได้ — ต้องมีเพดานเวลาเสมอ
TIMEOUT = int(os.environ.get("SLIP_PDF_TIMEOUT", "30"))
# ตัวอักษรขั้นต่ำที่ถือว่า "หน้านี้มีชั้นข้อความจริง" (ต่ำกว่านี้คือหน้ารูปที่มีแค่เลขหน้า)
MIN_CHARS = 20
# ความละเอียดตอนแปลงเป็นรูปให้ OCR — 200 dpi พอสำหรับตัวหนังสือสลิป
# สูงกว่านี้ไฟล์ใหญ่ขึ้นมากแต่ความแม่นแทบไม่ขยับ (PP-OCRv5 ย่อภาพลงอยู่ดี)
DPI = int(os.environ.get("SLIP_PDF_DPI", "200"))


class PdfError(Exception):
    pass


def available() -> bool:
    """poppler ติดตั้งอยู่ไหม — ถ้าไม่มีต้องบอกผู้ใช้ให้ชัด ไม่ใช่พังแบบ FileNotFoundError"""
    return bool(shutil.which("pdftotext") and shutil.which("pdftoppm"))


def _run(cmd: list, **kw) -> subprocess.CompletedProcess:
    # ส่งเป็น list เสมอ ไม่ผ่าน shell — ชื่อไฟล์มาจาก tempfile ก็จริง แต่ไม่มีเหตุผล
    # จะเปิดช่องให้ตัวเองไว้ให้พลาดวันหลัง
    try:
        return subprocess.run(cmd, capture_output=True, timeout=TIMEOUT, check=False, **kw)
    except subprocess.TimeoutExpired:
        raise PdfError(f"อ่าน PDF นานเกิน {TIMEOUT} วินาที")
    except FileNotFoundError:
        raise PdfError("เครื่องนี้ไม่มี poppler-utils (pdftotext/pdftoppm)")


def text_pages(path: str, max_pages: int = MAX_PAGES) -> list:
    """
    ข้อความของแต่ละหน้า (หน้าที่ไม่มีชั้นข้อความจะได้สตริงว่าง)

    `pdftotext` คั่นหน้าด้วย form feed (\\f) อยู่แล้ว จึงได้ทั้งเนื้อหาและจำนวนหน้า
    จากการเรียกครั้งเดียว ไม่ต้องเรียก pdfinfo แยก

    `-layout` สำคัญมากกับ statement: มันรักษาคอลัมน์ไว้ ทำให้ "วันที่ | รายการ | ยอด"
    ยังอยู่บรรทัดเดียวกัน ถ้าไม่ใส่ poppler จะคายออกมาเรียงตามลำดับ object ในไฟล์
    ซึ่งสลับกันมั่วจนแยกไม่ออกว่ายอดไหนของรายการไหน
    """
    r = _run(["pdftotext", "-layout", "-q", "-f", "1", "-l", str(max_pages), path, "-"])
    if r.returncode != 0 and not r.stdout:
        err = (r.stderr or b"").decode("utf-8", "replace").strip()
        raise PdfError(f"เปิด PDF ไม่ได้ (ไฟล์เสียหรือมีรหัสผ่าน?){': ' + err if err else ''}")
    pages = r.stdout.decode("utf-8", "replace").split("\f")
    # pdftotext ปิดท้ายด้วย \f เสมอ → ตัวสุดท้ายเป็นสตริงว่างที่ไม่ใช่หน้าจริง
    if pages and not pages[-1].strip():
        pages.pop()
    return pages[:max_pages]


def has_text(page: str) -> bool:
    """หน้านี้มีชั้นข้อความพอจะใช้แทน OCR ไหม"""
    return len(re.sub(r"\s", "", page or "")) >= MIN_CHARS


def render_page(path: str, page_no: int, outdir: str, dpi: int = DPI) -> str:
    """หน้าที่ระบุ → ไฟล์ PNG (ใช้เมื่อหน้านั้นไม่มีชั้นข้อความ) คืน path ของรูป"""
    prefix = os.path.join(outdir, f"p{page_no}")
    r = _run(["pdftoppm", "-png", "-r", str(dpi),
              "-f", str(page_no), "-l", str(page_no), path, prefix])
    # pdftoppm ตั้งชื่อไฟล์เอง (prefix-1.png / prefix-01.png แล้วแต่จำนวนหน้า)
    # จึงต้องหาไฟล์ที่มันสร้างจริง ไม่ใช่เดาชื่อ
    made = sorted(f for f in os.listdir(outdir) if f.startswith(f"p{page_no}-"))
    if not made:
        err = (r.stderr or b"").decode("utf-8", "replace").strip()
        raise PdfError(f"แปลงหน้า {page_no} เป็นรูปไม่ได้{': ' + err if err else ''}")
    return os.path.join(outdir, made[0])


def pages_for_parsing(path: str, ocr_fn, max_pages: int = MAX_PAGES) -> list:
    """
    ทุกหน้า → `[{"page": 1, "text": ..., "source": "text"|"ocr"}]`

    `ocr_fn(image_path) -> str` ถูกฉีดเข้ามาเพื่อให้โมดูลนี้ **ไม่ต้อง import paddle**
    → ทดสอบได้โดยไม่ต้องมี ML stack และ import ได้จากที่อื่นแบบไม่มีผลข้างเคียง
    """
    out = []
    layers = text_pages(path, max_pages)
    if not layers:
        raise PdfError("PDF นี้ไม่มีหน้าเลย")

    with tempfile.TemporaryDirectory(prefix="pdfpg-") as tmp:
        for i, page in enumerate(layers, start=1):
            if has_text(page):
                out.append({"page": i, "text": page, "source": "text"})
                continue
            img = render_page(path, i, tmp)
            out.append({"page": i, "text": ocr_fn(img), "source": "ocr"})
    return out


# --- self-test -----------------------------------------------------------
#
# ประกอบ PDF ขั้นต่ำด้วยมือ (ไม่มีไลบรารีสร้าง PDF และไม่ควรเพิ่มเพื่อการนี้)
# xref ใส่ค่าหลอกไว้ — poppler สร้าง xref ใหม่เองได้เมื่อของเดิมไม่ตรง ซึ่งเป็น
# พฤติกรรมที่เราพึ่งได้จริงเพราะ PDF จากธนาคารก็ไม่ได้สะอาดเสมอไป
def _tiny_pdf(text) -> bytes:
    # หน้ากว้างเท่า A4 (595pt) — แคบกว่านี้ข้อความจะล้นออกนอกหน้าแล้ว pdftotext
    # ตัดทิ้งท้ายบรรทัด ซึ่งทำให้ self-test ล้มด้วยเหตุผลที่ไม่เกี่ยวกับโค้ดเลย
    lines = text if isinstance(text, (list, tuple)) else [text]
    stream = "\n".join(
        f"BT /F1 12 Tf 40 {260 - i * 20} Td ({ln}) Tj ET" for i, ln in enumerate(lines)).encode()
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 300]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    body = b"%PDF-1.4\n"
    for i, o in enumerate(objs, start=1):
        body += b"%d 0 obj " % i + o + b" endobj\n"
    body += (b"trailer <</Size %d/Root 1 0 R>>\n%%%%EOF\n" % (len(objs) + 1))
    return body


if __name__ == "__main__":
    assert available(), "ต้องลง poppler-utils ก่อน: apt install poppler-utils"
    ok = 0

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(_tiny_pdf("TRANSFER SUCCESS 1,234.56 THB REF 0123456789"))
        sample = f.name
    try:
        pages = text_pages(sample)
        assert len(pages) == 1, f"ควรได้ 1 หน้า ได้ {len(pages)}"
        assert "1,234.56" in pages[0], f"ต้องอ่านตัวเลขจากชั้นข้อความได้: {pages[0]!r}"
        print("  ✓ ดึงชั้นข้อความจาก PDF ได้ (ไม่ต้อง OCR)")
        ok += 1

        assert has_text(pages[0]) is True
        assert has_text("   \n  ") is False
        assert has_text("12") is False, "ข้อความสั้นมากถือว่าไม่ใช่ชั้นข้อความจริง"
        print("  ✓ แยกออกว่าหน้าไหนมีชั้นข้อความจริง")
        ok += 1

        called = []
        res = pages_for_parsing(sample, lambda p: called.append(p) or "OCR!")
        assert res[0]["source"] == "text", "มีชั้นข้อความแล้วห้ามเรียก OCR"
        assert called == [], f"ไม่ควรเรียก OCR เลย แต่เรียกไป {called}"
        print("  ✓ หน้าที่มีข้อความอยู่แล้ว ไม่ถูกส่งไป OCR (ประหยัด ~8.5 วิ/หน้า)")
        ok += 1

        # หน้าที่ไม่มีข้อความต้องตกไป OCR — จำลองด้วยการลดเพดานขั้นต่ำให้สูงเกิน
        _orig = MIN_CHARS
        globals()["MIN_CHARS"] = 10_000
        res = pages_for_parsing(sample, lambda p: "ข้อความจาก OCR")
        assert res[0]["source"] == "ocr" and res[0]["text"] == "ข้อความจาก OCR"
        assert os.path.exists(sample), "ไฟล์ต้นฉบับต้องไม่ถูกลบ"
        globals()["MIN_CHARS"] = _orig
        print("  ✓ หน้าที่ไม่มีชั้นข้อความ ถูกแปลงเป็นรูปแล้วส่งเข้า OCR")
        ok += 1

        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as bad:
                bad.write("ไม่ใช่ PDF เลยสักนิด".encode("utf-8"))
                badname = bad.name
            text_pages(badname)
            raise AssertionError("ไฟล์เสียต้องโยน PdfError")
        except PdfError as e:
            print(f"  ✓ ไฟล์ไม่ใช่ PDF → บอกสาเหตุชัด ({str(e)[:40]}…)")
            ok += 1
        finally:
            os.unlink(badname)
    finally:
        os.unlink(sample)

    print(f"\nself-test: {ok}/5 ผ่าน")
    assert ok == 5
    print("pdf_text พร้อม ✅")
