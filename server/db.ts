import { createPool, type Pool } from "mysql2/promise";
import type {
  InsertUser, ContactList, InsertContactList, Contact, InsertContact,
  Campaign, InsertCampaign, InsertAuditLog, InsertSmtpSettings
} from "../drizzle/schema";

// ============ CONFIGURAÇÃO DO XANO ============
const XANO_BASE_URL = process.env.XANO_API_BASE_URL?.replace(/\/$/, "") ?? "";

let databasePool: Pool | null | undefined;

function createDatabasePool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  const url = new URL(databaseUrl.replace(/^mysql2?:\/\//, "mysql://"));
  const sslParam = url.searchParams.get("ssl");
  url.searchParams.delete("ssl");

  let ssl: Record<string, unknown> = { rejectUnauthorized: true };
  if (sslParam) {
    try {
      ssl = JSON.parse(decodeURIComponent(sslParam));
    } catch {
      console.warn("[DB] DATABASE_URL contém uma configuração SSL inválida; usando validação padrão.");
    }
  }

  return createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ssl,
    connectionLimit: 5,
  });
}

export async function getDb() {
  if (databasePool === undefined) databasePool = createDatabasePool();
  return databasePool;
}

type LocalUserRecord = {
  id: number;
  openId: string;
  email: string | null;
  name: string | null;
  role: "user" | "admin";
  loginMethod: string | null;
  passwordHash?: string | null;
  password?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

const usersByOpenId = new Map<string, LocalUserRecord>();
const openIdByEmail = new Map<string, string>();
let nextUserId = 1;

function normalizeEmail(email: string | null | undefined) {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

function cloneUser(user: LocalUserRecord) {
  return { ...user };
}

// ============ TRADUTOR UNIVERSAL ============
function mapToApp(record: any): any {
  if (!record || typeof record !== 'object') return record;
  const mapped = { ...record };

  if (mapped.created_at !== undefined) mapped.createdAt = new Date(mapped.created_at);
  if (mapped.user_id !== undefined) mapped.userId = Number(mapped.user_id);
  if (mapped.list_id !== undefined) mapped.listId = Number(mapped.list_id);
  if (mapped.contact_id !== undefined) mapped.contactId = Number(mapped.contact_id);
  if (mapped.campaigns_id !== undefined) mapped.campaignId = Number(mapped.campaigns_id);
  else if (mapped.campaign_id !== undefined) mapped.campaignId = Number(mapped.campaign_id);
  
  if (mapped.contactCount !== undefined) mapped.contactCount = Number(mapped.contactCount);
  if (mapped.subjectConfirmed !== undefined) mapped.subjectConfirmed = Boolean(mapped.subjectConfirmed);

  return mapped;
}

function mapToXano(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const mapped = { ...data };

  if (mapped.userId !== undefined) { mapped.user_id = mapped.userId; delete mapped.userId; }
  if (mapped.listId !== undefined) { mapped.list_id = mapped.listId; delete mapped.listId; }
  if (mapped.campaignId !== undefined) { mapped.campaigns_id = mapped.campaignId; delete mapped.campaignId; }
  if (mapped.contactId !== undefined) { mapped.contact_id = mapped.contactId; delete mapped.contactId; }

  if (mapped.createdAt !== undefined) delete mapped.createdAt;
  if (mapped.updatedAt !== undefined) delete mapped.updatedAt;
  if (mapped.created_at !== undefined) delete mapped.created_at;

  return mapped;
}

// ============ MOTOR DE REQUISIÇÃO ============
async function xanoFetch(endpoint: string, method = 'GET', body?: any): Promise<any> {
  const url = `${XANO_BASE_URL}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  try {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    };
    const response = await fetch(url, options);
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      console.warn(`[Xano] ${method} ${endpoint} → ${response.status}`, result);
      return { _error: true, status: response.status, ...(result && typeof result === 'object' ? result : {}) };
    }
    return result;
  } catch (error) {
    console.error(`[Xano] Falha de rede em ${endpoint}:`, error);
    return { _error: true };
  }
}

async function xanoChecked(endpoint: string, method = 'GET', body?: any): Promise<any> {
  const result = await xanoFetch(endpoint, method, body);
  if (result?._error) throw new Error(`Falha no Xano: ${method} ${endpoint} (${result.status ?? 'rede'}).`);
  return result;
}

async function xanoArray(endpoint: string): Promise<any[]> {
  const result = await xanoChecked(endpoint);
  if (!Array.isArray(result)) throw new Error(`Resposta inválida do Xano: ${endpoint}.`);
  return result;
}

// ============ USERS ============
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) return;

  const email = normalizeEmail(user.email);
  const now = new Date();
  const pool = await getDb();
  if (pool) {
    const [existingRows] = await pool.execute(
      "SELECT id FROM users WHERE openId = ? OR (? IS NOT NULL AND LOWER(email) = ?) LIMIT 1",
      [user.openId, email, email]
    );
    const existingId = (existingRows as Array<{ id: number }>)[0]?.id;

    if (existingId) {
      await pool.execute(
        `UPDATE users SET
          openId = ?, email = COALESCE(?, email), name = COALESCE(?, name),
          role = COALESCE(?, role), loginMethod = COALESCE(?, loginMethod),
          passwordHash = COALESCE(?, passwordHash), updatedAt = NOW(),
          lastSignedIn = COALESCE(?, lastSignedIn)
         WHERE id = ?`,
        [user.openId, email, user.name ?? null, user.role ?? null, user.loginMethod ?? null,
          user.passwordHash ?? null, user.lastSignedIn ?? null, existingId]
      );
    } else {
      await pool.execute(
        `INSERT INTO users
          (openId, email, name, role, loginMethod, passwordHash, createdAt, updatedAt, lastSignedIn)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
        [user.openId, email, user.name ?? null, user.role ?? "user", user.loginMethod ?? null,
          user.passwordHash ?? null, user.lastSignedIn ?? now]
      );
    }
    return;
  }

  const existingOpenId = usersByOpenId.get(user.openId);
  const existingByEmail = email ? usersByOpenId.get(openIdByEmail.get(email) ?? "") : undefined;
  const existing = existingOpenId ?? existingByEmail;

  if (existing) {
    const previousEmail = normalizeEmail(existing.email);
    const updated: LocalUserRecord = {
      ...existing,
      email: email ?? existing.email ?? null,
      name: user.name ?? existing.name ?? null,
      role: (user.role as "user" | "admin" | undefined) ?? existing.role,
      loginMethod: user.loginMethod ?? existing.loginMethod ?? null,
      passwordHash: user.passwordHash ?? existing.passwordHash ?? null,
      password: (user as any).password ?? existing.password ?? null,
      updatedAt: now,
      lastSignedIn: user.lastSignedIn ?? existing.lastSignedIn ?? now,
      openId: user.openId,
    };

    if (previousEmail && previousEmail !== updated.email) openIdByEmail.delete(previousEmail);
    usersByOpenId.delete(existing.openId);
    usersByOpenId.set(updated.openId, updated);
    if (updated.email) openIdByEmail.set(updated.email, updated.openId);
    return;
  }

  const created: LocalUserRecord = {
    id: nextUserId++,
    openId: user.openId,
    email,
    name: user.name ?? email,
    role: (user.role as "user" | "admin" | undefined) ?? "user",
    loginMethod: user.loginMethod ?? null,
    passwordHash: user.passwordHash ?? null,
    password: (user as any).password ?? null,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: user.lastSignedIn ?? now,
  };

  usersByOpenId.set(created.openId, created);
  if (created.email) openIdByEmail.set(created.email, created.openId);
}
export async function getUserByOpenId(openId: string) {
  const pool = await getDb();
  if (pool) {
    const [rows] = await pool.execute("SELECT * FROM users WHERE openId = ? LIMIT 1", [openId]);
    return (rows as LocalUserRecord[])[0];
  }
  const user = usersByOpenId.get(openId);
  return user ? cloneUser(user) : undefined;
}
export async function getUserByEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  const pool = await getDb();
  if (pool) {
    const [rows] = await pool.execute("SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1", [normalized]);
    return (rows as LocalUserRecord[])[0];
  }
  const openId = openIdByEmail.get(normalized);
  if (!openId) return undefined;
  const user = usersByOpenId.get(openId);
  return user ? cloneUser(user) : undefined;
}

