## What and why

<!-- One paragraph. Link the milestone (M0-M7) or the issue. -->

## Decision record

<!-- If this changes an architectural choice, link or add a docs/adr/ entry. -->

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run lint`
- [ ] Tested by hand (say how, and against which store: in-memory or Postgres)

## Risk

- Blast radius:
- Migration included: <!-- file, and whether it is backwards compatible with the running version -->
- Feature flag / config gate:
- Rollback: <!-- how to undo this without a code change, or why that is impossible -->

## Security and privacy

- [ ] No new unauthenticated route, or the exposure is stated above
- [ ] No secret, token or board content added to logs, telemetry or an error body
- [ ] New state-changing routes go through the CSRF and tenancy guards
