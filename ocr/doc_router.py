"""doc_router.py — จำแนกชนิดเอกสารจากข้อความ OCR เพื่อ route ไป parser ที่ถูกตัว.

ใช้โดย endpoint /parse (auto): OCR ครั้งเดียว → classify → เรียก parser ที่เหมาะ
(parse_slip / parse_payslip / parse_receipt). ผู้เรียก API ไม่ต้องรู้ล่วงหน้าว่าเป็น
เอกสารชนิดไหน.

จำแนกด้วยการนับ "สัญญาณเด่น" ต่อชนิด แล้วเลือกชนิดที่คะแนนสูงสุด. stdlib ล้วน.
รัน self-test:  python doc_router.py
"""
import re

# สัญญาณเด่นต่อชนิด (คำที่ OCR มักอ่านถูกและชี้ชนิดเอกสารได้)
_TRANSFER = re.compile(
    r"โอนเงิน|โอนสำเร็จ|พร้อมเพย์?|promptpay|verified\s*by|เลขที่รายการ|สแกน"
    r"|scan\s*to\s*pay|transfer|โอนไป|จำนวน\s*:", re.I)
_PAYSLIP = re.compile(
    r"pay\s*slip|payslip|payroll|salary\s*slip|เงินเดือน|เงินได้สุทธิ|ใบจ่ายเงินเดือน"
    r"|ใบรับเงินเดือน|ใบแจ้งเงินได้|รวมหัก|รวมรายการหัก|รายการหัก|net\s*pay"
    r"|ประกันสังคม|กองทุนสำรอง|ภาษีเงินได้|งวดจ่าย|รหัสพนักงาน|employee", re.I)
_RECEIPT = re.compile(
    r"\breceipt\b|invoice|ใบเสร็จ|ใบกำกับ|ใบเสร็จรับเงิน|grand\s*total|sub[\s\-]*total"
    r"|cashier|salesperson|\bqty\b|quantity|\bgst\b|\bvat\b|\bchange\b|rounding"
    r"|ยอดรวม|รวมเงิน|เงินทอน|เงินสด", re.I)

# ลำดับตัดสินเมื่อคะแนนเสมอ (จำเพาะสุด → ทั่วสุด)
_ORDER = ["transfer", "payslip", "receipt"]
_PATTERNS = {"transfer": _TRANSFER, "payslip": _PAYSLIP, "receipt": _RECEIPT}


def classify(text: str) -> str:
    """ข้อความ OCR → 'transfer' | 'payslip' | 'receipt' | 'unknown'."""
    scores = {t: len(_PATTERNS[t].findall(text or "")) for t in _ORDER}
    best = max(scores.values())
    if best == 0:
        return "unknown"
    # เลือกคะแนนสูงสุด; เสมอ → ตาม _ORDER (transfer > payslip > receipt)
    for t in _ORDER:
        if scores[t] == best:
            return t
    return "unknown"


# --- self-test -----------------------------------------------------------
_CASES = [
    ("โอนเงินสำเร็จ\nธนาคารกสิกรไทย K PLUS\nเลขที่รายการ 123\nverified by K+", "transfer"),
    ("ใบจ่ายเงินเดือน (Payslip)\nเงินเดือน 50,000\nรวมหัก 3,250\nประกันสังคม 750", "payslip"),
    ("HIP Global Co., Ltd.\nรวมขายได้ 28,800\nรวมหัก 750\nประกันสังคม", "payslip"),
    ("BOOK TA_K SDN BHD\nCASH BILL\nTotal 9.00\nCash 10.00\nCHANGE 1.00", "receipt"),
    ("SIMPLIFIED TAX INVOICE\nSUB-TOTAL 30.00\nGST 2.10\nTOTAL 32.10\nCASHIER", "receipt"),
    ("ข้อความมั่วไม่มีสัญญาณอะไร 123 456", "unknown"),
]

if __name__ == "__main__":
    ok = 0
    for txt, exp in _CASES:
        got = classify(txt)
        mark = "✓" if got == exp else "✗"
        ok += got == exp
        print(f"  {mark} คาด {exp:9} ได้ {got}")
    print(f"\nself-test: {ok}/{len(_CASES)} ผ่าน")
    assert ok == len(_CASES)
    print("doc_router พร้อม ✅")
