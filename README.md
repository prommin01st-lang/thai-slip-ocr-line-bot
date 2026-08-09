# Thai Slip OCR — LINE Bot & Expense Tracker

> Read Thai bank transfer slips, receipts and payslips from a photo, turn them into
> structured data, and keep a personal income/expense ledger — all inside LINE chat.
> **No GPU. No LLM. Runs on a 2-core VPS.**

🇹🇭 **[อ่านเป็นภาษาไทย → README.th.md](README.th.md)**

---

## Why this exists

Most Thai slip-OCR projects either wrap a paid cloud API or bolt on a large
vision-language model. This one uses **PaddleOCR on CPU** plus hand-tuned Thai regex
parsers — and on real Thai bank slips it is **both faster and more accurate** than the
3B VLM it replaced.

### Benchmarks (measured, not estimated)

**332 real Thai bank slips** (K-Bank 255 · ttb 70 · TrueMoney 7), ground truth derived
from filenames and verified by eye:

| Metric | Result |
|---|---|
| Fields correct (`ref`, `date`, `time`) | **379 / 395 = 96%** |
| Amount detected | **332 / 332 = 100%** |
| Failed images | **0** |
| Speed | ~2 s (8-core) · **~8.5 s (2-core VPS)** |
| RAM | **235 MB** |
| VRAM | **0** |

**Same test set, two engines** — identical parser, identical ground truth:

| Test set | Unlimited-OCR 3B (GPU) | **PaddleOCR (CPU)** |
|---|---|---|
| SROIE receipts — amount | 50% | **78%** |
| SROIE receipts — date | 67% | **98%** |
| `openthaigpt/thai-ocr-evaluation` | 17% | **58%** |

A 3B vision-language model on a 6 GB GPU lost to a 215 MB CV model on CPU.
[Full write-up with every number and dead end → `bench/FINDINGS.md`](bench/FINDINGS.md)

---

## Features

**Slip reading**
- Thai bank transfer slips, receipts, payslips — document type detected automatically
- Extracts amount, date, time, reference number, sender/receiver, bank
- Handles `.webp` (LINE sends it), embossed watermarks, QR codes, phone screenshots
- Every result carries `confidence` + `warnings` — low confidence is **not** silently saved

**Ledger**
- Income/expense tracking with monthly, weekly and all-time summaries
- **Three-layer duplicate protection**: file hash (checked *before* OCR) → reference
  number → fuzzy match on amount + time
- Money stored as **integer satang** — never floats
- Budgets with over/near-limit alerts, recurring-bill detection, weekly digest
- Type `กาแฟ 60` in chat to log an expense — rule-based, no model needed

**Privacy (Thailand PDPA)**
- Explicit consent required before anything is stored
- Slip **images are never kept** — only a SHA-256 fingerprint for deduplication
- Account numbers stored as last 4 digits only
- `ลบข้อมูลของฉัน` (delete my data) truly wipes every table — with a test proving it

---

## Quick start

```bash
git clone https://github.com/<you>/thai-slip-ocr-line-bot.git
cd thai-slip-ocr-line-bot
cp .env.example .env          # add LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN
docker compose up -d --build
```

Point your LINE webhook at `https://your-domain/webhook`. That's it —
[full deployment guide → `DEPLOY.md`](DEPLOY.md).

Prefer running without Docker? `npm install && ./dev.sh`

---

## Architecture

```
LINE ──HTTPS──► bot (Node 22 + Express)  ──internal──► ocr (Python + PaddleOCR)
                     │                                      │
                     │                                 PP-OCRv5 mobile
                     └── SQLite (node:sqlite)           th recognition model
```

Two containers, split by runtime:

| Service | Stack | RAM | Image |
|---|---|---|---|
| `bot` | Node 22, Express 5, `@line/bot-sdk` | 23 MB | 296 MB |
| `ocr` | Python 3.12, PaddleOCR (CPU) | 235 MB | 2.27 GB |

`ocr` publishes **no external port** — reachable only from `bot` over the compose
network, optionally behind a shared token. Both containers run as non-root.

**No LLM anywhere in the request path.** Slip parsing is regex, categorisation is a
Thai keyword dictionary plus what the user has taught it, chat input is rule-based.

### Tech stack

