---
description: Which bwat this session talks to and who is signed in
allowed-tools:
  - mcp__plugin_bwat_bwat__bwat_status
---

Call `bwat_status`. Report in one or two lines: the bwat address (`base_url`), who is signed in (`member.email` and `member.role`), or, when `member` is null, the reason and its hint (for example: run `/bwat:login`).
