#!/usr/bin/env python3
"""
Patch landscape-go/vendor/modules.txt to add missing ## explicit markers.

The pinned landscape-go submodule has vendor/modules.txt out of sync with
go.mod: direct dependencies lack the ## explicit markers required by Go 1.17+
under -mod=vendor. This causes `go build` to fail with:

  '<pkg>: is explicitly required in go.mod, but not marked as explicit
   in vendor/modules.txt'

This script adds the missing markers without internet access. The real fix is
running `go mod vendor` in landscape-go.
"""

import re
import sys

go_mod_path = ".landscape-packaging/landscape-go/go.mod"
modules_txt_path = ".landscape-packaging/landscape-go/vendor/modules.txt"

with open(go_mod_path) as f:
    content = f.read()

direct_deps = set()
for block in re.findall(r"require\s*\((.*?)\)", content, re.DOTALL):
    for line in block.splitlines():
        line = line.strip()
        if line and not line.startswith("//") and "// indirect" not in line:
            parts = line.split()
            if parts:
                direct_deps.add(parts[0])
for m in re.finditer(r"^require\s+(\S+)\s+\S+\s*$", content, re.MULTILINE):
    direct_deps.add(m.group(1))

print(f"Found {len(direct_deps)} direct deps in go.mod")

with open(modules_txt_path) as f:
    lines = f.readlines()

output = []
fixed = 0
for i, line in enumerate(lines):
    output.append(line)
    if line.startswith("# ") and not line.startswith("## "):
        parts = line.split()
        if len(parts) >= 2:
            pkg = parts[1]
            next_line = lines[i + 1] if i + 1 < len(lines) else ""
            if pkg in direct_deps and not next_line.startswith("## explicit"):
                output.append("## explicit\n")
                fixed += 1

with open(modules_txt_path, "w") as f:
    f.writelines(output)

print(f"Added ## explicit markers for {fixed} packages in vendor/modules.txt")
