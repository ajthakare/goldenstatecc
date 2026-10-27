"""
Extract the NCCA rule documents to text for the admin Rules Assistant.

Reads every PDF in public/documents/ncca/ and writes src/data/ncca-rules.json,
which netlify/functions/rules-ask.ts sends to Claude with each question.
Re-run it whenever a PDF in that folder is added, replaced or removed
(tests/unit/ncca-rules.test.ts fails until you do).

One-time setup (any Python 3.9+):
    python3 -m venv .venv-docs && .venv-docs/bin/pip install pypdf fonttools
Run from the repo root:
    .venv-docs/bin/python docs/scripts/extract-ncca-rules.py
"""
import json
import re
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "public" / "documents" / "ncca"
OUT = ROOT / "src" / "data" / "ncca-rules.json"

# Clause numbers ("4.2.4.4.", "32.2 Bowled") and bullets start a new line;
# everything else is collapsed, since Word-exported PDFs put one word per line.
CLAUSE = re.compile(r"\s+(?=(?:\d+(?:\.\d+)+\.?|●)\s)")

# Running headers/footers repeated on every page; left in, they end up inside
# quoted clauses ("ICC MEN'S TWENTY20 ... CONDITIONS 22 13.8.2 Where ...")
RUNNING = re.compile(
    r"ICC MEN'S TWENTY20 INTERNATIONAL PLAYING CONDITIONS \d+"
    r"|Page \| \d+"
    r"|^NCCA Winter T20 Standing Rules \(\d+/\d+/\d+\)"
)


def page_text(raw: str) -> str:
    text = RUNNING.sub(" ", " ".join(raw.split()))
    return CLAUSE.sub("\n", " ".join(text.split()))


def main() -> None:
    documents = []
    for pdf in sorted(SRC.glob("*.pdf")):
        reader = PdfReader(pdf)
        # "[Page N]" markers let the function turn a citation into a PDF page link
        pages = [f"[Page {i}]\n{page_text(p.extract_text() or '')}" for i, p in enumerate(reader.pages, 1)]
        documents.append({"file": pdf.name, "text": "\n\n".join(pages)})
        print(f"{pdf.name}: {len(reader.pages)} pages")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"documents": documents}, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
