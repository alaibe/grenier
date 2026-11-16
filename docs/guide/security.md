# Security and privacy

These rules hold across Grenier; each is checked by tests.

1. **Local only.** The daemon listens on 127.0.0.1 and refuses requests addressed to any other host. Its MCP and admin
   endpoints need a token; only the proxy path that `grenier run` uses does not.
2. **Keys pass through.** API keys and `Authorization` headers are forwarded to the provider, and never stored, logged
   or sent to the team server.
3. **Nothing leaves by default.** Team sharing is opt-in per repository; vault sync needs a key you create.
4. **No code on the server.** The team server stores answers, summaries and usage numbers. A summary or answer longer
   than 4,000 characters, or quoting more than 10 lines of code, is refused, on your machine and on the server.
5. **End-to-end encrypted vault.** Vault objects are sealed with AES-256-GCM on your devices, with a key that never
   leaves them. The server only stores ciphertext.
6. **Untrusted data stays data.** Content from your sources reaches an AI tool inside a block marked as untrusted, with
   a random marker text cannot close, so instructions hidden in an email are not treated as instructions.
7. **Every read is logged first.** Each read of personal data writes its audit row before the answer leaves; when the
   row cannot be written, the read fails.
8. **Tokens are stored hashed.** Client, member and admin tokens are kept as SHA-256. A revoked token fails at its next
   call.
9. **Requests are not changed** unless you turn on an option (`inject_cache_control`), and every change is logged.
10. **Pinned dependencies.** Exact versions, a committed lockfile, no release younger than 7 days, install scripts
    only where needed, a dependency audit on every push, downloads (the embedding model, the desktop app's Node)
    checked against pinned SHA-256 sums.

Report a vulnerability to the maintainer privately rather than in a public issue.
