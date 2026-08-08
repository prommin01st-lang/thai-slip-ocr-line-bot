"""receipt_parser.py — แปลงข้อความ OCR ของ "ใบเสร็จ/ใบกำกับภาษี" → dict (เน้นยอดรวมสุทธิ).

ต่างจาก slip_parser (สลิปโอน มียอดเดียว) — ใบเสร็จมีตัวเลขเต็มไปหมด: ราคาต่อรายการ,
รวมย่อย (sub-total), ภาษี (GST/VAT), ส่วนลด, ปัดเศษ, เงินสด (cash), เงินทอน (change).
`slip_parser._find_amount` เลือก max/ใกล้คำ total → หยิบผิดบ่อย (บน SROIE amount ตรง GT ~52%).

กลยุทธ์เลือก "grand total":
  1) หาบรรทัดที่มี "ป้ายยอดรวมเด่น" (grand total / amount due / รวมสุทธิ ...) ที่ไม่ใช่
     sub-total → ให้ priority สูง.
  2) ถ้าไม่มี ใช้คำ "total" แบบหลวม แต่ตัดบรรทัด cash/change/qty/tax/subtotal ทิ้ง.
  3) ถ้ายังไม่เจอ fallback = max ของเงิน "หลังตัดบรรทัด cash/change/subtotal" (กัน cash>total).
  เลือกป้าย priority สูงสุด, ถ้าเสมอเอา "ล่างสุด" (grand total มักอยู่ท้ายบิล).

stdlib ล้วน. รัน self-test:  python receipt_parser.py
"""
import re
import json
from money_utils import detect_currency

# ยอดเงิน: บังคับทศนิยม 2 ตำแหน่ง (กันจับ qty/เลขนับ). อนุญาต $ / RM นำหน้า.
_MONEY = re.compile(r"(?:\$|RM|฿|บาท)?\s*(\d{1,3}(?:,\d{3})*\.\d{2})")
# ยอดเงินแบบหลวม (เผื่อ fallback เลขจำนวนเต็ม)
_MONEY_LOOSE = re.compile(r"(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)")

# ป้ายยอดรวมเด่น (grand total) — priority 3
_GRAND = re.compile(
    r"grand\s*total|nett?\s*total|net\s*total|total\s*amount|amount\s*(?:due|payable)"
    r"|total\s*(?:due|payable)|balance\s*due|rounded?\s*total|total\s*\(?rm\)?"
    r"|ยอดสุทธิ|รวมสุทธิ|ยอดรวมสุทธิ|รวมทั้งสิ้น|ยอดชำระ|จำนวนเงินรวม|ยอดที่ต้องชำระ",
    re.I,
)
# ป้าย total หลวม (priority 2)
_TOTAL = re.compile(r"\btotal\b|ยอดรวม|รวมเงิน|รวม", re.I)
# บรรทัดที่ "ไม่ใช่ยอดรวม" — ตัดทิ้ง (แต่ 'rounding adj' ≠ 'rounded total')
_NEG = re.compile(
    r"sub[\s\-]*total|subtotal|qty|quantit|item|saving|discount|เงินสด|เงินทอน"
    r"|cash|change|tender|paid|gst|vat|\btax\b|service|svc|rounding|round\s*adj|round\s*off"
    r"|ส่วนลด|ภาษี|เงินรับ|เงินที่รับ",
    re.I,
)
_SUB = re.compile(r"sub[\s\-]*total|subtotal|ยอดรวมย่อย", re.I)
# fallback: ตัดเฉพาะบรรทัดที่ "ไม่มีทางเป็นยอดรวม" และมักใหญ่กว่า (เงินรับ/ทอน/รวมย่อย)
# — คงบรรทัดราคาสินค้า/ภาษีไว้ เพื่อ max หายอดที่แท้จริง
_NEG_CASH = re.compile(
    r"sub[\s\-]*total|subtotal|cash|change|tender|paid|เงินสด|เงินทอน|เงินรับ|เงินที่รับ", re.I)

# วันที่ (สากล + ไทย + ชื่อเดือนอังกฤษ)
_TH_MONTH = {"ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
             "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12}
_EN_MONTH = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
_DATE_NUM = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b")
_DATE_EN = re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{2,4})\b")
_DATE_TH = re.compile(r"\b(\d{1,2})\s*(" + "|".join(map(re.escape, _TH_MONTH)) + r")\s*(\d{2,4})")


