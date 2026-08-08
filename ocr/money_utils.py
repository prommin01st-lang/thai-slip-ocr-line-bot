"""money_utils.py — helper กลางเรื่องสกุลเงิน (ใช้ร่วมทุก parser).

เลิก hardcode "THB": ตรวจสกุลเงินจากข้อความ OCR (SROIE เป็น RM/$ → ตอบ THB ผิด).
เป็น Thai-first: ถ้าไม่เจอสัญญาณสกุลอื่นเลย default = THB.
"""
import re

# เรียงจาก "จำเพาะ" → "กำกวม". $ อยู่ท้ายสุด (กำกวม: อาจ USD/SGD/MYR).
_CURRENCIES = [
    (re.compile(r"฿|บาท|\bTHB\b|พร้อมเพย์|promptpay", re.I), "THB"),
    (re.compile(r"\bRM\b|ringgit|ริงกิต", re.I), "MYR"),
    (re.compile(r"\bUSD\b|US\$|ดอลลาร์|dollar", re.I), "USD"),
    (re.compile(r"€|\bEUR\b|euro|ยูโร", re.I), "EUR"),
    (re.compile(r"£|\bGBP\b|pound", re.I), "GBP"),
    (re.compile(r"¥|\bJPY\b|\bCNY\b|เยน|หยวน", re.I), "JPY"),
    (re.compile(r"\bSGD\b|S\$", re.I), "SGD"),
    (re.compile(r"\$", ), "USD"),          # $ เดี่ยว → USD (สุดท้าย เพราะกำกวม)
]


def detect_currency(text: str, default: str = "THB") -> str:
    """ข้อความ OCR → รหัสสกุลเงิน (ISO-ish). ไม่เจอสัญญาณ → default (THB)."""
    for rx, code in _CURRENCIES:
        if rx.search(text or ""):
            return code
    return default


if __name__ == "__main__":
    cases = [
        ("จำนวนเงิน 250.00 บาท", "THB"),
        ("TOTAL RM 9.00\nCASH RM 10.00", "MYR"),
        ("Amount USD 12.50", "USD"),
        ("Total: $7.60", "USD"),
        ("ไม่มีสัญลักษณ์สกุลเงิน 100.00", "THB"),
    ]
    ok = sum(detect_currency(t) == e for t, e in cases)
    for t, e in cases:
        g = detect_currency(t)
        print(f"  {'✓' if g == e else '✗'} {e:4} ← {t[:30]!r}  (ได้ {g})")
    print(f"\nself-test: {ok}/{len(cases)}")
    assert ok == len(cases)
    print("money_utils พร้อม ✅")
