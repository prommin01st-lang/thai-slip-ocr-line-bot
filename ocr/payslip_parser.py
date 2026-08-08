"""
payslip_parser.py — แปลงข้อความ OCR ของ "ใบเงินเดือน/สลิปเงินเดือน" (Payslip) ไทย → dict.

ต่างจาก slip_parser.py (สลิป "โอนเงิน") — ใบเงินเดือนมีโครงคนละแบบ: บริษัท, พนักงาน,
งวดจ่าย, รายการรายได้ (เงินเดือน/OT/เบี้ยขยัน), รายการหัก (ภาษี/ประกันสังคม/กองทุน),
ยอดรวมรายได้, รวมหัก, และเงินสุทธิ.

stdlib ล้วน (regex + difflib) — ไม่พึ่ง torch. รัน self-test:  python payslip_parser.py

การดึงยอดทำ 2 ชั้น:
  1) regex ป้ายตรงตัว (ไทย + อังกฤษ) — แม่นบนข้อความสะอาด/ใบสังเคราะห์.
  2) fuzzy-match (difflib) เป็น fallback สำหรับป้ายไทยที่ OCR เพี้ยน — จับคู่ (label, เงิน)
     แล้ววัดความคล้ายกับป้ายมาตรฐาน (เช่น "ตามรายได้"→รวมรายได้, "เงินดื่ม"→เงินเดือน).

ข้อจำกัดที่รู้ทั้งที่ทำ (verified 2026-07-26):
- Unlimited-OCR อ่าน "ตัวเลข/วันที่/โครงตาราง" แม่น แต่ "ป้ายภาษาไทยเพี้ยน". fuzzy ช่วย
  เคสเพี้ยนปานกลาง (ยังเหลือรากคำ เช่น "ได้"/"หัก"/"เดือน") — แต่เพี้ยนหนักมาก
  (ประกันสังคม→"ทักษาโทกับสักผม") กู้ไม่ได้ เพราะตัวอักษรแทบไม่เหลือเค้าเดิม.
- บนข้อความสะอาด (ใบสังเคราะห์/ป้ายสองภาษา) parser ดึงได้ครบ → "ตรรกะถูก ข้อจำกัดที่ OCR".
- ใบเงินเดือนมักใช้ป้ายอังกฤษกำกับ (Payslip / Net Pay / Total) → จับอังกฤษเป็นหลัก.
"""
import re
import json
from difflib import SequenceMatcher
from money_utils import detect_currency

# ---- ชนิดเอกสาร: ใช้จำแนก payslip vs สลิปโอน (route อัตโนมัติได้) -----------
_PAYSLIP_HINT = re.compile(
    r"pay\s*slip|payslip|payroll|salary\s*slip"
    r"|เงินเดือน|เงินได้|สลิปเงินเดือน|ใบแจ้งเงิน|ใบรับเงินเดือน|ใบจ่ายเงินเดือน"
    # สัญญาณเชิงโครงสร้าง — OCR มักอ่านคำพวกนี้ถูกแม้ป้าย title เพี้ยน
    r"|รวมหัก|รวมรายการหัก|รายการหัก|รวมรายได้|รวมขายได้|รวมเงินได้"
    r"|total\s*deduction|total\s*income|net\s*pay|gross",
    re.I,
)
_TRANSFER_HINT = re.compile(
    r"โอนเงิน|โอนสำเร็จ|พร้อมเพย์?|PromptPay|verified by|สแกน|เลขที่รายการ|จำนวน\s*:",
    re.I,
)

# จำนวนเงิน: มีคอมมา หรือ ทศนิยม 2 ตำแหน่ง หรือ เลขล้วน >=4 หลัก (เช่น 25000)
_MONEY = r"(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}|\d{4,})"
_MONEY_RE = re.compile(_MONEY)

# วันที่ dd/mm/yyyy | dd-mm-yy  และแบบไทย 26 ก.ย. 2553
_TH_MONTH = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}
_DATE_NUM = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b")
_DATE_TH = re.compile(r"\b(\d{1,2})\s*(" + "|".join(map(re.escape, _TH_MONTH)) + r")\s*(\d{2,4})")

