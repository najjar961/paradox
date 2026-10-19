# Security policy

Paradox is built around one promise: user documents and chats are never stored. Reports that break that promise, or any other security issue, are very welcome.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting (the **Security** tab → **Report a vulnerability**) on this repository instead.

Include what you can of: affected version or commit, steps to reproduce, impact, and a suggested fix. You will get an acknowledgement within 7 days.

## In scope

- Authentication or session bypass, CSRF, XSS, access to another user's workspace
- Any path where uploaded content, embeddings or chat text is written to disk, logged, or survives a session
- Prompt injection from document content that escapes the `<sources>` boundary
- Denial of service that a single authenticated user can trigger despite the built-in limits

## Out of scope

- Data sent to a third-party model provider (OpenAI, Anthropic) when the operator chooses one; this is documented behaviour
- Host-level issues such as swap or memory forensics on a machine you control
- Missing hardening in a reverse proxy you configured yourself

## Supported versions

Only the latest release on `main` receives fixes.
