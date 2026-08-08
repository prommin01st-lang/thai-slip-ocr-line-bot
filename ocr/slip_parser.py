"""
slip_parser.py — แปลงข้อความ OCR ของสลิป/ใบเสร็จไทย → dict มีโครงสร้าง.

stdlib ล้วน (regex) ไม่พึ่ง torch → เทสต์/รันแยกจากโมเดลได้ ทำ unit test ง่าย.
เป็น heuristic ไม่ใช่ parser สมบูรณ์แบบ — สลิปแต่ละธนาคารหน้าตาต่างกัน. ค่าที่หา
ไม่เจอจะเป็น None. ต่อยอด: เพิ่ม pattern ต่อธนาคารได้ตามที่เจอจริง.

รัน self-test:  python slip_parser.py
"""
import re
import json
from money_utils import detect_currency

# --- ธนาคาร / พร้อมเพย์ --------------------------------------------------
_BANKS = [
    (re.compile(r"กสิกร|KBANK|K\s*PLUS|kplus|K\+", re.I), "kbank"),
    (re.compile(r"ไทยพาณิชย์|SCB", re.I), "scb"),
    (re.compile(r"กรุงเทพ|Bangkok Bank|BBL", re.I), "bbl"),
    (re.compile(r"กรุงไทย|Krungthai|KTB", re.I), "ktb"),
    (re.compile(r"กรุงศรี|Krungsri|BAY", re.I), "bay"),
    (re.compile(r"ทหารไทย|ธนชาต|ttb|tmb", re.I), "ttb"),
    (re.compile(r"ออมสิน|GSB", re.I), "gsb"),
    (re.compile(r"TrueMoney|ทรูมันนี่|ทรู\s*วอลเล็ท", re.I), "truemoney"),
    (re.compile(r"พร้อมเพย์?|PromptPay", re.I), "promptpay"),  # OCR มักตก ์ ท้าย
]

# เดือนไทยแบบย่อ → เลขเดือน
_TH_MONTH = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}
# OCR ตกจุดบ่อยมาก ("23 ก.ค. 2569" → "23 กค. 2569") → เทียบแบบไม่สนจุด
_TH_MONTH_NODOT = {k.replace(".", ""): v for k, v in _TH_MONTH.items()}

# จำนวนเงิน: 1,234.56 (บังคับมีทศนิยม 2 ตำแหน่ง เพื่อกันจับเลขอ้างอิงมั่ว)
_AMOUNT = re.compile(r"(\d{1,3}(?:,\d{3})*\.\d{2})")
# บรรทัดที่บอกว่าเป็นยอดเงินจริง ๆ
_AMOUNT_HINT = re.compile(r"จำนวนเงิน|จำนวน\s*:|ยอดเงิน|ยอดรวม|รวมทั้งสิ้น|total|amount", re.I)

_TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b")
# วันที่ตัวเลข dd/mm/yyyy หรือ dd-mm-yy
_DATE_NUM = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b")
# วันที่ไทย: 23 ก.ค. 2569 / 23 ก.ค. 69 / 23 กค. 2569 (จุดหายก็ยังจับได้)
# แต่ละจุดในชื่อเดือนกลายเป็น \.? — เรียงตัวยาวก่อนกันตัวสั้นชิงแมตช์
_MONTH_ALT = "|".join(
    "".join(r"\.?" if ch == "." else re.escape(ch) for ch in m)
    for m in sorted(_TH_MONTH, key=len, reverse=True)
)
_DATE_TH = re.compile(r"\b(\d{1,2})\s*(" + _MONTH_ALT + r")\s*(\d{2,4})")

