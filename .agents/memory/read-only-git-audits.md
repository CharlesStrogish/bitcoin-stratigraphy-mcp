---
name: Read-only Git audits
description: Avoid index-writing Git operations when checking repository integrity.
---

For an audit that must not modify repository metadata, compare working files against `git show HEAD:<path>` rather than requesting an index refresh.

**Why:** Some apparently read-only Git checks in this workspace triggered an index-lock protection warning, even with optional locks disabled. Reading committed blobs and comparing bytes succeeded without elevated permission.

**How to apply:** Use committed blob reads for protected-file integrity checks. Do not grant broad Git mutation permission merely to finish a read-only audit.
