---
name: reddit
description: Reddit automation with CamoFox CLI — login, browse, post, comment, reply with anti-detection. Use when the user needs to automate Reddit interactions, post to subreddits, comment on threads, or browse Reddit programmatically. Triggers include "reddit", "post to reddit", "reddit comment", "reddit automation", or any request to interact with Reddit via browser automation.
allowed-tools: Bash(camofox:*)
---

# Reddit Automation Skill

Automate Reddit using CamoFox CLI anti-detection browser. All workflows verified on 2026-03-04 with zero CAPTCHAs triggered across 50+ operations.

## 1. Prerequisites

- CamoFox browser running: `camofox server status`
- A saved Reddit session (see Section 2)
- Install: `npm install -g camofox-browser`

## 2. Authentication

Reddit login uses reCAPTCHA Enterprise — automated credential entry is blocked. Use session-based auth:

First time — login manually in CamoFox, then save:

    camofox session save "reddit-session" --user reddit

Subsequent times — restore saved session:

    camofox open https://www.reddit.com --user reddit
    camofox session load "reddit-session" --user reddit
    camofox navigate https://www.reddit.com [tabId]
    camofox snapshot [tabId]

Verify: username visible in snapshot confirms login.

Store credentials for reference:

    camofox auth save reddit-main --url https://www.reddit.com --notes "Reddit account"

## 3. Browse Feed

    camofox open https://www.reddit.com --user reddit
    camofox session load "reddit-session" --user reddit
    camofox navigate https://www.reddit.com [tabId]
    camofox snapshot [tabId]
    camofox scroll down [tabId] --amount 500
    camofox snapshot [tabId]
    camofox get-links [tabId]

## 4. Browse Subreddit

    camofox navigate https://old.reddit.com/r/test [tabId]
    camofox snapshot [tabId]
    camofox click [eN] [tabId]
    camofox snapshot [tabId]

Old Reddit has simpler HTML structure — easier to parse post listings.

## 5. Comment on Post (Old Reddit)

IMPORTANT: Use eval to fill textarea — standard type causes 500 errors on old Reddit.

    camofox navigate https://old.reddit.com/r/test/comments/POST_ID/ [tabId]
    camofox snapshot [tabId]
    camofox eval "const ta = document.querySelector('.usertext-edit textarea'); ta.value = 'Your comment'; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new Event('change', {bubbles: true}));" [tabId]
    camofox snapshot [tabId]
    camofox click [eN] [tabId]
    camofox snapshot [tabId]

Why eval? Reddit's old textarea causes Internal Server Error when filled via browser automation type. Setting textarea.value via JavaScript works reliably.

## 6. Create Post (New Reddit)

IMPORTANT: Use www.reddit.com — old Reddit has visible reCAPTCHA that blocks posting.

    camofox navigate "https://www.reddit.com/r/test/submit?type=TEXT" [tabId]
    camofox snapshot [tabId]
    camofox type [eN] "Your Post Title" [tabId]
    camofox snapshot [tabId]
    camofox type [eN] "Post content with markdown." [tabId]
    camofox snapshot [tabId]
    camofox click [eN] [tabId]
    camofox wait navigation [tabId] --timeout 5000
    camofox snapshot [tabId]

## 7. Reply to Comment (Old Reddit)

    camofox navigate https://old.reddit.com/r/test/comments/POST_ID/ [tabId]
    camofox snapshot [tabId]
    camofox click [eN] [tabId]
    camofox snapshot [tabId]
    camofox eval "const tas = document.querySelectorAll('.usertext-edit textarea'); const rb = Array.from(tas).find(t => t.offsetParent !== null && t.value === ''); if (rb) { rb.value = 'Your reply'; rb.dispatchEvent(new Event('input', {bubbles: true})); rb.dispatchEvent(new Event('change', {bubbles: true})); }" [tabId]
    camofox snapshot [tabId]
    camofox click [eN] [tabId]
    camofox snapshot [tabId]

## 8. Upvote / Downvote

    camofox snapshot [tabId]
    camofox click [eN] [tabId]

Vote buttons appear as arrow icon refs in the snapshot.

## 9. Session Management

    camofox session save "reddit-session" --user reddit
    camofox session load "reddit-session" --user reddit
    camofox session list
    camofox session delete "reddit-session"

## 10. Rate Limiting

- Wait 2+ minutes between comments/replies
- Wait 10+ minutes between posts for new/low-karma accounts
- Add delays: `camofox wait networkidle [tabId] --timeout 3000`
- Higher karma accounts have relaxed limits

## 11. Anti-Detection

- CamoFox anti-detection fully effective on Reddit (0 CAPTCHAs in 50+ operations)
- Reddit serves ads to CamoFox = treats as real user
- Use consistent userId ("reddit") across sessions
- Do NOT clear cookies between actions
- No special proxy or fingerprint settings needed

## 12. Platform Selection

| Action | Platform | Reason |
|--------|----------|--------|
| Login | Manual only | reCAPTCHA Enterprise |
| Comment | old.reddit.com | Plain HTML forms |
| Reply | old.reddit.com | Plain HTML forms |
| Create Post | www.reddit.com | No visible CAPTCHA |
| Browse | Either | Both work |
| Vote | Either | Both work |

## 13. Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Login CAPTCHA | reCAPTCHA Enterprise | Use saved sessions |
| Post CAPTCHA on old Reddit | reCAPTCHA v2 | Use new Reddit |
| Comment 500 error | type on old Reddit | Use eval with textarea.value |
| Text doubled | Lexical editor bug | Use eval for input |
| Rate limited | Rapid actions | Wait 2+ minutes |
| SPA link fails | Reddit SPA | Use camofox navigate |
| Session expired | Cookies expired | Re-login and save |

## 14. Complete Example

    #!/bin/bash
    USER="reddit"
    SESSION="reddit-session"

    TAB=$(camofox open https://www.reddit.com --user $USER --format json | jq -r '.tabId')
    camofox session load $SESSION --user $USER

    camofox navigate https://old.reddit.com/r/test $TAB
    camofox snapshot $TAB

    camofox eval "const ta = document.querySelector('.usertext-edit textarea'); ta.value = 'Automated via CamoFox CLI'; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new Event('change', {bubbles: true}));" $TAB

    camofox session save $SESSION --user $USER
    camofox close --user $USER