# เลขอ้างอิง: คำนำ + สายอักษร/ตัวเลขยาว. OCR ชอบเพี้ยน "รหัสอ้างอิง"→"รหัสล้างอัง"
# → คำนำจับแบบหลวม (รหัส...อ...), มี fallback เป็นเลขยาวล้วนด้านล่าง.
_REF = re.compile(
    # "เลขที่" โดน OCR อ่านเป็น "เลยที่" บ่อยมาก (ข↔ย) → ยอมรับทั้งสองแบบ
    r"(?:รหัส\S*|เล[ขยฃ]\S*|หมายเลข\S*|Ref(?:erence)?(?:\s*(?:No|ID))?)\s*[:：#]?\s*([A-Za-z0-9]{8,})",
    re.I,
)
# fallback: เลขอ้างอิง **ไม่ได้มีแต่ตัวเลข** — K+ ใช้ 12 หลัก + 3 ตัวอักษร + 5 หลัก
# (016123134021APP11840). ของเดิมเป็น (\d{12,}) จึงตัดหางทิ้งเหลือ 12 หลักแรก
_REF_FALLBACK = re.compile(r"\b([0-9A-Za-z]{12,})\b")
_REF_MIN_DIGITS = 8   # ต้องมีตัวเลขพอสมควร กันไปจับคำอังกฤษ/ชื่อร้านที่ยาว
# ชื่อผู้ส่ง/ผู้รับ — จับคำนำแบบหลวม (OCR เพี้ยน เช่น "ไปยัง"→"ไปยั่ง") แล้วบังคับมี :
_FROM = re.compile(r"(?:จาก|ผู้โอน|ผู้ส่ง|From)[^:：]{0,3}[:：]\s*(.+)")
_TO = re.compile(r"(?:ไปย\S*|ไปที่|ผู้รับ|To)[^:：]{0,3}[:：]\s*(.+)")


def _find_banks(text: str):
    found = []
    for rx, name in _BANKS:
        if rx.search(text) and name not in found:
            found.append(name)
    return found


def _find_amount(text: str):
    """เลือกจำนวนเงินที่น่าจะเป็น 'ยอด' จริง: ให้น้ำหนักบรรทัดที่มี hint ก่อน,
    ไม่งั้นเอาค่ามากสุด (ยอดรวมมักใหญ่สุด). คืน (สตริงจำนวน, มาจาก hint ไหม).

    **hint ข้ามบรรทัดได้** — OCR แบบกล่องต่อกล่อง (PaddleOCR/Tesseract) แยกป้ายกับ
    ตัวเลขเป็นคนละบรรทัดเสมอ:

        จำนวน:            ← ป้าย
        888.00 บาท        ← ค่า

    ถ้าดูเฉพาะบรรทัดเดียวกันจะไม่เจอ hint เลย แล้วตกไปใช้ "เอาค่ามากสุด" ตลอด
    (วัดบนสลิปจริง 332 ใบ: confidence ออกมาเป็น medium ทั้งหมด ไม่มี high สักใบ)
    ซึ่งนอกจากคะแนนความมั่นใจจะต่ำเกินจริงแล้ว ยังเสี่ยงหยิบเลขผิดด้วย —
    สลิปที่โชว์ยอดคงเหลือซึ่งใหญ่กว่ายอดโอน จะได้ยอดคงเหลือแทน

    กติกา: ป้ายที่ค้างไว้ใช้ได้กับ **ตัวเลขตัวแรกของบรรทัดถัดไปเท่านั้น** แล้วหมดอายุ
    — กัน 'ค่าธรรมเนียม 0.00' ที่ตามมาทีหลังไปสวมสิทธิ์ hint ของยอดจริง
    """
    candidates = []
    pending_hint = False          # บรรทัดก่อนหน้าเป็นป้ายบอกยอด แต่ยังไม่เจอตัวเลข
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        has_hint = bool(_AMOUNT_HINT.search(line))
        matches = list(_AMOUNT.finditer(line))
        if not matches:
            pending_hint = has_hint   # ข้อความล้วน — ถ้าเป็นป้ายยอด ค้างไว้ให้บรรทัดถัดไป
            continue
        for i, m in enumerate(matches):
            val = float(m.group(1).replace(",", ""))
            candidates.append((has_hint or (pending_hint and i == 0), val, m.group(1)))
        pending_hint = False
    if not candidates:
        return None, False
    # ให้ hint=True มาก่อน, แล้วค่อยเรียงตามค่ามาก→น้อย
    candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
    return candidates[0][2], candidates[0][0]


