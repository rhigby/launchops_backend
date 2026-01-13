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
  roles?: string[];
  // Any custom claims
  [key: string]: unknown;
};

export function auth0JwtVerifier(opts: { issuer: string; audience: string }) {
  // Auth0 JWKS endpoint: <issuer>/.well-known/jwks.json
  const jwks = createRemoteJWKSet(new URL(`${opts.issuer}.well-known/jwks.json`));

  return async function verify(token: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
    });

    const roles =
      (payload["https://launchops/roles"] as string[] | undefined) ||
      (payload["roles"] as string[] | undefined);

    // Return a helpful subset + keep full payload fields accessible if you need them later
    return {
      ...payload,
      sub: String(payload.sub),
      email: payload.email ? String(payload.email) : undefined,
      name: payload.name ? String(payload.name) : undefined,
      nickname: payload.nickname ? String(payload.nickname) : undefined,
      preferred_username: payload.preferred_username ? String(payload.preferred_username) : undefined,
      picture: payload.picture ? String(payload.picture) : undefined,
      given_name: payload.given_name ? String(payload.given_name) : undefined,
      family_name: payload.family_name ? String(payload.family_name) : undefined,
      roles,
    };
  };
}