# ป้ายยอดสรุป: อังกฤษเป็นหลัก (เชื่อได้) + ไทยแบบหลวม. ".{0,25}?" ข้ามป้ายที่ OCR
# แทรกอักขระ/ช่องว่างก่อนถึงตัวเลข.
def _labeled(label_rx: str) -> re.Pattern:
    # จับ gap ไว้ด้วย เพื่อให้ _labeled_val ตรวจได้ว่ามี "ป้ายอื่น" คั่นอยู่หรือเปล่า
    return re.compile(label_rx + r"(?P<gap>.{0,25}?)" + _MONEY, re.I | re.S)


# "บรรทัดเต็มที่มีตัวอักษร คั่นอยู่ระหว่างป้ายกับตัวเลข" = ป้ายของอีกคอลัมน์
# ต้องมี \n ทั้งหน้าและหลัง — ไม่งั้นจะไปตัดคำแปลในบรรทัดเดียวกันอย่าง "(Net Pay)" ทิ้ง
_LINE_BETWEEN = re.compile(r"\n[^\n]*[A-Za-z฀-๿][^\n]*\n")

_NET = _labeled(r"(?:net\s*(?:pay|income|salary|total)|เงินได้สุทธิ|รายได้สุทธิ|เงินสุทธิ|สุทธิ|เงินโอนเข้าบัญชี|เงินบัญชี|รับสุทธิ)")
_GROSS = _labeled(r"(?:gross|total\s*(?:income|earnings|earning)|รวมรายได้|รายได้รวม|รวมเงินได้|รวมได้)")
_DEDUCT = _labeled(r"(?:total\s*deduction[s]?|รวมรายการหัก|รวมเงินหัก|รวมหัก)")
_SALARY = _labeled(r"(?:base\s*salary|monthly\s*salary|salary|เงินเดือน)")
_TAX = _labeled(r"(?:withholding\s*tax|income\s*tax|w/?tax|tax|ภาษีเงินได้|ภาษี\s*หัก\s*ณ\s*ที่จ่าย|ภาษี)")
_SSO = _labeled(r"(?:social\s*security|sso|ประกันสังคม)")

# เลขบัญชี: คำนำ + เลข/ x ยาว
_ACCOUNT = re.compile(
    r"(?:account\s*(?:no|number|#)?|เลขที่บัญชี|หมายเลขบัญชี|เลขบัญชี|บัญชีเลขที่)"
    r"\D{0,6}?([\dxX][\dxX\-\s]{6,}\d)",
    re.I,
)
# รหัสพนักงาน: CE-001, EMP123, หรือ เลข 3-6 หลักหลังคำนำ
_EMP_ID = re.compile(
    r"(?:employee\s*(?:id|no|code)|emp\s*(?:id|no)|รหัสพนักงาน|รหัสพน\S*)"
    r"\D{0,6}?([A-Za-z]{1,4}[-\s]?\d{2,6}|\d{3,6})",
    re.I,
)
# ชื่อพนักงาน (best-effort — OCR เพี้ยนชื่อบ่อย)
_EMP_NAME = re.compile(
    r"(?:employee\s*name|ชื่อพนักงาน|ชื่อ-สกุล|ชื่อ\s*สกุล)\s*[:：]?\s*([^\n<]{2,40})",
    re.I,
)
# บริษัท: บรรทัดที่มี Co./Ltd./บริษัท/จำกัด
_COMPANY = re.compile(r"([^\n<>]*?(?:Co\.?,?\s*Ltd\.?|Company|บริษัท[^\n<>]*?จำกัด|บริษัท[^\n<>]{2,40}))", re.I)


def _to_lines(text: str) -> str:
    """แปลง <table>...</table> ของ Unlimited-OCR เป็นข้อความบรรทัด/คั่นด้วยช่องว่าง
    เพื่อให้ label กับตัวเลขที่อยู่คนละ <td> มาอยู่ใกล้กันในสตริงเดียว."""
    t = re.sub(r"</td>\s*<td[^>]*>", "  ", text)     # cell → cell : เว้นวรรค
    t = re.sub(r"</tr>\s*<tr[^>]*>", "\n", t)         # row → row : ขึ้นบรรทัด
    t = re.sub(r"<[^>]+>", " ", t)                    # tag อื่นทิ้ง
    return t


def _money_val(s: str) -> float:
    return float(s.replace(",", ""))


def _date_spans(text: str):
    return [m.span() for m in _DATE_NUM.finditer(text)] + [m.span() for m in _DATE_TH.finditer(text)]