def _find_date(text: str):
    m = _DATE_TH.search(text)
    if m:
        d, mon, y = int(m.group(1)), _TH_MONTH_NODOT[m.group(2).replace(".", "")], int(m.group(3))
        if y < 100:            # 69 → 2569
            y += 2500
        if y > 2400:           # พ.ศ. → ค.ศ.
            y -= 543
        return f"{y:04d}-{mon:02d}-{d:02d}"
    m = _DATE_NUM.search(text)
    if m:
        d, mon, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        if y > 2400:
            y -= 543
        return f"{y:04d}-{mon:02d}-{d:02d}"
    return None


def _first(rx, text):
    m = rx.search(text)
    return m.group(1).strip() if m else None


def _find_ref(text: str):
    """คำนำ + เลข ก่อน; ถ้าไม่เจอ ใช้ fallback สตริงยาวสุดที่มีตัวเลขพอ (>=12 ตัว)."""
    ref = _first(_REF, text)
    if ref:
        return ref
    longs = [s for s in _REF_FALLBACK.findall(text)
             if sum(c.isdigit() for c in s) >= _REF_MIN_DIGITS]
    return max(longs, key=len) if longs else None


# บรรทัดเลขบัญชี: "xxx-x-x8888-x" / "888-8-8888-8" (คั่นด้วย - อย่างน้อย 2 ที่)
_ACCT_LINE = re.compile(r"^[\dxX*]{1,6}(?:[-\s][\dxX*]{1,6}){2,}$")
# คำนำหน้าที่ยืนยันว่าเป็นชื่อคน/ร้าน (ใช้ยอมรับชื่อคำเดียวได้)
_NAME_PREFIX = re.compile(
    r"^(?:นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|คุณ|ร้าน|บริษัท|หจก|บจก|Mr|Ms|Mrs)", re.I)


def _looks_like_name(s: str) -> bool:
    """บรรทัดนี้ดูเป็นชื่อคน/ร้านไหม — กัน 'ธ.กสิกรไทย' (ชื่อธนาคารคำเดียว) ให้ตกไป."""
    if not (3 <= len(s) <= 40) or re.search(r"\d", s):
        return False
    if not re.search(r"[฀-๿]", s):      # ต้องมีอักษรไทย
        return False
    return bool(_NAME_PREFIX.search(s)) or len(s.split()) >= 2


def _find_parties_by_layout(text: str):
    """สลิปบางแบบ (เช่น K+) ไม่มีป้าย 'จาก:'/'ไปยัง:' — ใช้ลูกศร ↓ แทน.
    เดาจากโครงหน้า: บรรทัดชื่อ → (ธนาคาร) → บรรทัดเลขบัญชี. บล็อกแรก = ผู้โอน,
    บล็อกที่สอง = ผู้รับ. คืน (from, to); หาไม่ได้เป็น None.

    ไล่ด้วย index ไม่ใช่ค่าสตริง — สลิปโอนเข้าบัญชีตัวเองมีชื่อซ้ำกันสองบล็อก."""
    lines = [ln.strip() for ln in text.splitlines()]
    names, used = [], set()
    for i, ln in enumerate(lines):
        if not _ACCT_LINE.match(ln):
            continue
        for j in range(i - 1, max(-1, i - 4), -1):   # ถอยหลังไม่เกิน 3 บรรทัด
            if j not in used and _looks_like_name(lines[j]):
                used.add(j)
                names.append(lines[j])
                break
        if len(names) == 2:
            break
    return (names[0] if names else None,
            names[1] if len(names) > 1 else None)


