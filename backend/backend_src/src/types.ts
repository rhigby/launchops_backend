export type AuthUser = {
  sub: string;
  email?: string;
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;

  [key: string]: unknown;
};