function belongsToUser(record: any, userId: number) {
  return Number(record?.user_id ?? record?.userId) === userId;
}

function isSubscribed(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function hasSameId(left: unknown, right: unknown) {
  const normalizedLeft = Number(left);
  const normalizedRight = Number(right);
  return Number.isFinite(normalizedLeft) && normalizedLeft === normalizedRight;
}

function assertOwned(record: any, userId: number, entity: string) {
  if (!record || record._error || !belongsToUser(record, userId)) {
    throw new Error(`${entity} não encontrado ou sem permissão.`);
  }
  return record;
}

// ============ CONTACT LISTS ============
export async function createContactList(data: InsertContactList) {
  const result = await xanoChecked('/mkt_contact_lists', 'POST', mapToXano({ ...data, contactCount: 0 }));
  if (!Number.isInteger(Number(result?.id)) || Number(result.id) <= 0) throw new Error('O Xano não retornou o ID da lista.');
  return { id: result.id };
}

function listContacts(members: any[], contacts: any[], listId: number, userId: number) {
  const memberIds = new Set(members.filter(member => hasSameId(member.list_id, listId)).map(member => Number(member.contact_id)));
  return contacts.filter(contact => memberIds.has(Number(contact.id)) && belongsToUser(contact, userId));
}

function listRecipients(members: any[], contacts: any[], listId: number, userId: number) {
  const emails = new Set<string>();
  return listContacts(members, contacts, listId, userId).filter(contact => {
    if (!isSubscribed(contact.subscribed)) return false;
    const email = normalizeEmail(contact.email);
    if (!email || emails.has(email)) return false;
    emails.add(email);
    return true;
  });
}

// 🔥 CONTAGEM DINÂMICA: Conta os contatos reais na hora que a tela carrega!
export async function getContactLists(userId: number) {
  const [lists, allMembers, contacts] = await Promise.all([
    xanoArray(`/mkt_contact_lists?user_id=${userId}`),
    xanoArray('/mkt_contact_list_members'),
    xanoArray(`/mkt_contacts?user_id=${userId}`),
  ]);
  const ownedLists = lists.filter(list => belongsToUser(list, userId));
  ownedLists.forEach(list => {
    list.contactCount = listContacts(allMembers, contacts, Number(list.id), userId).length;
  });

  return ownedLists.map(mapToApp);
}

export async function getContactListById(id: number, userId: number) {
  const list = await xanoChecked(`/mkt_contact_lists/${id}`);
  if (!list || list._error || !belongsToUser(list, userId)) return undefined;
  const [members, contacts] = await Promise.all([
    xanoArray(`/mkt_contact_list_members?list_id=${id}`),
    xanoArray(`/mkt_contacts?user_id=${userId}`),
  ]);
  list.contactCount = listContacts(members, contacts, id, userId).length;

  return mapToApp(list);
}

export async function updateContactList(id: number, userId: number, data: Partial<InsertContactList>) {
  const existing = assertOwned(await xanoFetch(`/mkt_contact_lists/${id}`), userId, "Lista");
  const payload = { ...existing, ...mapToXano(data), mkt_contact_lists_id: id, user_id: userId };
  delete payload.created_at;
  await xanoChecked(`/mkt_contact_lists/${id}`, 'PATCH', payload);
}

export async function deleteContactList(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contact_lists/${id}`), userId, "Lista");
  await xanoChecked(`/mkt_contact_lists/${id}`, 'DELETE');
}

export async function recalcListCount(listId: number) {
  const existing = await xanoChecked(`/mkt_contact_lists/${listId}`);
  const userId = Number(existing.user_id ?? existing.userId);
  const [members, contacts] = await Promise.all([
    xanoArray(`/mkt_contact_list_members?list_id=${listId}`),
    xanoArray(`/mkt_contacts?user_id=${userId}`),
  ]);
  const payload = { ...existing, contactCount: listContacts(members, contacts, listId, userId).length, mkt_contact_lists_id: listId };
  delete payload.created_at;
  await xanoChecked(`/mkt_contact_lists/${listId}`, 'PATCH', payload);
}

// ============ CONTACTS ============
export async function createContact(data: InsertContact) {
  const result = await xanoChecked('/mkt_contacts', 'POST', mapToXano({ ...data, subscribed: true }));
  if (!Number.isInteger(Number(result?.id)) || Number(result.id) <= 0) throw new Error('O Xano não retornou o ID do contato.');
  return { id: Number(result.id) };
}

export async function bulkCreateContacts(dataArr: InsertContact[]) {
  if (dataArr.length === 0) return [];
  const results = await Promise.all(
    dataArr.map(c => createContact(c))
  );
  return results;
}

export async function getAllUserContacts(userId: number) {
  const contacts = await xanoArray(`/mkt_contacts?user_id=${userId}`);
  return contacts.filter(contact => belongsToUser(contact, userId)).map(mapToApp) as Contact[];
}

export async function getContacts(userId: number, opts?: { search?: string; listId?: number; page?: number; limit?: number }) {
  let contacts = await xanoArray(`/mkt_contacts?user_id=${userId}`);
  contacts = contacts.filter(contact => belongsToUser(contact, userId));

  if (opts?.listId !== undefined) {
    const list = await xanoChecked(`/mkt_contact_lists/${opts.listId}`);
    assertOwned(list, userId, 'Lista');
    const members = await xanoArray(`/mkt_contact_list_members?list_id=${opts.listId}`);
    const memberIds = new Set(
      Array.isArray(members)
        ? members
            .filter((member: any) => hasSameId(member.list_id, opts.listId))
            .map((member: any) => Number(member.contact_id))
        : []
    );
    contacts = contacts.filter((c: any) => memberIds.has(Number(c.id)));
  }

  if (opts?.search) {
    const s = opts.search.toLowerCase();
    contacts = contacts.filter((c: any) =>
      c.email?.toLowerCase().includes(s) || c.firstName?.toLowerCase().includes(s) || c.lastName?.toLowerCase().includes(s)
    );
  }

  const limit = opts?.limit ?? 20;
  const page = opts?.page ?? 1;
  const offset = (page - 1) * limit;
  return { contacts: contacts.slice(offset, offset + limit).map(mapToApp), total: contacts.length };
}

export async function getContactById(id: number, userId: number) {
  const result = await xanoFetch(`/mkt_contacts/${id}`);
  return result && !result._error && belongsToUser(result, userId) ? mapToApp(result) : undefined;
}

export async function updateContact(id: number, userId: number, data: Partial<InsertContact>) {
  const existing = assertOwned(await xanoFetch(`/mkt_contacts/${id}`), userId, "Contato");
  const payload = { ...existing, ...mapToXano(data), mkt_contacts_id: id, user_id: userId };
  delete payload.created_at;
  await xanoChecked(`/mkt_contacts/${id}`, 'PATCH', payload);
}

export async function deleteContact(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contacts/${id}`), userId, "Contato");
  await xanoChecked(`/mkt_contacts/${id}`, 'DELETE');
}

