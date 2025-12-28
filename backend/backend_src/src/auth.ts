import { createRemoteJWKSet, jwtVerify } from "jose";

export type AuthUser = {
  sub: string;
  email?: string;
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;

  // Any custom claims
  [key: string]: unknown;
};

export function auth0JwtVerifier(opts: { issuer: string; audience: string }) {
  const jwks = createRemoteJWKSet(new URL(`${opts.issuer}.well-known/jwks.json`));

  return async function verify(token: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      audience: opts.audience
    });

    const roles =
      (payload["https://launchops/roles"] as string[] | undefined) ||
      (payload["roles"] as string[] | undefined);

    return {
      sub: String(payload.sub),
      email: payload.email ? String(payload.email) : undefined,
      name: payload.name ? String(payload.name) : undefined,
      roles
    };
  };
}
