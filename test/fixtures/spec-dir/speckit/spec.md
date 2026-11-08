# Feature Specification: Session authentication

**Feature Branch**: `002-session-auth`
**Created**: 2026-11-01
**Status**: Draft
**Input**: User description: "Users sign in once and stay signed in until the session expires or they sign out."

## User Scenarios & Testing

### Primary User Story
A registered user opens the app, is sent to the login page, enters a user name and password, and is returned to the page they asked for. For the next thirty minutes every request is accepted without signing in again. If they keep using the app, the session is extended; if they leave it alone for thirty minutes, the next request asks them to sign in again. They can sign out from any page.

### Acceptance Scenarios
1. **Given** a registered user on the login page, **When** they submit the right password, **Then** they are redirected to the page they originally asked for and a session cookie is set.
2. **Given** a signed-in user, **When** they request a protected page within the session lifetime, **Then** the page is served without a login prompt.
3. **Given** a signed-in user whose session is within five minutes of expiry, **When** they request any protected page, **Then** the session lifetime is extended by thirty minutes from that request.
4. **Given** a session that has expired, **When** the user requests a protected page, **Then** they are sent to the login page and the old cookie is ignored.
5. **Given** a signed-in user, **When** they sign out, **Then** the session is removed and a later request with the old cookie is treated as not signed in.

### Edge Cases
- A request arrives exactly at the expiry instant: it is treated as expired.
- A cookie whose signature does not verify is treated as missing; the user sees no error about forgery.
- Two browser tabs sign out at once: the second logout is answered as "not signed in", not as an error.

## Requirements

### Functional Requirements
- **FR-001**: The system MUST keep sessions server-side and MUST NOT store user data in the cookie.
- **FR-002**: The system MUST expire a session thirty minutes after it was created or last extended.
- **FR-003**: The system MUST extend a session that is used within five minutes of its expiry.
- **FR-004**: The system MUST reject requests to protected routes that carry no valid session with status 401.
- **FR-005**: The system MUST provide a login page, a login endpoint and a logout endpoint.
- **FR-006**: The login endpoint MUST answer invalid credentials without revealing whether the user exists.

### Key Entities
- **Session**: an id, the user it belongs to, when it was created and when it expires.
- **User**: an existing entity from the skeleton (`users.json`); not changed by this feature.

## Review & Acceptance Checklist
- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] All mandatory sections completed
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
