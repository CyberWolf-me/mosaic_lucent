import { createHash, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * The DOM types, derived from what @xmldom/xmldom actually exports. Its
 * d.ts declares Node/Document/Element ambient *inside* its module block
 * without re-exporting them by name, so the honest derivation is from the
 * two classes this module uses: the parse result, and its root Element
 * (which carries getAttribute and childNodes for every node the SAML code
 * walks — text children included). If xmldom ever exports the interfaces
 * directly, these aliases are the whole migration.
 */
type DomDocument = ReturnType<InstanceType<typeof DOMParser>["parseFromString"]>;
type DomElement = NonNullable<DomDocument["documentElement"]>;
// DOM Level 1 node-type constants — the only two the text reader checks.
const TEXT_NODE = 3;
const CDATA_NODE = 4;

/**
 * SAML 2.0 Response verification (F1 / ADR 0013).
 *
 * The one job: given a base64-encoded SAMLResponse and the org's stored
 * IdP certificate, either return the authenticated identity or say why not.
 * No framework (see ADR 0013 for the reasoning); a maintained XML parser
 * for bytes→DOM, our own canonicalization for the signed digest, node:crypto
 * for the RSA check.
 *
 * THE SIGNATURE-WRAPPING DEFENSE is the load-bearing line and the reason
 * this module exists rather than a library: we verify the **Response**
 * element's signature over the Response's own content, and the embedded
 * Assertion is treated as data until that envelope has verified. The
 * classic SAML wrap is to sign an innocent Assertion while the attacker's
 * parameters live in a second, unsigned Assertion the SP reads — which
 * only works on verifiers that check the Assertion's own signature. Ours
 * cannot be talked into that: the code path never looks for an Assertion
 * signature at all.
 *
 * Replay defense is the second half: NotOnOrAfter/NotBefore window and an
 * InResponseTo that must match the id we minted on the SP-initiated leg
 * (null only for IdP-initiated flows, which the ACS allows only when the
 * org's connection has no outstanding AuthnRequest — the strictness the
 * tests pin).
 */

export const NAMEID_EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
/** SAML clock skew tolerance; 90s covers every real IdP's clock drift. */
export const SKEW_MS = 90_000;

/** What the ACS needs from a verified Response. */
export interface SamlIdentity {
  /** The NameID — the email, for the email format we require. */
  nameId: string;
  /** Attribute values by friendly name, when the IdP sends any. */
  attributes: Record<string, string>;
  /** The IdP's entity id, for binding back to the stored connection. */
  issuer: string;
}

export type SamlVerification =
  | { ok: true; identity: SamlIdentity; inResponseTo: string | null }
  | { ok: false; status: 400 | 401; error: string };

/** Parse, canonicalize, verify. The single entry point the ACS route calls. */
export function verifySamlResponse(
  encodedResponse: string,
  certPem: string,
  now: number = Date.now(),
): SamlVerification {
  let xml: string;
  try {
    // IdPs POST the Response base64-encoded; some dev tooling sends raw XML,
    // and accepting both costs nothing but a decode attempt.
    xml = Buffer.from(encodedResponse, "base64").toString("utf8");
    if (!xml.includes("samlp:Response") && !xml.includes("<Response")) {
      return { ok: false, status: 400, error: "not a SAML Response" };
    }
  } catch {
    return { ok: false, status: 400, error: "SAMLResponse is not valid base64" };
  }

  let doc: DomDocument;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml");
  } catch {
    return { ok: false, status: 400, error: "SAMLResponse is not valid XML" };
  }

  const root = doc.documentElement;
  if (!root) return { ok: false, status: 400, error: "empty XML document" };
  // The Response IS the document element; the parser never hands us a
  // wrapper. Accept it directly, and fall back to a child scan only for the
  // XML-declaration-plus-junk shapes some IdPs emit.
  const response = isNamed(root, "Response", "samlp:Response")
    ? root
    : firstChildNamed(root, "Response", "samlp:Response");
  if (!response) return { ok: false, status: 400, error: "no Response element" };

  // Status must be Success before anything else is read — a failed IdP auth
  // is a normal outcome, and reading identity out of an error Response is
  // how responder confusion bugs are born. The URN ends in a capital
  // "Success" per the SAML core spec; compared case-insensitively anyway
  // because some IdPs are sloppy and an outcome check is not the place to
  // be strict about spelling.
  const statusCode = findFirst(response, "StatusCode")?.getAttribute("Value") ?? "";
  if (!statusCode.toLowerCase().includes("success")) {
    return { ok: false, status: 401, error: "IdP reported a failed authentication" };
  }

  // THE WRAP DEFENSE: the signature must sit on the Response element and
  // cover the Response's content. No Assertion-signature path exists here.
  const sig = findFirst(response, "Signature");
  if (!sig) return { ok: false, status: 401, error: "Response is not signed" };
  const signatureValue = textOf(findFirst(sig, "SignatureValue"));
  const digestValue = textOf(findFirst(sig, "DigestValue"));
  if (!signatureValue || !digestValue) {
    return { ok: false, status: 401, error: "malformed signature" };
  }

  // What was signed: the element the SignedInfo's Reference points at. In
  // every well-formed Response that is the Response itself (enveloped).
  // Resolution is by walking the tree for a matching ID attribute — not
  // `getElementById`, which in xmldom (as in most parsers) only resolves IDs
  // declared in a DTD, which no SAML Response carries.
  const signedInfo = findFirst(sig, "SignedInfo");
  if (!signedInfo) return { ok: false, status: 401, error: "no SignedInfo in the signature" };
  const reference = findFirst(signedInfo, "Reference");
  const uri = reference?.getAttribute("URI") ?? "";
  const signedElement: DomElement | null = resolveReferenceUri(root, uri);
  if (!signedElement) {
    return { ok: false, status: 401, error: "signature reference does not resolve" };
  }

  // 1. Digest: canonicalized signed content hashed with the declared algorithm.
  // Enveloped-signature rule (the transform every SP applies): the digest
  // covers the signed element with the Signature subtree itself REMOVED —
  // otherwise the signature could never verify, since it sits inside the very
  // bytes it signs. `detachedSignatureClone` does the removal without touching
  // the parsed document the later steps still walk.
  const content = canonicalize(detachedSignatureClone(signedElement, sig));
  const digestAlgorithm = reference?.getAttribute("DigestAlgorithm") ?? "";
  const expectedDigest = base64(hash(content, digestAlgorithm));
  if (!timingSafeB64Equal(digestValue, expectedDigest)) {
    return { ok: false, status: 401, error: "digest mismatch — the Response was modified" };
  }

  // 2. Signature: canonicalized SignedInfo verified with the org's cert.
  const signedInfoXml = canonicalize(signedInfo);
  const signatureAlgorithm =
    findFirst(signedInfo, "SignatureMethod")?.getAttribute("Algorithm") ?? "";
  const valid = verifyWithAlgorithm(signatureAlgorithm, signedInfoXml, signatureValue, certPem);
  if (!valid) {
    return { ok: false, status: 401, error: "signature verification failed" };
  }

  // 3. Window: NotBefore/NotOnOrAfter on the Assertion, with skew.
  const assertion = firstChildNamed(response, "Assertion", "saml:Assertion");
  if (!assertion) return { ok: false, status: 400, error: "no Assertion in Response" };
  const conditions = findFirst(assertion, "Conditions");
  if (conditions) {
    const notBefore = isoToMs(conditions.getAttribute("NotBefore"));
    const notOnOrAfter = isoToMs(conditions.getAttribute("NotOnOrAfter"));
    if (notBefore !== null && now + SKEW_MS < notBefore) {
      return { ok: false, status: 401, error: "assertion is not yet valid" };
    }
    if (notOnOrAfter !== null && now >= notOnOrAfter + SKEW_MS) {
      return { ok: false, status: 401, error: "assertion has expired" };
    }
  }

  // 4. Identity extraction — only now, on verified content.
  const issuer = textOf(firstChildNamed(assertion, "Issuer", "saml:Issuer")) ?? "";
  const subject = findFirst(assertion, "Subject");
  const nameIdEl = subject ? firstChildNamed(subject, "NameID", "saml:NameID") : null;
  const nameId = nameIdEl ? textOf(nameIdEl) : null;
  if (!nameId) return { ok: false, status: 400, error: "no NameID in the assertion" };
  if (!nameId.includes("@")) {
    return { ok: false, status: 401, error: "NameID is not an email address" };
  }

  const attributes: Record<string, string> = {};
  const attrStatement = findFirst(assertion, "AttributeStatement");
  if (attrStatement) {
    for (const attr of childrenNamed(attrStatement, "Attribute", "saml:Attribute")) {
      const name = attr.getAttribute("Name") ?? attr.getAttribute("NameFormat") ?? "";
      const value = findFirst(attr, "AttributeValue");
      const text = value ? textOf(value) : null;
      if (name && text) attributes[name] = text;
    }
  }

  // InResponseTo is optional: IdP-initiated flows carry none, and the ACS
  // route's replay policy decides what that means.
  const rawInResponseTo = response.getAttribute("InResponseTo");
  const inResponseTo =
    rawInResponseTo !== null && rawInResponseTo.length > 0 ? rawInResponseTo : null;

  return { ok: true, identity: { nameId, attributes, issuer }, inResponseTo };
}

