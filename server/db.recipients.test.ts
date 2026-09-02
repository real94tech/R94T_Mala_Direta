import { afterEach, describe, expect, it, vi } from "vitest";
import { getListContacts } from "./db";

function xanoResponse(data: unknown) {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe("getListContacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores contacts linked to a different list when Xano returns every member", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xanoResponse([
        { id: 1, list_id: 10, contact_id: 101 },
        { id: 2, list_id: 20, contact_id: 202 },
      ]))
      .mockResolvedValueOnce(xanoResponse([
        { id: 101, email: "selected@example.com", subscribed: true },
        { id: 202, email: "other-list@example.com", subscribed: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const recipients = await getListContacts(10);

    expect(recipients.map(contact => contact.email)).toEqual(["selected@example.com"]);
  });
});
