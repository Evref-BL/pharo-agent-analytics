"""What captured content says, when content capture was on.

Only words leave this module: the classes and the messages of the Smalltalk
an agent asked `evaluate` to run, never the code. Which classes and messages
agents reach for through `evaluate` is what a tool could do for them instead.
"""

from __future__ import annotations

import json
import re

#: Literals and comments first, so that nothing inside one reads as code.
_SKIP = re.compile(
    r'"[^"]*"'                      # a comment
    r"|'(?:[^']|'')*'"              # a string
    r"|\$."                         # a character
    r"|#'(?:[^']|'')*'"             # a quoted symbol
    r"|#[A-Za-z_][A-Za-z0-9_:]*"    # a symbol
    r"|#[-+*/\\<>=~@%|&?,]+"        # a binary symbol
    r"|-?\d+(?:r[0-9A-Z]+)?(?:\.\d+)?(?:e-?\d+)?"  # a number
, re.S)
_TOKEN = re.compile(
    r"(?P<keyword>[A-Za-z_][A-Za-z0-9_]*:(?!=))"
    r"|(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<assign>:=|_(?![A-Za-z0-9]))"
    r"|(?P<blockarg>:[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<open>[(\[{])"
    r"|(?P<close>[)\]}])"
    r"|(?P<end>[.;!^])"
    r"|(?P<bar>\|)"
    r"|(?P<binary>[-+*/\\<>=~@%&?,]+)"
    r"|(?P<literal>\x00)"
)
PSEUDO = {"self", "super", "thisContext", "true", "false", "nil"}


def code_of(arguments: str | None) -> str | None:
    """The code of an evaluate call's captured arguments: its `code`, else
    every string it was given."""
    if not arguments:
        return None
    try:
        value = json.loads(arguments)
    except (ValueError, TypeError):
        return arguments if isinstance(arguments, str) else None
    if isinstance(value, dict):
        if isinstance(value.get("code"), str):
            return value["code"]
        return "\n".join(v for v in value.values() if isinstance(v, str)) or None
    return value if isinstance(value, str) else None


def words(code: str) -> tuple[set[str], set[str]]:
    """The classes (globals) a piece of Smalltalk names and the messages it
    sends: keyword messages whole (`at:put:`), unary ones by name; binary
    operators are left out."""
    # A comment is nothing; any other literal is an operand.
    text = _SKIP.sub(lambda m: " " if m.group().startswith('"') else "\x00", code)
    classes: set[str] = set()
    messages: set[str] = set()
    operand = False           # the last token ends an expression a message can follow
    pending: dict[int, list[str]] = {}   # keyword message being read, per nesting depth
    depth = 0
    declaring = False         # inside | temporaries |
    block_args = False        # after [:a :b, before their |

    def close_keyword(at: int) -> None:
        parts = pending.pop(at, None)
        if parts:
            messages.add("".join(parts))

    for match in _TOKEN.finditer(text):
        kind, token = match.lastgroup, match.group()
        if declaring:
            if kind == "bar":
                declaring = False
            continue
        if kind == "keyword":
            if operand:
                pending.setdefault(depth, []).append(token)
            operand = False
        elif kind == "name":
            if operand and token not in PSEUDO:
                messages.add(token)          # a unary message
            elif token[0].isupper():
                classes.add(token)
            operand = True
        elif kind == "assign":
            operand = False
        elif kind == "blockarg":
            block_args = True
            operand = False
        elif kind == "open":
            depth += 1
            operand = False
        elif kind == "close":
            close_keyword(depth)
            depth = max(0, depth - 1)
            operand = True
        elif kind == "end":
            close_keyword(depth)
            operand = token == ";"           # a cascade sends its next message to the same receiver
        elif kind == "bar":
            if block_args:
                block_args = False           # the end of a block's arguments
            elif operand:
                operand = False              # binary |
            else:
                declaring = True
        elif kind == "binary":
            operand = False
        elif kind == "literal":
            operand = True
    for at in list(pending):
        close_keyword(at)
    return classes, messages
