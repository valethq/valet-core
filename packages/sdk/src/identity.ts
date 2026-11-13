export interface AuthResult {
  principalId: string;
  /** Revocable credential, e.g. a device or token id. */
  credentialId?: string;
}
export interface IdentityProvider {
  authenticate(req: Request): AuthResult | undefined | Promise<AuthResult | undefined>;
}
