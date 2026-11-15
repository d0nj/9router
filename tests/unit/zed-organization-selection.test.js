// Regression: Zed mints LLM tokens per organization. A credential bound to an
// organization without the subscription fails every call with
// "Organization does not have an active subscription", so selection must read
// plans_by_organization — never default to the personal organization.
import { describe, it, expect } from "vitest";
import {
  selectZedOrganizationId,
  reconcileZedOrganizationCredentials,
} from "open-sse/shared/zedAuth.js";

const userInfo = {
  default_organization_id: "org-personal",
  organizations: [
    { id: "org-personal", name: "Personal", is_personal: true },
    { id: "org-work", name: "Work", is_personal: false },
  ],
  plans_by_organization: {
    "org-personal": "zed_free",
    "org-work": "zed_pro",
  },
};

describe("Zed organization selection", () => {
  it("picks the organization that holds the paid plan, not the default/personal one", () => {
    expect(selectZedOrganizationId(userInfo)).toBe("org-work");
  });

  it("prefers zed_pro over zed_business when both are paid", () => {
    const plans = {
      ...userInfo,
      plans_by_organization: { "org-personal": "zed_business", "org-work": "zed_pro" },
    };
    expect(selectZedOrganizationId(plans)).toBe("org-work");
  });

  it("ignores free plans and falls back to the default organization", () => {
    expect(
      selectZedOrganizationId({
        ...userInfo,
        default_organization_id: "org-work",
        plans_by_organization: { "org-personal": "zed_free", "org-work": "zed_free" },
      }),
    ).toBe("org-work");
  });

  it("prefers the default organization when several share the top plan", () => {
    expect(
      selectZedOrganizationId({
        ...userInfo,
        default_organization_id: "org-work",
        plans_by_organization: { "org-personal": "zed_pro", "org-work": "zed_pro" },
      }),
    ).toBe("org-work");
  });

  it("keeps the selected organization when it already has a paid plan", () => {
    expect(
      selectZedOrganizationId(
        {
          ...userInfo,
          plans_by_organization: { "org-personal": "zed_pro", "org-work": "zed_pro" },
        },
        "org-work",
      ),
    ).toBe("org-work");
  });

  it("falls back to the default organization when the payload has no plans map", () => {
    expect(selectZedOrganizationId({ default_organization_id: "org-work", organizations: [] })).toBe(
      "org-work",
    );
  });

  it("moves a credential stored on the wrong organization onto the plan-bearing one", () => {
    const credentials = {
      accessToken: "tok",
      providerSpecificData: { userId: "u1", organizationId: "org-personal" },
    };
    const result = reconcileZedOrganizationCredentials(credentials, userInfo);
    expect(result.movedFrom).toBe("org-personal");
    expect(result.credentials.providerSpecificData.organizationId).toBe("org-work");
    expect(result.credentials.accessToken).toBe("tok");
  });

  it("leaves a credential already on the plan-bearing organization untouched", () => {
    const credentials = {
      accessToken: "tok",
      providerSpecificData: { userId: "u1", organizationId: "org-work" },
    };
    expect(reconcileZedOrganizationCredentials(credentials, userInfo)).toBeNull();
  });

  it("does not move a stored organization when the payload has no plans map", () => {
    const credentials = {
      accessToken: "tok",
      providerSpecificData: { userId: "u1", organizationId: "org-work" },
    };
    expect(
      reconcileZedOrganizationCredentials(credentials, {
        default_organization_id: "org-personal",
        organizations: userInfo.organizations,
      }),
    ).toBeNull();
  });

  it("fills an empty stored organization from the payload", () => {
    const credentials = { accessToken: "tok", providerSpecificData: { userId: "u1" } };
    const result = reconcileZedOrganizationCredentials(credentials, {
      default_organization_id: "org-personal",
      organizations: userInfo.organizations,
    });
    expect(result.movedFrom).toBeNull();
    expect(result.credentials.providerSpecificData.organizationId).toBe("org-personal");
  });
});
