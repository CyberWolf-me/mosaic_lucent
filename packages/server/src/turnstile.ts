/**
 * Cloudflare Turnstile token verification helper.
 * Validates cf-turnstile-response tokens against Cloudflare Siteverify API.
 */

export interface TurnstileVerificationResult {
  success: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstileToken(
  token: string | undefined | null,
  remoteIp?: string,
): Promise<TurnstileVerificationResult> {
  const secretKey = process.env.LUCENT_TURNSTILE_SECRET_KEY;
  // If not configured, verification is disabled (graceful bypass for local unit tests)
  if (!secretKey) {
    return { success: true };
  }

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const formData = new URLSearchParams();
  formData.append("secret", secretKey);
  formData.append("response", token.trim());
  if (remoteIp) formData.append("remoteip", remoteIp);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      console.warn(`[lucent] turnstile siteverify HTTP ${res.status}`);
      return { success: false, errorCodes: [`http-${res.status}`] };
    }
    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    return {
      success: Boolean(data.success),
      errorCodes: data["error-codes"],
    };
  } catch (err) {
    console.error("[lucent] turnstile verification network error:", (err as Error).message);
    return { success: false, errorCodes: ["network-error"] };
  }
}
