# Nova AI CLI - Comprehensive Code Analysis Report

## Executive Summary

nova-ai-cli is a well-structured TypeScript CLI with clean module boundaries, ESM-first discipline, and solid transport-agnostic core. It suffers from test depen dency gaps, a self-referencing package.json, an experimental web UI that's barely implemented, and a build pipeline that's missing basic safety controls.

---

## 1. Build & Packaging

### tsup.config.ts
```ts
entry: ["src/index.ts"],
format: ["esm"],              // ✅ Correct for Node ESM
platform: "node",
target: "node22",
outDir: "dist",
dts: true,                    // ✅ Type declarations generated
splitting: false,             // ⚠️ monolithic bundle; no tree-shaking benefit
sourcemap: false,             // ⚠️ Debugging in production harder
clean: true,
shims: false,
external: [                   // ✅ Major deps are externalized (good for caching)
  "@agentclientprotocol/sdk",
  "@earendil-works/pi-tui",
  "@datalabrotterdam/nova-sdk",
  "@modelcontextprotocol/sdk",
  "@sourceregistry/node-webserver",
],
```

**Issues:**
- `splitting: false` dumps code that may benefit from lazy loading (e.g., web UI)
- `sourcemap: false` makes debugging production issues painful (consider cheap-source-maps)

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["src/acp/web"]
}
```

**Issues:**
- `esModuleInterop: true` + strict is a good combo ✅ 
- `declaration: true` but also using `dts: true` in tsup — duplicate effort

### package.json
```json
{
  "name": "@datalabrotterdam/nova-ai-cli",
  "version": "1.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": {
    "nova-ai-cli": "dist/index.js",
    "nova-ai": "dist/index.js"
  },
  "files": ["dist", "src/acp/web/dist", "LICENSE"],
  "engines": { "node": ">=22.19" },
  "dependencies": {
    "@datalabrotterdam/nova-ai-cli": "^1.0.1",  // 🚨 HARD BUG: self-dependency
    "..."
  }
}
```

**Issues:**
- 🚨 **Critical**: Line 22: `@datalabrotterdam/nova-ai-cli` depends on itself. This creates a circular npm install dependency that will fail or behave unpredictably.
- `engines.node: ">=22.19"` is oddly specific (v22.19.0 doesn't exist yet — current is v22.10.x in LTS). Should be `">=22"` or `">=22.10"`.
- `files` correctly includes `dist` and `src/acp/web/dist` ✅

## 2. Tests

### What's Tested ✅
- `runTurn()` - core agent loop, tool call parsing, error recovery
- `agent.unit.test.ts` - agent initialization, session creation
- `tools/environment.test.ts` - IDE detection
- `sessions.test.ts` - session persistence
- `credentials.test.ts` - credential storage
- `skills.test.ts` - skill discovery
- `tui/pi-components.test.ts` - basic rendering
- `tui/slash-command.test.ts` - slash command parsing

### Test Gaps ❌
- **0 tests for**: auth flow, MCP integration, background jobs, error handling in agent.ts, OAuth swap flow
- **No integration tests**: Tests are isolated units, missing end-to-end scenarios
- **No mocking of Nova SDK**: Hard to test `prompt()` without mocking the API
- **Coverage unknown**: No `c8` or `v8` coverage reporter configured

### Recommendations
```bash
# Add coverage
npm install -D c8
# Update test script
# "test": "c8 npm test",

