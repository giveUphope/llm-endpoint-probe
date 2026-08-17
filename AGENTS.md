# Repository Guidelines

## Project Structure & Module Organization

- `src/domain/` defines shared models and capability normalization.
- `src/adapters/` contains protocol-specific requests and response parsers; keep these out of React components.
- `src/services/` owns discovery orchestration and proxy communication.
- `src/components/` contains focused UI components; `src/App.tsx` coordinates workspace state.
- `src/lib/` contains security, profile, and export helpers.
- `server/index.ts` implements the controlled Express proxy, SSRF checks, redirect restrictions, timeouts, and response limits.
- Tests are colocated with subjects as `*.test.ts` or `*.test.tsx`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run Vite and the proxy together with file watching.
- `npm run dev:web` / `npm run dev:server`: run one side independently.
- `npm run typecheck`: validate TypeScript without emitting files.
- `npm test`: execute the Vitest suite once in jsdom.
- `npm run build`: type-check and create `dist/`.
- `npm start`: serve the proxy and an existing production build.

Run `npm test` and `npm run build` before opening a pull request.

## Coding Style & Naming Conventions

Use TypeScript, ES modules, two-space indentation, single quotes, and semicolons. Name components and domain types in `PascalCase`; use `camelCase` for functions and variables. Protocol files use lowercase names such as `adapters/ollama.ts`. Prefer pure helpers and typed adapters over UI conditionals. No formatter or linter is configured, so follow surrounding code and type-check changes.

## Testing Guidelines

Use Vitest, Testing Library, and jest-dom. Describe behavior, for example `it('requires parseable JSON for JSON mode')`. Add parser tests for response shapes, security tests for redaction changes, and component tests for user-visible flows. Never place real API keys in fixtures or snapshots.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style, for example `feat: add Gemini adapter` or `fix: preserve validation evidence`. Keep commits scoped. Pull requests should include a summary, verification results, linked issues when applicable, and screenshots for UI changes. Call out protocol compatibility and unresolved capability uncertainty.

## Security & Configuration

Do not log or commit credentials. Preserve default secret-free exports, the 4 MiB response cap, explicit local-network authorization, and same-origin redirect enforcement. Treat inconclusive validation as `unknown`, never as unsupported or verified.