def _all_amounts(text: str):
    """ตัวเลขเงินทั้งหมด (ไม่รวมที่อยู่ในช่วงวันที่/เลขบัญชี) เรียงมาก→น้อย, ไม่ซ้ำ."""
    # กันเลขในวันที่ และในเลขบัญชี ไม่ให้ถูกนับเป็นจำนวนเงิน
    spans = _date_spans(text)
    for rx in (_ACCOUNT, _EMP_ID):
        spans += [m.span() for m in rx.finditer(text)]
    def in_excluded(a, b):
        return any(a >= s and b <= e for s, e in spans)
    vals = []
    for m in _MONEY_RE.finditer(text):
        if in_excluded(*m.span()):
            continue
        vals.append(m.group(1))
    # ไม่ซ้ำ (ตามค่า) เรียงมาก→น้อย
    seen, out = set(), []
    for v in sorted(vals, key=_money_val, reverse=True):
        k = _money_val(v)
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out


def _labeled_val(rx: re.Pattern, text: str):
    """ค่าของป้ายนั้น — ข้ามคู่ที่ "มีป้ายอื่นคั่น" อยู่ระหว่างป้ายกับตัวเลข.

    `_labeled` ใช้ re.S ทำให้ gap ข้าม newline ได้ ซึ่งจำเป็นกับ OCR ที่แยกป้าย/ค่า
    คนละบรรทัด แต่ก็เปิดช่องให้ข้ามไป**หยิบเลขของคอลัมน์อื่น**ด้วย เช่น

        เงินรับสุทธิ
        รวมรายได้
        51,500.00     ← เลขของ "รวมรายได้" ไม่ใช่ของ "เงินรับสุทธิ"

    กติกา: ข้ามเฉพาะเมื่อ gap มี **บรรทัดเต็ม ๆ ที่มีตัวอักษรคั่นอยู่** (`\\n...ตัวอักษร...\\n`)
    เพราะนั่นคือป้ายของอีกคอลัมน์/แถว

    เคสที่ยังต้องรับ (เคยพลาดมาแล้ว — อย่าทำให้เข้มกว่านี้):
      - `"เงินได้สุทธิ (Net Pay)\\n220,390.00"` → gap = `" (Net Pay)\\n"`
        เป็นคำแปลของป้ายเดียวกันในบรรทัดเดียวกัน ไม่ใช่ป้ายอื่น
      - `"เงินได้สุทธิ\\n220,390.00"`           → gap = `"\\n"` ป้ายกับค่าคนละบรรทัดตามปกติ
      - `"Net Pay THB 51,350.00"`             → gap = `" THB "` สกุลเงินคั่น
    """
    for m in rx.finditer(text):
        gap = m.groupdict().get("gap")
        if gap is None:                       # pattern ที่ไม่ได้สร้างจาก _labeled
            return m.group(1)
        if _LINE_BETWEEN.search(gap):
            continue
        return m.group(2)
    return None


def _norm_date(m, thai=False):
    if thai:
        d, mon, y = int(m.group(1)), _TH_MONTH[m.group(2)], int(m.group(3))
        if y < 100:
            y += 2500
    else:
        d, mon, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
    if y > 2400:      # พ.ศ. → ค.ศ.
        y -= 543
    if not (1 <= mon <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mon:02d}-{d:02d}"


def _find_dates(text: str):
    """คืน list วันที่ (ISO) เรียงตามที่พบ — ใบเงินเดือนมักมีงวด 'จาก-ถึง'."""
    found = []
    for m in _DATE_NUM.finditer(text):
        iso = _norm_date(m)
        if iso:
            found.append(iso)
    for m in _DATE_TH.finditer(text):
        iso = _norm_date(m, thai=True)
        if iso:
            found.append(iso)
    # ไม่ซ้ำ คงลำดับ
    out = []
    for x in found:
        if x not in out:
            out.append(x)
    return out