// 🔥 ANTI-DUPLICIDADE: Verifica antes de adicionar para o Xano não bloquear
export async function addContactsToList(contactIds: number[], listId: number, userId: number) {
  if (contactIds.length === 0) return;
  assertOwned(await xanoFetch(`/mkt_contact_lists/${listId}`), userId, "Lista");
  const ownedContacts = await Promise.all(contactIds.map(id => getContactById(id, userId)));
  if (ownedContacts.some(contact => !contact)) throw new Error("Um ou mais contatos não pertencem ao usuário.");
  
  // 1. Busca quem já está na lista
  const existingMembers = await xanoArray(`/mkt_contact_list_members?list_id=${listId}`);
  const alreadyInList = new Set(existingMembers.filter((m: any) => hasSameId(m.list_id, listId)).map((m: any) => Number(m.contact_id)));
  const idsToAdd = Array.from(new Set(contactIds.map(Number))).filter(id => !alreadyInList.has(id));

  // 3. Adiciona os novos
  if (idsToAdd.length > 0) {
    await Promise.all(idsToAdd.map(cid => xanoChecked('/mkt_contact_list_members', 'POST', { contact_id: cid, list_id: listId })));
  }
  
  await recalcListCount(listId);
}

export async function removeContactFromList(contactId: number, listId: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contact_lists/${listId}`), userId, "Lista");
  if (!await getContactById(contactId, userId)) throw new Error("Contato não encontrado ou sem permissão.");
  const members = await xanoArray(`/mkt_contact_list_members?list_id=${listId}`);
  const targets = members.filter((m: any) => hasSameId(m.list_id, listId) && hasSameId(m.contact_id, contactId));
  await Promise.all(targets.map(target => xanoChecked(`/mkt_contact_list_members/${target.id}`, 'DELETE')));
  await recalcListCount(listId);
}

export async function getContactListsForContact(contactId: number, userId: number) {
  if (!await getContactById(contactId, userId)) return [];
  const members = await xanoArray(`/mkt_contact_list_members?contact_id=${contactId}`);
  if (members.length === 0) return [];
  const listIds = new Set(members.filter((m: any) => hasSameId(m.contact_id, contactId)).map((m: any) => Number(m.list_id)));
  const allLists = await xanoArray('/mkt_contact_lists');
  return allLists.filter((l: any) => belongsToUser(l, userId) && listIds.has(Number(l.id))).map(mapToApp);
}

export async function getListContacts(listId: number, userId: number) {
  assertOwned(await xanoChecked(`/mkt_contact_lists/${listId}`), userId, 'Lista');
  const [members, contacts] = await Promise.all([
    xanoArray(`/mkt_contact_list_members?list_id=${listId}`),
    xanoArray(`/mkt_contacts?user_id=${userId}`),
  ]);
  return listRecipients(members, contacts, listId, userId).map(mapToApp);
}

// ============ CAMPAIGNS ============
export async function createCampaign(data: InsertCampaign) {
  const result = await xanoChecked('/mkt_campaigns', 'POST', mapToXano({
    ...data, status: data.status || 'draft', subjectConfirmed: false
  }));
  if (!Number.isInteger(Number(result?.id)) || Number(result.id) <= 0) throw new Error('O Xano não retornou o ID da campanha.');
  return { id: Number(result.id) };
}

export async function getCampaigns(userId: number) {
  const data = await xanoArray(`/mkt_campaigns?user_id=${userId}`);
  return data.filter(item => belongsToUser(item, userId)).map(mapToApp);
}

export async function getCampaignById(id: number, userId: number) {
  const result = await xanoChecked(`/mkt_campaigns/${id}`);
  return result && !result._error && belongsToUser(result, userId) ? mapToApp(result) : undefined;
}

export async function updateCampaign(id: number, userId: number, data: Partial<InsertCampaign>) {
  const existing = assertOwned(await xanoFetch(`/mkt_campaigns/${id}`), userId, "Campanha");
  const payload = { ...existing, ...mapToXano(data), mkt_campaigns_id: id, user_id: userId };
  delete payload.created_at;

  await xanoChecked(`/mkt_campaigns/${id}`, 'PATCH', payload);
}

export async function deleteCampaign(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_campaigns/${id}`), userId, "Campanha");
  await xanoChecked(`/mkt_campaigns/${id}`, 'DELETE');
}

