/**
 * Kiro OAuth / CodeWhisperer constants.
 *
 * Kiro (= Amazon Q Developer / AWS CodeWhisperer) shares one backend across its
 * IDE and CLI. We do not run Kiro's own browser OAuth (its client_id is not
 * public); instead we reuse the refresh token that the Kiro IDE/CLI already
 * stored, exchange it for an access token, and call the CodeWhisperer inference
 * endpoint. This is completely separate from both the Anthropic and Codex flows.
 *
 * Endpoints confirmed from the open-source Kiro gateways (kiro2cc / kiro2api /
 * kiro-gateway).
 */

/** Social (kiro.dev) refresh endpoint — body: { refreshToken } */
export const KIRO_SOCIAL_REFRESH_URL =
  'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken'

/** IdC (AWS SSO OIDC) refresh endpoint — body: { clientId, clientSecret, grantType, refreshToken } */
export const KIRO_IDC_REFRESH_URL = 'https://oidc.us-east-1.amazonaws.com/token'

/** CodeWhisperer inference endpoint (Anthropic-messages payload is translated to this). */
export const KIRO_CODEWHISPERER_URL =
  'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse'

/** ProfileArn required by the CodeWhisperer generateAssistantResponse call. */
export const KIRO_PROFILE_ARN =
  'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

/** User-agent header expected by the IdC refresh endpoint. */
export const KIRO_IDC_USER_AGENT =
  'aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE'

/**
 * User-Agent header required by the CodeWhisperer inference endpoint. The
 * backend gates the "application" (subscription) check on the *real* User-Agent
 * containing `KiroIDE`; the `x-amz-user-agent` header does NOT satisfy it. Enterprise
 * (IdC) accounts return "subscription does not support this application" without it.
 */
export const KIRO_IDE_USER_AGENT = 'aws-sdk-js/3.738.0 KiroIDE-0.1.0'

/** Auth method discriminator stored alongside the tokens. */
export const KIRO_AUTH_SOCIAL = 'Social' as const
export const KIRO_AUTH_IDC = 'IdC' as const
export type KiroAuthMethod = typeof KIRO_AUTH_SOCIAL | typeof KIRO_AUTH_IDC

/**
 * Provider identifier used in config storage to distinguish Kiro credentials
 * from Anthropic / Codex credentials.
 */
export const KIRO_PROVIDER_ID = 'kiro' as const
