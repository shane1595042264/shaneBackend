// tests/modules/courses/certificate-code.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/client", () => ({ db: {} }));

import {
  CODE_LENGTH,
  newCertificateCode,
  normalizeCertificateCode,
} from "@/modules/courses/certificate-repo";

describe("certificate codes (SHAN-720)", () => {
  it("mints 12 Crockford base32 characters", () => {
    for (let i = 0; i < 200; i++) {
      const code = newCertificateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    }
  });

  it("reads a code the way it is printed", () => {
    expect(normalizeCertificateCode("7k3m-9qx2-abcd")).toBe("7K3M9QX2ABCD");
    expect(normalizeCertificateCode(" 7K3M 9QX2 ABCD ")).toBe("7K3M9QX2ABCD");
  });

  it("rejects anything that cannot be a code", () => {
    expect(normalizeCertificateCode("7K3M9QX2ABC")).toBeNull();
    expect(normalizeCertificateCode("7K3M9QX2ABCDE")).toBeNull();
    // I, L, O and U are not in the alphabet.
    expect(normalizeCertificateCode("7K3M9QX2ABCO")).toBeNull();
    expect(normalizeCertificateCode("../../../etc")).toBeNull();
  });
});
