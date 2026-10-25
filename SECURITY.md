# Security policy

Saegim is an experimental local development tool. The development server binds to `127.0.0.1`; the API has no user authentication or tenant isolation. It is not configured as a public upload service.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/mooyeon-choi/saegim/security/advisories/new). Include the affected revision, a minimal reproduction, the observed impact and relevant logs. Use synthetic media and redact credentials and personal paths. Avoid putting private input files in a public issue.

The current development branch is the supported target for fixes. No response-time commitment or older-version support policy is established yet.

## Data handling

The default analysis pipeline runs locally without an external model API key. Uploaded media and analysis caches are stored under `.data/` unless `MOTION_DATA_DIR` is set. These files may remain available for project comparison until you remove them. A coding agent used alongside the repository has its own data-handling policy.

Keep local input, output and credentials out of commits. The source-package pattern scan catches selected common mistakes; it is not a comprehensive security audit.