| Layer | Choice |
|---|---|
| Bot runtime | **Node.js 22+**, ESM — no build step, no TypeScript, no bundler |
| HTTP | **Express 5** |
| LINE | **`@line/bot-sdk` 11** |
| Database | **`node:sqlite`** — ships with Node, no native module to compile |
| Config | `dotenv` |
| Tests | **`node:assert` + `node:test`** — no jest, no vitest |
| OCR runtime | **Python 3.12** |
| OCR engine | **`paddleocr` 3.7** + `paddlepaddle` 3.3 (**CPU only — no torch, no CUDA**) |
| OCR HTTP server | **`http.server` from the standard library** — no FastAPI, no Flask |
| Document parsers | **`re` · `json` · `difflib`** — standard library only |
| Images | Pillow |
| Deploy | Docker Compose · `node:22-alpine` + `python:3.12-slim` |

**The bot has exactly three runtime dependencies and zero dev dependencies:**

```json
"@line/bot-sdk"   "express"   "dotenv"
```

Deliberately **not** used — and what replaces each:

| Not used | Used instead |
|---|---|
| LLM / paid API | regex + dictionary — `nlu.js` is 92 lines, `categories.js` is 120 |
| Postgres / MySQL | SQLite embedded in the app process |
| ORM (Prisma, Drizzle) | plain SQL with prepared statements |
| Redis | an in-memory `Map` — `ratelimit.js` is 63 lines |
| TypeScript / bundler | JavaScript with JSDoc |
| jest / vitest | `node:assert` |

Code we actually wrote: **~3,000 lines of JS** (`src/`) and **~1,400 lines of Python**
(`ocr/`), covered by 98 tests.

The trade-off is explicit: every bit of Thai-language intelligence is a hand-written
rule, so new phrasing means a new rule rather than a model that generalises. In
exchange the whole thing answers a webhook in ~3 ms, uses 23 MB of RAM, and needs no
GPU. The only neural network in the system is the 7.8 MB OCR recognition model.

---

## Supported documents

| Type | Fields extracted |
|---|---|
| Bank transfer slip | amount, currency, date, time, reference, from, to, bank |
| Receipt / tax invoice | total, date, currency |
| Payslip (ใบเงินเดือน) | net pay, gross, deductions, tax, social security, employee id, pay period |

Banks detected: **กสิกรไทย (K-Bank/K+)**, **ไทยพาณิชย์ (SCB)**, **กรุงเทพ (BBL)**,
**กรุงไทย (KTB)**, **กรุงศรี (BAY)**, **ทีทีบี (ttb)**, **ออมสิน (GSB)**,
**TrueMoney**, **PromptPay (พร้อมเพย์)**

Adding a bank means adding one regex to `ocr/slip_parser.py` — no retraining.

---

## Project layout

```
src/            LINE bot — webhook, Flex cards, ledger, rule-based NLU
ocr/            PaddleOCR HTTP service + Thai document parsers (pure stdlib)
bench/          Benchmark harnesses and the full measurement write-up
test/           98 tests, no network or GPU required — `npm test`
scripts/        Rich menu builder, weekly digest cron, OCR sync
```

The parsers in `ocr/` are **plain Python stdlib** (`re`, `json`, `difflib`) — you can
lift `slip_parser.py` into any project without installing anything.

---

## Testing

```bash
npm test        # 98 tests: money precision, dedup, PDPA deletion, NLU, rate limit, Flex validity
```

Every Flex message is validated against LINE's real
`/v2/bot/message/validate/reply` endpoint, so layout errors surface before users see them.

---

## Contributing / forking

This is built to be forked. The parts most worth reusing on their own:

- `ocr/slip_parser.py` — Thai transfer-slip parser, stdlib only, has a self-test
- `ocr/payslip_parser.py` — Thai payslip parser with fuzzy label matching
- `bench/eval_dataset.py` — harness for scoring OCR against your own slip folder
- `src/flex.js` — reusable Thai Flex card system for LINE bots

If you add a bank or fix a parser edge case, a PR with a sample (redacted) slip and a
test case is very welcome.

---

## Credits & license

OCR by [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (Apache-2.0).
Benchmarked against [`baidu/Unlimited-OCR`](https://huggingface.co/baidu/Unlimited-OCR),
[SROIE](https://huggingface.co/datasets/Voxel51/scanned_receipts) and
[`openthaigpt/thai-ocr-evaluation`](https://huggingface.co/datasets/openthaigpt/thai-ocr-evaluation).

MIT — see [LICENSE](LICENSE).

<sub>Keywords: thai bank slip ocr · สลิปโอนเงิน · LINE bot · LINE Messaging API ·
PaddleOCR · Thai OCR · receipt OCR · payslip parser · expense tracker · บันทึกรายรับรายจ่าย ·
self-hosted · no GPU · Docker</sub>