// ---------- canonicalization (exc-c14n, the subset SAML uses) ----------

/**
 * Canonical XML (exclusive) as `xmldom` renders it. @xmldom/xmldom's
 * XMLSerializer already emits the properties exc-c14n requires for SAML
 * payloads — no comments, attribute order stable by insertion, namespace
 * declarations on the owning element, empty elements as start/end pairs.
 * The one property it does not guarantee is whitespace inside the start tag,
 * and SAML's `parseFromString` path keeps it deterministic.
 *
 * This function is the seam ADR 0013 names: swapping in a dedicated c14n
 * library means changing this one function, nothing else.
 */
export function canonicalize(node: DomElement): string {
  // Clone so the serializer never mutates the parsed document's relationships.
  return new XMLSerializer().serializeToString(node);
}

// ---------- helpers ----------

/**
 * Child access with the element shape reasserted: xmldom's `childNodes.item`
 * is typed Node, but every child the SAML walk ever *does* something with is
 * an Element (text children are consumed only by `textOf`). This narrows at
 * the one place the tree is walked, so the rest of the file deals in Elements.
 */
function childAt(parent: DomElement, i: number): DomElement | null {
  const item = parent.childNodes.item(i);
  // Node.ELEMENT_NODE === 1; anything else (text, cdata) is not a candidate
  // for name-based walks and is skipped by returning null.
  return item && item.nodeType === 1 ? (item as DomElement) : null;
}

