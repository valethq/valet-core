import type { CredentialState } from "./acl";

export interface AuthResult {
  principalId: string;
  /** Revocable credential, e.g. a device or token id. */
  credentialId?: string;
  /** Labels of a non-human credential. */
  tags?: string[];
  /** Permission patterns this credential is limited to. Absent means uncapped. */
  cap?: string[];
  /** spec-gap: evidence of a verified control-plane login (a password login, not a bearer token). */
  verifiedLogin?: boolean;
}
export interface IdentityProvider {
  authenticate(req: Request): AuthResult | undefined | Promise<AuthResult | undefined>;
  /** spec-gap: current state of a credential this provider issued, so revocation reaches runs, wakes and channels. */
  credential?(credentialId: string): CredentialState | undefined;
}
