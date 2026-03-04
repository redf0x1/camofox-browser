# Reddit Automation Quick Reference

## Workflow Summary

| Action | Platform | Method | Key Command |
|--------|----------|--------|-------------|
| Login | N/A | Session restore | camofox session load |
| Browse Feed | new reddit | Navigate + snapshot | camofox navigate + snapshot |
| Browse Subreddit | old.reddit.com | Navigate + snapshot | camofox navigate |
| Comment | old.reddit.com | eval + click save | camofox eval + click |
| Create Post | www.reddit.com | type + click Post | camofox type + click |
| Reply | old.reddit.com | click reply + eval | camofox click + eval |
| Upvote/Downvote | either | Click arrow ref | camofox click |
| Save Session | N/A | session save | camofox session save |

## Platform Selection

| Action | Platform | Reason |
|--------|----------|--------|
| Login | Manual only | reCAPTCHA Enterprise blocks automation |
| Comment | old.reddit.com | Plain HTML forms, no shadow DOM |
| Reply | old.reddit.com | Same as commenting |
| Create Post | www.reddit.com | No visible CAPTCHA on new Reddit |
| Browse | Either | Both work, old Reddit simpler |
| Vote | Either | Both work |

## Key Patterns

### Comment/Reply on Old Reddit (eval pattern)

    camofox eval "const ta = document.querySelector('.usertext-edit textarea'); ta.value = 'TEXT'; ta.dispatchEvent(new Event('input', {bubbles: true})); ta.dispatchEvent(new Event('change', {bubbles: true}));" [tabId]

### Create Post on New Reddit (type pattern)

    camofox navigate "https://www.reddit.com/r/SUBREDDIT/submit?type=TEXT" [tabId]
    camofox snapshot [tabId]
    camofox type [eN] "Title" [tabId]
    camofox type [eN] "Body" [tabId]
    camofox click [eN] [tabId]

## Known Limitations

- Cannot automate Reddit login (reCAPTCHA Enterprise)
- Cannot create posts on old.reddit.com (reCAPTCHA v2)
- Rate limits: ~1 comment/2 min, ~1 post/10 min for new accounts
- Text posts only (image/video not covered)
- Must use eval for old Reddit text input (not type)
