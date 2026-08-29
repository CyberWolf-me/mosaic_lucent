/**
 * Email templates (M1.3).
 *
 * Hand-written rather than a template engine — the surface is small (four
 * templates) and a string-template approach keeps the wire output
 * inspectable and free of template-language injection bugs.
 *
 * Every template takes a `siteOrigin` so links work in dev (localhost) and
 * prod (https://lucent.app). The token is interpolated URL-encoded because
 * the verification and reset tokens are random base64url strings that may
 * legitimately contain characters needing escaping.
 */

export interface TemplateContext {
  siteOrigin: string;
  /** Human-readable product name shown in headers. Default "Lucent". */
  productName?: string;
}

export interface VerificationTemplate {
  subject: string;
  text: string;
  html: string;
}

export function verificationEmail(
  ctx: TemplateContext,
  token: string,
  email: string,
): VerificationTemplate {
  const product = ctx.productName ?? "Lucent";
  const url = `${ctx.siteOrigin}/verify?token=${encodeURIComponent(token)}`;
  const subject = `Verify your ${product} account`;
  const text =
    `Hi,\n\n` +
    `Welcome to ${product}. Confirm your email (${email}) to finish setting up your account:\n\n` +
    `  ${url}\n\n` +
    `This link expires in 24 hours. If you didn't sign up, you can ignore this message.\n`;
  const html =
    `<p>Hi,</p>` +
    `<p>Welcome to ${escapeHtml(product)}. Confirm your email (<code>${escapeHtml(email)}</code>) to finish setting up your account:</p>` +
    `<p><a href="${escapeHtml(url)}">Verify your email</a></p>` +
    `<p>This link expires in 24 hours. If you didn't sign up, you can ignore this message.</p>`;
  return { subject, text, html };
}

export function passwordResetEmail(ctx: TemplateContext, token: string): VerificationTemplate {
  const product = ctx.productName ?? "Lucent";
  const url = `${ctx.siteOrigin}/reset?token=${encodeURIComponent(token)}`;
  const subject = `Reset your ${product} password`;
  const text =
    `Hi,\n\n` +
    `Someone (hopefully you) asked to reset the password on this ${product} account. ` +
    `Use the link below to pick a new one:\n\n` +
    `  ${url}\n\n` +
    `This link expires in 1 hour. If you didn't ask for a reset, you can ignore this email — your password hasn't changed.\n`;
  const html =
    `<p>Hi,</p>` +
    `<p>Someone (hopefully you) asked to reset the password on this ${escapeHtml(product)} account. ` +
    `Use the link below to pick a new one:</p>` +
    `<p><a href="${escapeHtml(url)}">Reset your password</a></p>` +
    `<p>This link expires in 1 hour. If you didn't ask for a reset, you can ignore this email — your password hasn't changed.</p>`;
  return { subject, text, html };
}

/**
 * What an invite is to. A board invite and a workspace invite are the same mail
 * with two nouns swapped, and they redeem at the same `/invite?token=` route,
 * so they are one template: a second copy is a second place for the expiry
 * window to be wrong.
 */
export interface InviteTemplateParams {
  inviterName: string;
  /** The board's or the workspace's name, as the recipient will recognise it. */
  contextName: string;
  contextKind: "board" | "workspace";
  token: string;
  role: string;
}

export function inviteEmail(
  ctx: TemplateContext,
  params: InviteTemplateParams,
): VerificationTemplate {
  const product = ctx.productName ?? "Lucent";
  const url = `${ctx.siteOrigin}/invite?token=${encodeURIComponent(params.token)}`;
  // Escaped once, here, for the plain-text half too -- an inviter-supplied name
  // reaches this template straight from a profile field.
  const who = escapeText(params.inviterName);
  const what = escapeText(params.contextName);
  const role = escapeText(params.role);
  const action = params.contextKind === "board" ? "collaborate on" : "join";
  const subject = `${who} invited you to "${what}"`;
  const text =
    `Hi,\n\n` +
    `${who} has invited you to ${action} the "${what}" ${params.contextKind} in ${product} ` +
    `as a ${role}. Open the invite to join:\n\n` +
    `  ${url}\n\n` +
    `This link expires in 7 days.\n`;
  const html =
    `<p>Hi,</p>` +
    `<p>${escapeHtml(params.inviterName)} has invited you to ${action} the ` +
    `<strong>${escapeHtml(params.contextName)}</strong> ${params.contextKind} in ` +
    `${escapeHtml(product)} as a ${escapeHtml(params.role)}.</p>` +
    `<p><a href="${escapeHtml(url)}">Open the invite</a></p>` +
    `<p>This link expires in 7 days.</p>`;
  return { subject, text, html };
}

export function boardInviteEmail(
  ctx: TemplateContext,
  params: { inviterName: string; boardName: string; token: string; role: string },
): VerificationTemplate {
  return inviteEmail(ctx, {
    inviterName: params.inviterName,
    contextName: params.boardName,
    contextKind: "board",
    token: params.token,
    role: params.role,
  });
}

/**
 * M2.4's org invite had no template at all: the route hand-rolled a text-only
 * body with no inviter, no workspace name and a hard-coded product name, so the
 * one mail a new teammate ever receives was the least finished mail we send.
 */
export function orgInviteEmail(
  ctx: TemplateContext,
  params: { inviterName: string; orgName: string; token: string; role: string },
): VerificationTemplate {
  return inviteEmail(ctx, {
    inviterName: params.inviterName,
    contextName: params.orgName,
    contextKind: "workspace",
    token: params.token,
    role: params.role,
  });
}

export function receiptEmail(
  ctx: TemplateContext,
  params: { amount: string; plan: string; periodEnd: string },
): VerificationTemplate {
  const product = ctx.productName ?? "Lucent";
  const subject = `Your ${product} receipt — ${escapeText(params.plan)}`;
  const text =
    `Thanks for being on the ${escapeText(params.plan)} plan.\n\n` +
    `Amount: ${escapeText(params.amount)}\n` +
    `Period ends: ${escapeText(params.periodEnd)}\n\n` +
    `A PDF invoice is attached to the email your billing provider sent.\n`;
  const html =
    `<p>Thanks for being on the ${escapeHtml(params.plan)} plan.</p>` +
    `<ul>` +
    `<li>Amount: ${escapeHtml(params.amount)}</li>` +
    `<li>Period ends: ${escapeHtml(params.periodEnd)}</li>` +
    `</ul>`;
  return { subject, text, html };
}

/**
 * Exported because `notifications.ts` renders mail too and was carrying a
 * byte-identical private copy. Two escapers is one escaper that can be fixed
 * and one that cannot.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeText(text: string): string {
  // Plain-text: strip control chars and backslash-escapes; the consumer is
  // an email body, not HTML.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point of this filter
  return text.replace(/[\u0000-\u001F\u007F]/g, "");
}
