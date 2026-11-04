---
description: Send bwat to a Zoom meeting by its link
argument-hint: <Zoom meeting link>
allowed-tools:
  - mcp__plugin_bwat_bwat__bwat_bot_join
---

The user's Zoom meeting link: $ARGUMENTS

If no link was given, ask for it; never build or guess one. Otherwise call `bwat_bot_join` with `zoom_url` set to that link exactly. Report the meeting number and `claim_state` (pending means bwat is on its way; already_claimed means it was already sent). On an error, show its hint.