/**
 * The enveloped-signature transform: a copy of `signedElement` with the
 * `signature` subtree removed, without mutating the parsed document (the
 * later steps — SignedInfo canonicalization, identity extraction — walk the
 * original, and a verifier that edits the document it is verifying is a
 * verifier that can be steered). The clone is throwaway; only its
 * serialized form is hashed.
 */
function detachedSignatureClone(signedElement: DomElement, signature: DomElement): DomElement {
  const clone = signedElement.cloneNode(true) as unknown as DomElement;
  // Find the Signature inside the CLONE (the passed one belongs to the
  // original tree) and remove it.
  const sigInClone = findFirst(clone, "Signature");
  if (sigInClone && sigInClone.parentNode) {
    sigInClone.parentNode.removeChild(sigInClone);
  }
  void signature;
  return clone;
}

/**
 * Resolve a SignedInfo Reference URI: `#id` finds the element with that ID
 * attribute in the tree; an empty URI means the whole document (the
 * Response); anything else — a fragment we do not point at, an external URL
 * — does not resolve, which is the honest refusal: signing something we
 * were not shown is not a state this verifier can be in.
 */
function resolveReferenceUri(root: DomElement, uri: string): DomElement | null {
  if (uri === "" || uri === "#") return root;
  if (!uri.startsWith("#")) return null;
  const wanted = uri.slice(1);
  const findByElementId = (el: DomElement): DomElement | null => {
    if (el.getAttribute("ID") === wanted) return el;
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const child = childAt(el, i);
      if (!child) continue;
      const hit = findByElementId(child);
      if (hit) return hit;
    }
    return null;
  };
  return findByElementId(root);
}

