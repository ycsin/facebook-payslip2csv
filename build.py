#!/usr/bin/env python3
"""Inline parser.js into page.template.html and write index.html (served by GitHub Pages)."""
from pathlib import Path

root = Path(__file__).parent
template = (root / "page.template.html").read_text()
parser = (root / "parser.js").read_text()
assert "/*__PARSER__*/" in template
(root / "index.html").write_text(template.replace("/*__PARSER__*/", parser))
print("wrote index.html")