export async function getCampaignAttachments(campaignId: number, userId: number) {
  if (!await getCampaignById(campaignId, userId)) return [];
  const data = await xanoArray(`/mkt_campaign_attachments?campaigns_id=${campaignId}`);
  return data.filter(item => Number(item.campaigns_id ?? item.campaign_id) === campaignId).map(mapToApp);
}

export async function addCampaignAttachment(data: any) {
  const result = await xanoChecked('/mkt_campaign_attachments', 'POST', mapToXano(data));
  return { id: result.id };
}

export async function getCampaignAttachmentById(id: number, userId: number) {
  const attachment = await xanoChecked(`/mkt_campaign_attachments/${id}`);
  const campaignId = Number(attachment?.campaigns_id ?? attachment?.campaign_id);
  if (!campaignId || !await getCampaignById(campaignId, userId)) {
    throw new Error("Anexo não encontrado ou sem permissão.");
  }
  return { ...mapToApp(attachment), campaignId };
}

export async function deleteCampaignAttachment(id: number, userId: number) {
  await getCampaignAttachmentById(id, userId);
  await xanoChecked(`/mkt_campaign_attachments/${id}`, 'DELETE');
}

// ============ AUDIT LOGS E SMTP ============
export async function createAuditLog(data: InsertAuditLog) {
  await xanoFetch('/mkt_audit_logs', 'POST', mapToXano(data));
}