# ---- fuzzy-match ป้ายไทยที่ OCR เพี้ยน ---------------------------------------
# ป้ายมาตรฐานต่อฟิลด์ (ตัวแทนหลายสะกด). ป้าย "ยอดรวม" อยู่กลุ่มบน (คะแนนสูงกว่า
# ป้าย "รายการย่อย" ได้เพราะจับคู่ทั้งสตริง). fuzzy จะเลือก field ที่คล้ายสุด.
_CANON = {
    # รายการย่อย
    "salary":          ["เงินเดือน", "เงินเดิอน"],
    "tax":             ["ภาษีเงินได้", "ภาษีหักณที่จ่าย", "ภาษี"],
    "social_security": ["ประกันสังคม"],
    "provident_fund":  ["กองทุนสำรองเลี้ยงชีพ", "กองทุนสำรอง", "กองทุน"],
    # ยอดรวม
    "gross_income":     ["รวมรายได้", "รวมเงินได้", "รวมขายได้", "รายได้รวม", "รวมได้"],
    "total_deductions": ["รวมรายการหัก", "รวมเงินหัก", "รวมหัก", "รวมที่หัก"],
    "net_pay":          ["เงินได้สุทธิ", "รายได้สุทธิ", "เงินสุทธิ", "รับสุทธิ",
                         "เงินโอนเข้าบัญชี", "เงินบัญชี", "สุทธิ"],
}
# ฟิลด์ "ยอดรวม" ที่จะเติมด้วย fuzzy (รายการย่อยเสี่ยงชนกันสูง เติมเฉพาะที่มั่นใจ)
_FUZZY_FIELDS = ["gross_income", "total_deductions", "net_pay",
                 "salary", "tax", "social_security"]

_SEP = re.compile(r"[\s()\[\]:：.,\-_/]+")

# token เด่นที่ OCR มักคงไว้ + แยกฟิลด์ได้เด็ดขาด (เช็คก่อน ratio, ตามลำดับความสำคัญ).
# net มาก่อน gross เพราะ "รายได้สุทธิ" มีทั้ง "ได้" และ "สุทธิ" → ต้องให้ "สุทธิ" ชนะ.
_STRONG = [
    ("net_pay",          ["สุทธิ", "ทธิ", "บัญชี", "ญชี", "โอนเข้า"]),
    ("total_deductions", ["รวมรายการหัก", "รายการหัก", "รวมหัก", "มหัก", "รวมที่หัก"]),
    ("gross_income",     ["รวมรายได้", "มรายได้", "รายได้รวม", "รวมขายได้", "มขายได้",
                          "ตามรายได้", "รวมได้"]),
    ("social_security",  ["ประกันสังคม", "นสังคม", "สังคม"]),
    ("provident_fund",   ["สำรองเลี้ยง", "กองทุน", "องทุน"]),
    ("salary",           ["เงินเดือน", "นเดือน", "เดือน"]),
    ("tax",              ["ภาษีเงินได้", "ภาษี", "าษี"]),
]


def _norm(s: str) -> str:
    """ตัดอักขระคั่น/ช่องว่างออก เหลือแต่เนื้อป้าย เพื่อเทียบความคล้ายอย่างยุติธรรม."""
    return _SEP.sub("", s or "")


def _fuzzy_field(label: str, threshold: float = 0.6):
    """ป้าย (อาจเพี้ยน) → (field, score); ต่ำกว่า threshold → (None, score).

    2 ชั้น: (ก) token เด่น (_STRONG) เจอเป็น substring → ตัดสินทันที (แยก สุทธิ/หัก/ได้
    เด็ดขาด แม้ตัวหน้าเพี้ยน); (ข) ไม่เข้า → ratio ทั้งสตริงกับ canon ทุกตัว."""
    lab = _norm(label)
    if len(lab) < 2:
        return None, 0.0
    # (ก) token เด่น — ลำดับสำคัญ (net ก่อน gross)
    for field, toks in _STRONG:
        if any(tok in lab for tok in toks):
            return field, 0.9
    # (ข) ratio ทั้งสตริง
    best_f, best_s = None, 0.0
    for field, canons in _CANON.items():
        for c in canons:
            s = SequenceMatcher(None, lab, _norm(c)).ratio()
            if s > best_s:
                best_f, best_s = field, s
    return (best_f, best_s) if best_s >= threshold else (None, best_s)


def _pairs(lined_text: str):
    """แตกเป็นคู่ (label, money) ต่อบรรทัด: ข้อความก่อนตัวเลขเงิน = ป้ายของเลขนั้น.
    ใช้กับผลจาก _to_lines() (ตาราง <td> ถูกแปลงเป็นคำคั่นช่องว่างแล้ว)."""
    out = []
    for line in lined_text.splitlines():
        prev = 0
        for m in _MONEY_RE.finditer(line):
            label = line[prev:m.start()]
            out.append((label, m.group(1)))
            prev = m.end()
    return out


