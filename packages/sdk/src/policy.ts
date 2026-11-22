import type { Decision, ResourceScope } from "./acl";
import type { Role } from "./tools";

export interface PolicySubject {
  principalId?: string;
  role: Role;
  tags?: readonly string[];
}
export interface PolicyAction {
  authenticatedBy?: string;
}
export interface PolicyProvider {
  check(
    subject: PolicySubject,
    permission: string,
    resource?: ResourceScope,
    action?: PolicyAction,
  ): Decision;
}