def parse_slip(text: str) -> dict:
    """ข้อความ OCR → dict. ฟิลด์ที่หาไม่เจอ = None."""
    banks = _find_banks(text)
    tm = _TIME.search(text)
    amount, amt_hint = _find_amount(text)
    date = _find_date(text)
    frm, to = _first(_FROM, text), _first(_TO, text)
    # ไม่มีป้ายเลยทั้งคู่ → ลองเดาจากโครงหน้าสลิป
    by_layout = False
    if frm is None and to is None:
        frm, to = _find_parties_by_layout(text)
        by_layout = frm is not None

    # warnings/confidence — บอกว่าผลไหน "เดา"/ไม่ครบ
    warnings = []
    if amount is None:
        warnings.append("ไม่พบจำนวนเงิน")
    elif not amt_hint:
        warnings.append("จำนวนเงินเดาจากค่ามากสุด (ไม่พบป้าย 'จำนวนเงิน/ยอดรวม')")
    if date is None:
        warnings.append("ไม่พบวันที่")
    if not banks:
        warnings.append("ไม่ระบุธนาคาร/พร้อมเพย์")
    if frm is None and to is None:
        warnings.append("ไม่พบผู้โอน/ผู้รับ")
    elif by_layout:
        warnings.append("ผู้โอน/ผู้รับ เดาจากโครงหน้าสลิป (ไม่มีป้ายกำกับ)")
    # confidence ตอบคำถามเดียว: **"ยอดเงินเชื่อได้แค่ไหน"** ไม่ใช่ "ข้อมูลครบแค่ไหน"
    # ผู้โอน/ผู้รับ หรือชื่อธนาคารที่ขาดไป ไม่ได้ทำให้ยอดผิด → ไม่ควรกด confidence
    #
    # ของเดิมใช้ `not warnings` (ห้ามมี warning ใด ๆ เลย) ซึ่งวัดจริงบนสลิป 332 ใบแล้ว
    # ได้ medium ทั้งหมด ไม่มี high สักใบ — สัญญาณที่คงที่ตลอดใช้ตัดสินใจอะไรไม่ได้
    # (สลิป K+/ttb ไม่มีป้าย "จาก:/ไปยัง:" เลย → warning นั้นติดทุกใบโดยธรรมชาติ)
    #
    # warnings ยังคืนครบเหมือนเดิม — แค่ไม่เอามาตัดสิน confidence
    if amount is None:
        conf = "low"
    elif amt_hint and date:
        conf = "high"          # ยอดมาจากป้ายกำกับ + มีวันที่ → บันทึกได้เลย
    else:
        conf = "medium"        # ยอดเดาจากค่ามากสุด หรือไม่มีวันที่ → ควรให้คนยืนยัน

    return {
        "amount": amount,
        "currency": detect_currency(text),
        "date": date,
        "time": f"{tm.group(1).zfill(2)}:{tm.group(2)}" if tm else None,
        "ref": _find_ref(text),
        "from": frm,
        "to": to,
        "banks": banks,
        "confidence": conf,
        "warnings": warnings,
        "raw": text,
    }


# --- self-test -----------------------------------------------------------
_SAMPLE = """โอนเงินสำเร็จ
ธนาคารกสิกรไทย K PLUS
23 ก.ค. 2569  14:35 น.
จาก: นายสมชาย ใจดี
ไปยัง: ร้านกาแฟ มุมสงบ
พร้อมเพย์
จำนวนเงิน 250.00 บาท
ค่าธรรมเนียม 0.00 บาท
รหัสอ้างอิง 015202607230001234
"""

# ข้อความ OCR จริงจาก Unlimited-OCR (มี noise: โอนเงิน→ไอนิ้น, อ้างอิง→ล้างอัง ฯลฯ)
_SAMPLE_OCR = """ไอนิ้นสําเร็จ
ธนาคารกสิกรไทย K PLUS
23 ก.ค. 2569 14:35 น.
จาก: นายสมชาย ใจดี
xxx-x-x1234-x ส.กลิทรโทษ
ไปยั่ง: ร้านกาแฟ มุมสงบ
พร้อมเพย 0899999999
จำนวนเงิน
250.00 บาท
คำธรรมเนียม 0.00 บาท
รหัสล้างอัง: 015202607230001234
"""

if __name__ == "__main__":
    for label, sample in [("สังเคราะห์", _SAMPLE), ("OCR จริง (มี noise)", _SAMPLE_OCR)]:
        got = parse_slip(sample)
        got.pop("raw")
        print(f"--- {label} ---")
        print(json.dumps(got, ensure_ascii=False, indent=2))
        assert got["amount"] == "250.00", got["amount"]
        assert got["date"] == "2026-07-23", got["date"]
        assert got["time"] == "14:35", got["time"]
        assert got["ref"] == "015202607230001234", got["ref"]
        assert "kbank" in got["banks"] and "promptpay" in got["banks"], got["banks"]
        assert "สมชาย" in got["from"], got["from"]
        assert got["to"] and "กาแฟ" in got["to"], got["to"]
        print()
    print("self-test ผ่านทั้ง 2 เคส ✅ (รวมข้อความ OCR จริงที่มี noise)")