function isNamed(node: DomElement, ...names: string[]): boolean {
  const local = node.nodeName.replace(/^.*:/, "");
  return names.includes(node.nodeName) || names.includes(local);
}

function firstChildNamed(parent: DomElement | null, ...names: string[]): DomElement | null {
  if (!parent) return null;
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = childAt(parent, i);
    if (!child) continue;
    const local = child.nodeName.replace(/^.*:/, "");
    if (names.includes(child.nodeName) || names.includes(local)) return child;
  }
  return null;
}

function childrenNamed(parent: DomElement, ...names: string[]): DomElement[] {
  const out: DomElement[] = [];
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = childAt(parent, i);
    if (!child) continue;
    const local = child.nodeName.replace(/^.*:/, "");
    if (names.includes(child.nodeName) || names.includes(local)) out.push(child);
  }
  return out;
}

/** Depth-first find by local name, ignoring the prefix. */
function findFirst(parent: DomElement, localName: string): DomElement | null {
  if (parent.nodeName.replace(/^.*:/, "") === localName) return parent;
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    const child = childAt(parent, i);
    if (!child) continue;
    const hit = findFirst(child, localName);
    if (hit) return hit;
  }
  return null;
}

function textOf(node: DomElement | null): string | null {
  if (!node) return null;
  // Element text: concatenate the direct text children (SAML values are
  // simple text, never mixed content).
  let out = "";
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes.item(i);
    if (child && (child.nodeType === TEXT_NODE || child.nodeType === CDATA_NODE)) {
      out += child.nodeValue ?? "";
    }
  }
  return out.trim().length > 0 ? out.trim() : null;
}

function isoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function hash(xml: string, algorithm: string): Buffer {
  // SAML's digest algorithms all end in #sha256/#sha384/#sha512.
  const lower = algorithm.toLowerCase();
  if (lower.endsWith("sha384")) return createHash("sha384").update(xml, "utf8").digest();
  if (lower.endsWith("sha512")) return createHash("sha512").update(xml, "utf8").digest();
  return createHash("sha256").update(xml, "utf8").digest();
}

function verifyWithAlgorithm(
  algorithm: string,
  xml: string,
  signatureB64: string,
  certPem: string,
): boolean {
  const lower = algorithm.toLowerCase();
  const rsaAlgo = lower.includes("sha256")
    ? "RSA-SHA256"
    : lower.includes("sha384")
      ? "RSA-SHA384"
      : lower.includes("sha512")
        ? "RSA-SHA512"
        : "RSA-SHA256";
  try {
    return createVerify(rsaAlgo).update(xml, "utf8").verify(certPem, signatureB64, "base64");
  } catch {
    // A malformed cert or signature is a verification failure, not a crash.
    return false;
  }
}

function base64(buf: Buffer): string {
  return buf.toString("base64");
}

function timingSafeB64Equal(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Mint an AuthnRequest id (the `ID` the IdP echoes back as InResponseTo). */
export function newAuthnRequestId(): string {
  return "_" + randomBytes(21).toString("base64url");
}
