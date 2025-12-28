export type AuthUser = {
  sub: string;

  // common OIDC/Auth0 fields (optional depending on token + scopes)
  email?: string;
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;

  // Auth0 sometimes provides these
  given_name?: string;
  family_name?: string;

  // Catch-all for custom claims
  [key: string]: unknown;
};
