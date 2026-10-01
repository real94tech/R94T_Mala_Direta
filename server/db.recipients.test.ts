import { afterEach, describe, expect, it, vi } from "vitest";
import { addContactsToList, createContact, getContactLists, getContacts, getListContacts, removeContactFromList } from "./db";

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
      .mockResolvedValueOnce(xanoResponse({ id: 10, user_id: 7, name: "Clientes" }))
      .mockResolvedValueOnce(xanoResponse([
        { id: 1, list_id: 10, contact_id: 101 },
        { id: 2, list_id: 20, contact_id: 202 },
      ]))
      .mockResolvedValueOnce(xanoResponse([
        { id: 101, user_id: 7, email: "selected@example.com", subscribed: true },
        { id: 202, user_id: 7, email: "other-list@example.com", subscribed: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const recipients = await getListContacts(10, 7);

    expect(recipients.map(contact => contact.email)).toEqual(["selected@example.com"]);
  });
});

describe("getContactLists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts members when Xano returns relation ids as strings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xanoResponse([
        { id: 10, user_id: 7, name: "Clientes" },
        { id: 20, user_id: 7, name: "Fornecedores" },
      ]))
      .mockResolvedValueOnce(xanoResponse([
        { id: 1, list_id: "10", contact_id: "101" },
        { id: 2, list_id: "10", contact_id: "102" },
        { id: 3, list_id: "20", contact_id: "201" },
      ]))
      .mockResolvedValueOnce(xanoResponse([
        { id: 101, user_id: 7, email: "a@example.com", subscribed: true },
        { id: 102, user_id: 7, email: "b@example.com", subscribed: true },
        { id: 201, user_id: 7, email: "c@example.com", subscribed: true },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const lists = await getContactLists(7);

    expect(lists.map(list => [list.name, list.contactCount])).toEqual([
      ["Clientes", 2],
      ["Fornecedores", 1],
    ]);
  });
});

describe("getContacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only the selected list members when Xano returns every relation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xanoResponse([
        { id: 101, user_id: 7, email: "selected@example.com", subscribed: true },
        { id: 202, user_id: 7, email: "other-list@example.com", subscribed: true },
      ]))
      .mockResolvedValueOnce(xanoResponse({ id: 10, user_id: 7, name: "Clientes" }))
      .mockResolvedValueOnce(xanoResponse([
        { id: 1, list_id: 10, contact_id: 101 },
        { id: 2, list_id: 20, contact_id: 202 },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getContacts(7, { listId: 10 });

    expect(result.contacts.map(contact => contact.email)).toEqual(["selected@example.com"]);
    expect(result.total).toBe(1);
  });
});

describe("list membership mutations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a contact to the requested list even when it belongs to another list", async () => {
    const requests: Array<{ path: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url, "https://example.test").pathname;
      const method = options.method ?? "GET";
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ path, method, body });
      if (path.endsWith("/mkt_contact_lists/10")) return xanoResponse({ id: 10, user_id: 7 });
      if (path.endsWith("/mkt_contacts/101")) return xanoResponse({ id: 101, user_id: 7, email: "a@example.com" });
      if (path.endsWith("/mkt_contact_list_members") && method === "GET") {
        return xanoResponse([{ id: 1, list_id: 20, contact_id: 101 }]);
      }
      if (path.endsWith("/mkt_contacts")) return xanoResponse([{ id: 101, user_id: 7, email: "a@example.com", subscribed: true }]);
      return xanoResponse({ id: 2 });
    }));

    await addContactsToList([101], 10, 7);

    expect(requests).toContainEqual(expect.objectContaining({
      path: expect.stringContaining("/mkt_contact_list_members"),
      method: "POST",
      body: { contact_id: 101, list_id: 10 },
    }));
  });

  it("does not delete a member from a different list", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url, "https://example.test").pathname;
      const method = options.method ?? "GET";
      requests.push({ path, method });
      if (path.endsWith("/mkt_contact_lists/10")) return xanoResponse({ id: 10, user_id: 7 });
      if (path.endsWith("/mkt_contacts/101")) return xanoResponse({ id: 101, user_id: 7, email: "a@example.com" });
      if (path.endsWith("/mkt_contact_list_members")) return xanoResponse([{ id: 1, list_id: 20, contact_id: 101 }]);
      if (path.endsWith("/mkt_contacts")) return xanoResponse([{ id: 101, user_id: 7, email: "a@example.com", subscribed: true }]);
      return xanoResponse({ id: 10 });
    }));

    await removeContactFromList(101, 10, 7);

    expect(requests.some(request => request.method === "DELETE")).toBe(false);
  });

  it("rejects a failed contact creation instead of inventing an id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: "failure" }) })));

    await expect(createContact({ userId: 7, email: "a@example.com" })).rejects.toThrow("Falha no Xano");
  });
});
