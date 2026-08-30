# 1. Behavior and Execution (Think Before Coding)
- **Don't assume:** If there are multiple interpretations of a problem, present them. Do not choose silently. If something is unclear, stop and ask.
- **Simplicity first:** Write the absolute minimum code necessary. Zero speculative features. Zero abstractions for single-use code. If you write 200 lines and it could be done in 50, rewrite it.
- **Surgical changes:** Touch ONLY what you are asked to. Do not "improve" adjacent code, formatting, or refactor things that aren't broken. Clean up only the mess your own changes create.
- **Goal-driven execution:** Before modifying files, outline a brief sequential plan.

# 2. Environment and Tech Stack (Strict)
- **Package Manager:** EXCLUSIVELY use `bun`. NEVER run `npm`, `yarn`, or `pnpm`.
- **Framework:** Astro and TailwindCSS. Client-side interactivity is handled with Vanilla JS. Do not introduce React, Vue, or Svelte.
- **Database:** Turso (SQLite local/remote).
- **Structure:** This is a standard Astro project, NOT a monorepo. Do not look for `packages/` folders or assume complex architectures.

# 3. Development Commands
- Start local server: `bun run dev`
- Build for production: `bun run build`
- Install new dependencies: `bun add <package>`

# 4. Commenting Rules
- Write comments (`//`) exclusively to explain *why* a complex technical decision was made, never *what* or *how*. If the variable or function name already explains it, omit the comment.