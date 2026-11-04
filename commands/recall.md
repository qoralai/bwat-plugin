---
description: Recall bwat from a meeting
argument-hint: [meeting number]
allowed-tools:
  - mcp__plugin_bwat_bwat__bwat_bot_meetings
  - mcp__plugin_bwat_bwat__bwat_bot_recall
---

Which meeting: $ARGUMENTS

Call `bwat_bot_meetings` and find the meetings bwat is still in (not ended). If the user named one (a meeting number or an allocation id), use it. If exactly one is under way and none was named, use that one. Otherwise list them and ask which. Then call `bwat_bot_recall` with its allocation id and confirm bwat is being recalled.
