# Known Issues

Issues & bugs we know about but haven't fixed yet.

- **IP spoofing**: we trust the `X-Forwarded-For` header as-is, which anyone can fake. Since we run behind Cloudflare, we should read `CF-Connecting-IP` instead. (`packages/server/src/lib/util.ts`)
- **Old usernames never free up**: once you switch usernames, the old one just sits in the database forever instead of becoming available again after 30 days like it's supposed to. (`packages/server/src/controllers/user.ts`, `packages/server/src/janitor.ts`)