---
'ePDS': patch
---

Sign-in pages stay available when automated tools check them.

**Affects:** End users, Operators

**End users:** Sign-in no longer becomes briefly unavailable when an automated client checks an account page without requesting its body.

**Operators:** `HEAD` requests to GET-backed auth pages now initialize CSRF state instead of terminating the auth service; no configuration changes are required.
