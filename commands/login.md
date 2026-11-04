---
description: Sign in to bwat, with Google or with the install's code
allowed-tools:
  - mcp__plugin_bwat_bwat__bwat_login
  - mcp__plugin_bwat_bwat__bwat_status
---

Call `bwat_login`. It opens the sign-in in the browser and answers at once: Google's, or, on a bwat with no Google, a page on this computer where the user types the code its setup showed and their email. Never ask for the code in chat.

- If `browser_opened` is false, show the user `sign_in_url` to open themselves.
- Tell the user to finish signing in in the browser, then run `/bwat:status` to check.
- On an error, show its hint as it is.
