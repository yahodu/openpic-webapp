## 🎫 Jira Ticket

<!-- Required: Link to the Jira issue. This enables automation and tracking. -->

**Issue:** [OP-000](https://yahodu.atlassian.net/browse/OP-000)

## 📝 Implementation Summary

<!-- Critical for Confluence Sync: Summarize the technical approach here.
     This text will be extracted for documentation later. -->

- **What:** Briefly describe the change.
- **Why:** Why is this change necessary?
- **How:** Key technical decisions, libraries used, or architectural changes.

## 🔄 Type of Change

<!-- Select all that apply -->

- [ ] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] 🧹 Refactor (code improvement without changing behavior)
- [ ] 📄 Documentation update
- [ ] 🛠️ Other Changes (like development tool-related, linting-related, and so on)

## ✅ PR Hygiene Checklist

<!-- PR-hygiene items only — these are NOT the Definition of Done. The
     authoritative, normative DoD is docs/CONVENTIONS.md §9, mirrored below
     under "Definition of Done". -->

- [ ] **Code Style:** Code follows team style guidelines (linting passed).
- [ ] **Unit Tests:** New/updated unit tests added, with coverage at or above
      the configured threshold — see docs/CONVENTIONS.md §9.
- [ ] **Integration Tests:** API/DB integration tests updated if applicable.
- [ ] **Manual Testing:** Feature tested locally in a clean environment.
- [ ] **Documentation:** (PR hygiene — update only when relevant to the change)
  - [ ] Code comments added for complex logic.
  - [ ] README updated (if neccessary - like environment variable details updated).
  - [ ] API Swagger/Docs updated (if endpoints changed).
- [ ] **Security:**
  - [ ] No secrets/keys committed.
  - [ ] Input validation checked.
- [ ] **Performance:** No obvious N+1 queries or memory leaks introduced.

## ✅ Definition of Done

<!-- Copy-pasteable DoD — the gate between "implemented" and "done".
     See docs/CONVENTIONS.md §9. Every box must be checked before review. -->

- [ ] Tests were written first and are green (RED + GREEN output included above).
- [ ] Coverage is at or above the configured threshold.
- [ ] Typecheck, lint and dependency audit are clean.
- [ ] TSDoc is present on every exported symbol and route handler.
- [ ] Structured logs added via the `Logger` port (required fields only).
- [ ] Zod schemas and `buildX` fixtures added/updated and `schema.parse` clean.
- [ ] The relevant API contract section is referenced.
- [ ] No hard-coded tunables — runtime knobs read from `platformSettings`.
- [ ] An ADR was added in `docs/adr/` for any new decision.

## Screenshots (if any)

## 🚀 Deployment Notes

<!-- Any special instructions for DevOps or Reviewers during merge/deploy -->

- [ ] Database migrations required? (Yes/No)
- [ ] Environment variables changed? (Yes/No)
- [ ] Feature flags enabled? (Yes/No)

## 🔐 Environment Variables

<!--
  If you added, removed, or changed any env variables:
  1. Update .env.example
  2. Fill in the table below (do not leave it empty if .env.example changed)
  3. Notify DevOps if variables are needed in staging/production
-->

No env changes

| Status | Variable Name | Required? | Description / Where to get it |
| ------ | ------------- | --------- | ----------------------------- |
| -      | -             | -         | No env changes                |

# IMPORTANT

- [ ] Did you complete the necessary changes for deployment (like changing environment variables in production environment)?