# บรรทัดที่เป็น "จำนวนเงินล้วน" ทั้งบรรทัด — เข้มกว่า _MONEY_RE ที่โลภเกินไป
# (_MONEY_RE จับ "2565" จาก 25/08/2565 และ "8888" จากเลขบัญชี → จับคู่มั่ว)
_MONEY_ONLY_LINE = re.compile(r"^(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})$")
_HAS_LETTER = re.compile(r"[A-Za-z฀-๿]")


def _pairs_crossline(lined_text: str):
    """จับคู่ (label, money) ที่อยู่ **คนละบรรทัด**.

    OCR แบบกล่องต่อกล่อง (PaddleOCR/Tesseract) คืนแต่ละ text box เป็นคนละบรรทัด
    ป้ายกับค่าจึงแยกกัน — `_pairs()` ที่ดูเฉพาะบรรทัดเดียวกันจับไม่ได้เลย:

        รวมรายได้
        51,500.00

    วิธี: บรรทัดที่มีตัวอักษร = ป้าย เก็บค้างไว้; บรรทัดที่เป็นจำนวนเงินล้วน =
    จับกับป้ายค้างที่ **ใกล้ที่สุด** (LIFO) แล้วตัดออกจากคิว — รองรับตารางที่ป้าย
    หลายอันมากองก่อนค่าจะตามมา (เช่น 'เงินรับสุทธิ' อยู่คนละคอลัมน์กับค่าของมัน).
    """
    pending, out = [], []
    for line in lined_text.splitlines():
        line = line.strip()
        if not line:
            continue
        if _MONEY_ONLY_LINE.match(line):
            if pending:
                out.append((pending.pop(), line))
            continue
        if not _HAS_LETTER.search(line):
            continue                     # เลขอื่น ๆ (วันที่ / จำนวนหน่วย / แถวธนบัตร) — ข้าม
        if _MONEY_RE.search(line):
            pending.clear()              # ป้าย+ค่าอยู่บรรทัดเดียวกัน → _pairs() จัดการแล้ว
            continue
        pending.append(line)
    return out


def _fuzzy_map(lined_text: str):
    """คืน dict field → money (สตริง) จาก fuzzy ของทุกคู่ (label, money);
    ถ้าฟิลด์เดียวมีหลายคู่ เก็บอันคะแนนสูงสุด.

    คู่บรรทัดเดียวกันมาก่อนคู่ข้ามบรรทัดเสมอ — เงื่อนไขเก็บคือ score > เดิม (มากกว่าจริง)
    ดังนั้นคะแนนเท่ากันตัวแรกชนะ = พฤติกรรมเดิมไม่เปลี่ยน."""
    best = {}   # field -> (score, money)
    for label, money in [*_pairs(lined_text), *_pairs_crossline(lined_text)]:
        field, score = _fuzzy_field(label)
        if field and (field not in best or score > best[field][0]):
            best[field] = (score, money)
    return {f: mv[1] for f, mv in best.items()}


def detect_doc_type(text: str) -> str:
    """'payslip' | 'transfer' | 'unknown' — ใช้ route ไป parser ที่ถูกตัว."""
    pay = len(_PAYSLIP_HINT.findall(text))
    trf = len(_TRANSFER_HINT.findall(text))
    if pay and pay >= trf:
        return "payslip"
    if trf:
        return "transfer"
    return "unknown"


