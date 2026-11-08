# Tasks: Session authentication

**Input**: Design documents from `/specs/002-session-auth/`
**Prerequisites**: plan.md (required), data-model.md, contracts/

## Phase 3.1: Setup
- [x] T001 Create src/auth/ and test/auth/ with the session types from data-model.md

## Phase 3.2: Core
- [ ] T002 Implement the in-memory session store in src/auth/store.ts
- [ ] T003 [P] Login and logout endpoints per contracts/one.md in src/auth/routes.ts
- [ ] T004 [P] Auth middleware in src/auth/middleware.ts
