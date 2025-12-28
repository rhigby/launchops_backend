export type AuthUser = {
  sub: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  scope?: string;

  email?: string | null;
  name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;

  picture?: string | null;
  [key: string]: unknown;
};
