/** Intuit endpoints. Verified against Intuit docs Oct 2026. */
export const INTUIT = {
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
  scope: 'com.intuit.quickbooks.accounting',
  apiBase: {
    sandbox: 'https://sandbox-quickbooks.api.intuit.com',
    production: 'https://quickbooks.api.intuit.com',
  },
  /** 1–74 are retired; Intuit treats anything lower as 75. Pin it explicitly. */
  minorVersion: 75,
} as const;

export type QboEnvironment = keyof typeof INTUIT.apiBase;

export interface QboAppConfig {
  environment: QboEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