def parse_payslip(text: str) -> dict:
    """ข้อความ OCR (รองรับทั้ง <table> และข้อความล้วน) → dict. หาไม่เจอ = None."""
    t = _to_lines(text)

    # ชั้น 1: regex ป้ายตรงตัว
    fields = {
        "salary": _labeled_val(_SALARY, t),
        "tax": _labeled_val(_TAX, t),
        "social_security": _labeled_val(_SSO, t),
        "gross_income": _labeled_val(_GROSS, t),
        "total_deductions": _labeled_val(_DEDUCT, t),
        "net_pay": _labeled_val(_NET, t),
    }
    # ชั้น 2: fuzzy — เติมเฉพาะฟิลด์ที่ regex ยังว่าง (ไม่ทับของที่แม่นแล้ว)
    fuzzy = _fuzzy_map(t)
    for f in _FUZZY_FIELDS:
        if fields.get(f) is None and fuzzy.get(f) is not None:
            fields[f] = fuzzy[f]

    net, gross, deduct = fields["net_pay"], fields["gross_income"], fields["total_deductions"]

    # เสริมความสอดคล้อง: ถ้ามี 2 ใน 3 ของ (gross, deduct, net) เติมตัวที่ขาดจากเลขคณิต
    def v(x):
        return _money_val(x) if x else None
    g, d, n = v(gross), v(deduct), v(net)
    if g is not None and d is not None and n is None:
        n = round(g - d, 2)
    elif g is not None and n is not None and d is None:
        d = round(g - n, 2)
    elif d is not None and n is not None and g is None:
        g = round(d + n, 2)

    company = _labeled_val(_COMPANY, text)
    dates = _find_dates(t)

    # ชื่อพนักงาน: ตัด parenthetical/label อังกฤษ + เครื่องหมาย : นำหน้าออก
    name = _labeled_val(_EMP_NAME, text)
    if name:
        name = re.sub(r"^\s*\([^)]*\)\s*[:：]?\s*", "", name).strip() or None

    doc_type = detect_doc_type(text)
    warnings = []
    if doc_type != "payslip":
        warnings.append(f"ไม่มั่นใจว่าเป็นใบเงินเดือน (doc_type={doc_type})")
    if n is None:
        warnings.append("ไม่พบเงินได้สุทธิ (net_pay)")
    if g is None:
        warnings.append("ไม่พบรวมรายได้ (gross)")
    core = sum(x is not None for x in (g, n))
    conf = "high" if doc_type == "payslip" and core == 2 else ("low" if core == 0 else "medium")

    return {
        "doc_type": doc_type,
        "company": company.strip() if company else None,
        "employee_name": name,
        "employee_id": _labeled_val(_EMP_ID, t),
        "pay_period": {"from": dates[0] if dates else None,
                       "to": dates[1] if len(dates) > 1 else None},
        "salary": fields["salary"],
        "tax": fields["tax"],
        "social_security": fields["social_security"],
        "gross_income": f"{g:,.2f}" if g is not None else None,
        "total_deductions": f"{d:,.2f}" if d is not None else None,
        "net_pay": f"{n:,.2f}" if n is not None else None,
        "account_no": (_labeled_val(_ACCOUNT, t) or "").replace(" ", "") or None,
        "amounts": _all_amounts(t),         # เลขเงินทั้งหมด (fallback ให้ผู้ใช้)
        "currency": detect_currency(text),
        "confidence": conf,
        "warnings": warnings,
        "raw": text,
    }


# --- self-test -----------------------------------------------------------
# (1) ใบสังเคราะห์/ป้ายสองภาษา (ข้อความสะอาด) → ต้องดึงได้ครบ
_CLEAN = """บริษัท ไอรอน โค้ช จำกัด (Iron Coach Co., Ltd.)
ใบจ่ายเงินเดือน (Payslip)
รหัสพนักงาน (Employee ID): CE-001
ชื่อพนักงาน (Employee Name): นายสมชาย ใจดี
งวดวันที่ 01/07/2569 ถึง 31/07/2569
เลขที่บัญชี (Account No): 123-4-56789-0

รายได้ (Earnings)
เงินเดือน (Salary)            50,000.00
ค่าล่วงเวลา (OT)              3,000.00
รวมรายได้ (Total Income)     53,000.00

รายการหัก (Deductions)
ภาษีเงินได้ (Tax)            2,500.00
ประกันสังคม (Social Security) 750.00
รวมหัก (Total Deductions)    3,250.00

เงินได้สุทธิ (Net Pay)       49,750.00
"""

# (2) OCR จริง (cfrkgs.jpg) มี noise + โครง <table>
_OCR_REAL = """<table><tr><td colspan="3">HIP Global Co., Ltd.รายงานฉบับที่ประเมิน:31-03-2019</td></tr></table>
<table><tr><td>เงินดื่ม</td><td>25000</td><td>ทักษาโท</td><td>.00</td></tr><tr><td>เบี่ยงยอน</td><td>1,000.00</td><td>ทักษาโทกับสักผม</td><td>750.00</td></tr><tr><td>รวมขายได้</td><td>28,800.00</td><td>รวมหัก</td><td>750.00</td></tr><tr><td>เงินบัญชี</td><td>28,050.00</td><td></td><td></td></tr></table>"""