export async function getAuditLogs(userId: number, opts?: { page?: number; limit?: number; entityType?: string }) {
  let logs = await xanoArray(`/mkt_audit_logs?user_id=${userId}`);
  logs = logs.filter(log => belongsToUser(log, userId));
  if (opts?.entityType) logs = logs.filter((l: any) => l.entityType === opts.entityType);
  return { logs: logs.slice(0, opts?.limit ?? 50).map(mapToApp), total: logs.length };
}

export async function getSmtpSettings(userId: number) {
  const data = await xanoChecked(`/mkt_smtp_settings?user_id=${userId}`);
  const settings = Array.isArray(data)
    ? data.find(item => belongsToUser(item, userId))
    : (!data?._error && belongsToUser(data, userId) ? data : undefined);
  return settings ? mapToApp(settings) : undefined;
}

export async function upsertSmtpSettings(userId: number, data: Omit<InsertSmtpSettings, 'userId'>) {
  const existing = await getSmtpSettings(userId);
  if (existing?.id) {
    const raw = await xanoChecked(`/mkt_smtp_settings/${existing.id}`);
    const payload = { ...raw, ...mapToXano(data), mkt_smtp_settings_id: existing.id, user_id: userId, isActive: true };
    delete payload.created_at;
    await xanoChecked(`/mkt_smtp_settings/${existing.id}`, 'PATCH', payload);
    return { id: existing.id };
  }
  const result = await xanoChecked('/mkt_smtp_settings', 'POST', mapToXano({ ...data, user_id: userId, isActive: true }));
  if (!Number.isInteger(Number(result?.id)) || Number(result.id) <= 0) throw new Error('O Xano não retornou o ID das configurações SMTP.');
  return { id: result.id };
}

// ============ DASHBOARD STATS ============
export async function getDashboardStats(userId: number) {
  const [contacts, lists, campaigns] = await Promise.all([
    xanoArray(`/mkt_contacts?user_id=${userId}`),
    xanoArray(`/mkt_contact_lists?user_id=${userId}`),
    xanoArray(`/mkt_campaigns?user_id=${userId}`),
  ]);

  const ownedContacts = contacts.filter(item => belongsToUser(item, userId));
  const ownedLists = lists.filter(item => belongsToUser(item, userId));
  const ownedCampaigns = campaigns.filter(item => belongsToUser(item, userId));
  return {
    totalContacts: ownedContacts.length,
    totalLists: ownedLists.length,
    totalCampaigns: ownedCampaigns.length,
    sentCampaigns: ownedCampaigns.filter((c: any) => c.status === 'sent').length,
  };
}