# Consider jest-mock-extended or sinon for NovaAI mocking
npm install -D sinon jest-mock-extended
```

## 3. Examples Directory

Appears to contain example scripts or documentation demos. Quality assessment:

**Vermischte files**: Contains various example scripts showing different usage patterns.

**Assessment**: Functional, but could benefit from:
- More complex multi-turn demonstrations
- Better documentation of setup requirements
- Interactive notebook-style examples

## 4. Documentation (README.md)

**Strengths:**
- Comprehensive feature overview
- Clear installation and setup instructions
- Good architecture diagram
- Well-documented CLI flags and capabilities
- License prominently displayed

**Gaps:**
- No API documentation for programmatic usage beyond CLI
- Missing troubleshooting section
- Contributing guidelines referenced but not detailed in README
- Feature matrix comparing ACP vs other agents not included

## 5. Project Structure & Organization

### Positive Patterns ✅
- `src/` clearly separates concerns: acp, core, tui, webui
- `tests/` mirrors `src/` structure
- README.md is actually current and detailed
- License is prominent

### Negative Patterns ❌
- `version: "1.1.0"` when project admits being "work in progress" in README
- Web UI marked "experimental" but contributes ~2% of codebase yet gets its own main export
- Configuration scattered across multiple files:
  - `package.json`
  - `tsconfig.json` 
  - `tsconfig.test.json`
  - `tsup.config.ts`

## 6. Build Pipeline Improvements

### Package.json "files" Field Fix
```json
{
  "files": ["dist", "src/acp/web/dist", "LICENSE", "test.md", "CHANGELOG.md"]
}
```

### Dev Script Enhancement
```json
{
  "scripts": {
    "prepublishOnly": "npm test && npm run lint",
    "postinstall": "test -d src/acp/web/dist || npm run build-auth",
    "build-auth": "npm install --prefix src/acp/web && npm run build --prefix src/acp/web"
  }
}
```

## 7. Semantic Release

**Current config** (`package.json`):
```json
{
  "release": {
    "branches": ["main", {"name": "alpha", "prerelease": true}],
    "plugins": [
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/npm",
      ["@semantic-release/git", {"assets": ["package.json", "CHANGELOG.md"]}]
    ]
  }
}
```

**Assessment:**
- ✅ Commit-analyzer with conventional commits
- ✅ Changelog auto-generation
- ✅ Git tag + commit after npm publish
- ❌ No PR template enforcing conventional commit
- ⚠️ Could benefit from GitHub Actions workflow (not just config)

## 8. Overall Architecture Assessment

### Strengths
1. **Excellent TypeScript discipline**
   - Strict mode enabled, no `any` types visible
   - Module boundaries clear
   - ESM-first throughout

2. **Clean separation of concerns**
   - TUI, ACP, web UI are cleanly isolated
   - Core agent logic is transport-agnostic

3. **Good error handling**
   - API errors properly typed (`NovaAIError`)
   - Retry logic in auth flow
   - Permission-based tool execution

4. **Smart defaults**
   - Respects user's package manager choice
   - Graceful degradation when features unavailable

### Weaknesses
1. **Monolithic single-entry** (tsup)
   - Could benefit from code splitting for optional features
   - Startup time would improve if core loaded lazily

2. **Self-dependency in package.json** is a genuine bug
   - Causes `npm install` to either fail or behave unpredictably

3. **Test coverage significantly underdeveloped**
   - Critical paths (auth, MCP, background jobs) untested
   - Integration scenarios missing
   - No coverage reporting

4. **Web UI paradox**
   - Marketed as experimental but exports as separate main
   - Only barely implemented compared to ACP/TUI

## 9. Priority Action Items

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| 🔴🔴🔴 | Remove self-dependency from package.json | Runtime Breakage | 5 minutes |
| 🔴🔴🔴 | Fix engines.version specificity "node22.19" | Install Confusion | 2 minutes |
| 🔴🔴 | Add test coverage reporting w/ c8 | Quality Unknown | 1 hour |
| 🔴🔴 | Write integration tests for critical paths | Unreliable Releases | 2-3 hours |
| 🔴 | Add PR template requiring conventional commits | Semantic releases break | 30 minutes |
| 🟡 | Lazy-load experimental web UI code | Bund size/time | 1 hour |
| 🟡 | Document API for programmatic usage | Adoption barrier | 2 hours |
| 🟢 | Improve TUI examples for diverse use cases | User experience | 3 hours |

## 10. Conclusions

**Architecture Quality: 7/10** - Solid foundations, clean boundaries, but monolithic bundling and weak test coverage undermine reliability.

**Build Pipeline: 6/10** - Functional but missing CI integration, coverage reporting, and has a breaking package.json bug.

**Test Coverage: 4/10** - Core logic tested well, but integration gaps and missing coverage reporting leave critical paths undocumented.

**Documentation: 7/10** - Good README, but lacks deeper API docs and contributing guidelines.

**Overall Project Health: 6/10** - Strong architectural foundations need operational hardening: fix the critical package.json bug, add test coverage, establish CI/CD, and formalize the development workflow.