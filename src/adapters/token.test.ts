import { describe, expect, it } from "vitest";
import { readOAuthToken, type OAuthToken } from "./token";

describe("readOAuthToken", () => {
  it("should read the token and its lifetime from the OAuth response", () => {
    const parsed = readOAuthToken({
      scope: "https://uri.paypal.com/services/invoicing",
      access_token: "A21AA",
      token_type: "Bearer",
      app_id: "APP-80W284485P519543T",
      expires_in: 32400,
      nonce: "2026-Oct-16T00:00:00Z",
    });

    expect(parsed).toEqual({ accessToken: "A21AA", expiresInSeconds: 32400 });
  });

  it("should reject a response with no access token", () => {
    expect(readOAuthToken({ expires_in: 32400 })).toBeNull();
  });

  it("should reject a non-string token", () => {
    expect(readOAuthToken({ access_token: 12345, expires_in: 32400 })).toBeNull();
  });

  it("should reject a token that is not usable as a bearer credential", () => {
    expect(readOAuthToken({ access_token: "", expires_in: 32400 })).toBeNull();
  });

  it("should reject a response with no expiry, because the refresh interval depends on it", () => {
    // Without expires_in there is nothing to schedule a refresh against, and
    // "refresh at 80% of unknown" becomes "discover the expiry mid-demo".
    expect(readOAuthToken({ access_token: "A21AA" })).toBeNull();
  });

  it("should reject a nonsense expiry rather than producing NaN hours", () => {
    expect(readOAuthToken({ access_token: "A21AA", expires_in: "soon" })).toBeNull();
    expect(readOAuthToken({ access_token: "A21AA", expires_in: -1 })).toBeNull();
  });

  it("should handle the real sandbox shape, expires_in 32400 = 9 hours", () => {
    const parsed: OAuthToken = readOAuthToken({
      access_token: "A21AA",
      expires_in: 32400,
    })!;
    expect(parsed.expiresInSeconds / 3600).toBe(9);
  });
});