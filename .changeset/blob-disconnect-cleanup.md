---
'ePDS': patch
---

Blob downloads now release their storage connection when a client disconnects.

**Affects:** Operators

**Operators:** No configuration changes are required. The repository Dockerfiles apply the pinned `@atproto/xrpc-server@0.13.1` patch during installation; keep `patches/` in any custom Docker build context.
