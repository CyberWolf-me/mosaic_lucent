# ADR 0013: SAML verification with a parser, not a framework

**Status:** Accepted (2026-08)

**Context**

Per-org SSO (M6/F1) needs SAML 2.0 — the enterprise IdPs that matter
(Okta, Azure AD/Entra, Ping) all speak it, and several expose *only*
SAML applications. The browser side of SAML is redirects and a form POST;
the load-bearing part is the server's job: parse the IdP's XML Response,
canonicalize the signed element, verify the RSA signature against the
org's stored certificate, extract NameID and attributes.

Three options existed:

1. A SAML framework (`samlify`, `passport-saml`).
2. A hand-rolled XML parser plus hand-rolled signature verification.
3. An XML parser (`@xmldom/xmldom`) plus hand-rolled canonicalization
   (exclusive XML canonicalization, exc-c14n) and `node:crypto`
   `verify("RSA-SHA256")` for the signature check.

**Decision**

Option 3.

The reasoning is the same reasoning the codebase already applied twice:
the server is framework-free HTTP on principle (ADR 0002), and Stripe's
client is hand-rolled form-encoding plus fetch rather than the Stripe SDK
(`billing/stripe.ts`) — because the surface actually needed is one thin
slice of what the library drags in. Here the slice is:

  parse Response → find the Signature on the **Response element** →
  canonicalize the signed content per exc-c14n → verify RSA-SHA256
  against the org's stored certificate → read NameID + attribute values.

What a framework buys beyond that — service-provider metadata generation,
 dozens of binding idioms, refresh flows, an abstraction for "many
 IdPs" — is surface this product does not need: Lucent is the SP, there
 is exactly one ACS endpoint shape, and the org's IdP metadata arrives
 as operator-pasted values rather than a metadata exchange.

What a framework *costs* is the specific thing that matters here: SAML
libraries accrue their own CVE history (xml-encryption, signature-
wrapping bypasses), and a signature-wrapping bug in a dependency is one
we cannot read, only patch. The signature-wrapping defense in this
implementation is one deliberate line — verify the **Response**
element's signature, and treat the embedded Assertion as data until the
envelope that carries it has verified — which is exactly the class of
decision we want to own, not inherit.

`@xmldom/xmldom` (the maintained successor to xmldom) is added for
parsing only: it produces a DOM, makes no security decisions, and is the
same parsing dependency shape the browser already has natively.
Canonicalization (exc-c14n) is implemented here because no maintained
standalone package exists and the algorithm for the subset SAML uses
(no inclusive prefixes in practice, digest over element + descendants) is
~60 lines.

**Consequences**

- We own the interop risk. If a real IdP's responses trip the verifier,
  the escape hatch is explicit: replace `canonicalize`/`verifySamlSignature`
  with a library call, keeping the route and store contract unchanged —
  that seam is why verification lives in `saml.ts` functions rather than
  inline in the ACS route.
- Replay defense is ours too: `InResponseTo`/`NotOnOrAfter` window checks
  plus a per-Response one-time consume, all testable against the mock IdP.
- No dependency on a SAML framework's release cadence for security fixes;
  the XML parser is the only new supply-chain surface, and it touches
  bytes-to-DOM only, never keys.
- Mock-IdP tests (self-signed RSA in-test, real XML, real signatures) are
  the proof. A green suite against a hand-minted IdP is stronger evidence
  than a green suite against a library's own fixtures.

**Alternatives rejected**

- *samlify / passport-saml*: the framework cost above, plus passport-
  saml's express-era middleware assumptions against a framework-free
  server.
- *Fully hand-rolled parsing*: XML parsing is where hand-rolling buys
  nothing and risks everything (entity expansion, encoding quirks). A
  maintained parser is strictly better there.