def _to_lines(text: str) -> list:
    t = re.sub(r"</td>\s*<td[^>]*>", "  ", text)
    t = re.sub(r"</tr>\s*<tr[^>]*>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    return [ln for ln in t.splitlines()]


def _monies(line: str):
    return [float(m.replace(",", "")) for m in _MONEY.findall(line)]


def _find_total(text: str):
    lines = _to_lines(text)
    cands = []  # (priority, n_monies, value)
    for ln in lines:
        vals = _monies(ln)
        if not vals:
            continue
        if _GRAND.search(ln) and not _SUB.search(ln):
            pr = 3
        elif _TOTAL.search(ln) and not _NEG.search(ln):
            pr = 2
        else:
            continue
        # ค่าตัวแทนของบรรทัด = มากสุด (ยอดรวม > tax/ปัดเศษที่อยู่บรรทัดเดียวกัน)
        cands.append((pr, len(vals), max(vals)))
    if cands:
        top = max(p for p, _, _ in cands)
        tops = [c for c in cands if c[0] == top]
        # ชอบบรรทัด "เลขตัวเดียว" (ยอดรวมสะอาด เช่น 'TOTAL : 55.10') ก่อนบรรทัดสรุป
        # ที่มีหลายเลข ('TOTAL: 52.00 3.12' = subtotal+tax → หยิบพลาด)
        singles = [c for c in tops if c[1] == 1]
        pool = singles or tops
        return max(c[2] for c in pool), True    # (total, มาจากป้าย)
    # fallback: max เงินหลังตัดเฉพาะบรรทัด cash/change/subtotal (กัน cash>total)
    pool = []
    for ln in lines:
        if _NEG_CASH.search(ln):
            continue
        pool += _monies(ln)
    return (max(pool), False) if pool else (None, False)


def _find_date(text: str):
    m = _DATE_NUM.search(text)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        if y > 2400:
            y -= 543
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{y:04d}-{mo:02d}-{d:02d}"
    m = _DATE_EN.search(text)
    if m and m.group(2).upper() in _EN_MONTH:
        y = int(m.group(3))
        if y < 100:
            y += 2000
        return f"{y:04d}-{_EN_MONTH[m.group(2).upper()]:02d}-{int(m.group(1)):02d}"
    m = _DATE_TH.search(text)
    if m:
        d, mo, y = int(m.group(1)), _TH_MONTH[m.group(2)], int(m.group(3))
        if y < 100:
            y += 2500
        if y > 2400:
            y -= 543
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def parse_receipt(text: str) -> dict:
    total, from_label = _find_total(text)
    date = _find_date(text)
    warnings = []
    if total is None:
        warnings.append("ไม่พบยอดรวม")
    elif not from_label:
        warnings.append("ยอดรวมเดาจากค่ามากสุด (ไม่พบป้าย TOTAL/ยอดรวม)")
    if date is None:
        warnings.append("ไม่พบวันที่")
    conf = "high" if total is not None and from_label and date else \
           ("low" if total is None else "medium")
    return {
        "total": f"{total:.2f}" if total is not None else None,
        "currency": detect_currency(text),
        "date": date,
        "amounts": sorted({v for ln in _to_lines(text) for v in _monies(ln)}, reverse=True),
        "confidence": conf,
        "warnings": warnings,
        "raw": text,
    }


# --- self-test -----------------------------------------------------------
_CASES = [
    # (ข้อความ, total ที่ถูก)  — เน้นให้ "ไม่หยิบ cash/change/subtotal/max"
    ("Total: 9.00\nRounded Total (RM): 9.00\nCash 10.00\nCHANGE 1.00", "9.00"),
    ("SUB-TOTAL 30.00\nGST 6% 2.10\nTOTAL 32.10\nCASH 50.00\nCHANGE 17.90", "32.10"),
    ("AMOUNT DUE 33.90\nCASH 100.00\nCHANGE 66.10", "33.90"),
    ("ยอดรวม 100.00\nภาษีมูลค่าเพิ่ม 7.00\nรวมสุทธิ 107.00\nเงินสด 200.00\nเงินทอน 93.00", "107.00"),
    # ไม่มีป้าย total ชัด → fallback max หลังตัด cash/change
    ("ITEM A 12.00\nITEM B 8.00\nCASH 50.00\nCHANGE 30.00", "12.00"),
    ("<table><tr><td>Total</td><td>9.00</td></tr><tr><td>Cash</td><td>10.00</td></tr></table>", "9.00"),
]

if __name__ == "__main__":
    ok = 0
    for i, (txt, exp) in enumerate(_CASES, 1):
        got = parse_receipt(txt)["total"]
        mark = "✓" if got == exp else "✗"
        ok += got == exp
        print(f"  {mark} case {i}: total={got}  (คาด {exp})")
    print(f"\nself-test: {ok}/{len(_CASES)} ผ่าน")
    assert ok == len(_CASES), "มีเคสไม่ผ่าน"
    print("receipt_parser พร้อม ✅")