# (3) ป้ายเพี้ยนหนัก (ecpay.png จริง) — regex ตรงตัว match ไม่โดน ต้องพึ่ง fuzzy:
#     "ตามรายได้" = รวมรายได้ (ร→ต, วม→าม) / "เว็บเลียน" = เงินเดือน
_OCR_GARBLED = """<table><tr><td>เว็บเลียน</td><td>50,000.00</td></tr>
<tr><td>ตามรายได้</td><td>51,500.00</td></tr>
<tr><td>เว็บได้ลุ่ทธิ</td><td>51,350.00</td></tr></table>"""

if __name__ == "__main__":
    print("=== (1) ข้อความสะอาด/ป้ายสองภาษา ===")
    got = parse_payslip(_CLEAN)
    show = {k: v for k, v in got.items() if k != "raw"}
    print(json.dumps(show, ensure_ascii=False, indent=2))
    assert got["doc_type"] == "payslip", got["doc_type"]
    assert got["employee_id"] == "CE-001", got["employee_id"]
    assert got["salary"] == "50,000.00", got["salary"]
    assert got["tax"] == "2,500.00", got["tax"]
    assert got["social_security"] == "750.00", got["social_security"]
    assert got["gross_income"] == "53,000.00", got["gross_income"]
    assert got["total_deductions"] == "3,250.00", got["total_deductions"]
    assert got["net_pay"] == "49,750.00", got["net_pay"]
    assert got["account_no"] == "123-4-56789-0", got["account_no"]
    assert got["pay_period"]["from"] == "2026-07-01", got["pay_period"]
    assert got["pay_period"]["to"] == "2026-07-31", got["pay_period"]
    assert "สมชาย" in (got["employee_name"] or ""), got["employee_name"]

    print("\n=== (2) OCR จริง (cfrkgs, มี noise) ===")
    got2 = parse_payslip(_OCR_REAL)
    show2 = {k: v for k, v in got2.items() if k != "raw"}
    print(json.dumps(show2, ensure_ascii=False, indent=2))
    assert got2["doc_type"] == "payslip", got2["doc_type"]
    # ป้ายไทยเพี้ยน แต่ยอดที่ป้ายยังอ่านออก (รวมขายได้/รวมหัก/เงินบัญชี) ต้องได้
    assert got2["gross_income"] == "28,800.00", got2["gross_income"]
    assert got2["total_deductions"] == "750.00", got2["total_deductions"]
    assert got2["net_pay"] == "28,050.00", got2["net_pay"]
    # fuzzy: "เงินดื่ม"→salary (เงินเดือน) แม้ regex ตรงตัวไม่โดน
    assert got2["salary"] == "25000", got2["salary"]
    # amounts ต้องมีตัวเลขหลักครบ
    assert "28,800.00" in got2["amounts"] and "25000" in got2["amounts"], got2["amounts"]

    print("\n=== (3) ป้ายเพี้ยนหนัก — ต้องพึ่ง fuzzy ===")
    got3 = parse_payslip(_OCR_GARBLED)
    show3 = {k: got3[k] for k in ("doc_type", "salary", "gross_income", "net_pay", "amounts")}
    print(json.dumps(show3, ensure_ascii=False, indent=2))
    # fuzzy กู้ยอดรวมได้: "ตามรายได้"→gross(ราก "มรายได้"), "เว็บได้ลุ่ทธิ"→net(ราก "ทธิ")
    # ทั้งที่ regex ป้ายตรงตัวไม่ match เลย. net ชนะ gross แม้มี "ได้" เพราะ token "สุทธิ" priority สูงกว่า.
    assert got3["gross_income"] == "51,500.00", got3["gross_income"]
    assert got3["net_pay"] == "51,350.00", got3["net_pay"]
    # "เว็บเลียน" (เงินเดือน) เพี้ยนหนักเกิน — กู้ไม่ได้ (honest: ตัวอักษรแทบไม่เหลือเค้า)
    assert got3["salary"] is None, got3["salary"]

    print("\nself-test ผ่านทั้ง 3 เคส ✅ (สะอาด=ครบ, OCR จริง=ยอดหลักถูก, ป้ายเพี้ยน=fuzzy กู้ยอดรวมได้)")
