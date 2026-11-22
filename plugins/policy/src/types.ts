import type { Audience } from "@valethq/sdk";

export interface Grant {
  to: string[];
  allow: string[];
  on?: string[];
  via?: "authenticated";
}

export interface PolicyTest {
  subject: string;
  audience?: Audience;
  tags?: string[];
  cap?: string[];
  resource?: string;
  allow?: string[];
  deny?: string[];
}

export interface PolicyFile {
  version: 1;
  useDefaults: boolean;
  groups: Record<string, string[]>;
  tags: Record<string, { owners: string[] }>;
  grants: Grant[];
  tests: PolicyTest[];
}

export const emptyPolicyFile = (): PolicyFile => ({
  version: 1,
  useDefaults: true,
  groups: {},
  tags: {},
  grants: [],
  tests: [],
});
