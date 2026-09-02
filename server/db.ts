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
    const result = await response.json();
    if (!response.ok) {
      console.warn(`[Xano] ${method} ${endpoint} → ${response.status}`, result);
      return { _error: true, status: response.status, ...result };
    }
    return result;
  } catch (error) {
    console.error(`[Xano] Falha de rede em ${endpoint}:`, error);
    return { _error: true };
  }
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

function assertOwned(record: any, userId: number, entity: string) {
  if (!record || record._error || !belongsToUser(record, userId)) {
    throw new Error(`${entity} não encontrado ou sem permissão.`);
  }
  return record;
}

// ============ CONTACT LISTS ============
export async function createContactList(data: InsertContactList) {
  const result = await xanoFetch('/mkt_contact_lists', 'POST', mapToXano({ ...data, contactCount: 0 }));
  return { id: result.id };
}

// 🔥 CONTAGEM DINÂMICA: Conta os contatos reais na hora que a tela carrega!
export async function getContactLists(userId: number) {
  const lists = await xanoFetch(`/mkt_contact_lists?user_id=${userId}`);
  if (!Array.isArray(lists)) return [];
  const ownedLists = lists.filter(list => belongsToUser(list, userId));

  // Busca todos os membros de uma vez e distribui a contagem
  const allMembers = await xanoFetch(`/mkt_contact_list_members`);
  if (Array.isArray(allMembers)) {
    ownedLists.forEach(list => {
      // Conta na hora quantos contatos estão vinculados a esta lista
      list.contactCount = allMembers.filter((m: any) => m.list_id === list.id).length;
    });
  }

  return ownedLists.map(mapToApp);
}

export async function getContactListById(id: number, userId: number) {
  const list = await xanoFetch(`/mkt_contact_lists/${id}`);
  if (!list || list._error || !belongsToUser(list, userId)) return undefined;

  // Conta os membros na hora para esta lista específica
  const members = await xanoFetch(`/mkt_contact_list_members?list_id=${id}`);
  if (Array.isArray(members)) {
    list.contactCount = members.filter((m: any) => m.list_id == id).length;
  }

  return mapToApp(list);
}

export async function updateContactList(id: number, userId: number, data: Partial<InsertContactList>) {
  const existing = assertOwned(await xanoFetch(`/mkt_contact_lists/${id}`), userId, "Lista");
  const payload = { ...existing, ...mapToXano(data), mkt_contact_lists_id: id, user_id: userId };
  delete payload.created_at;
  await xanoFetch(`/mkt_contact_lists/${id}`, 'PATCH', payload);
}

export async function deleteContactList(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contact_lists/${id}`), userId, "Lista");
  await xanoFetch(`/mkt_contact_lists/${id}`, 'DELETE');
}

export async function recalcListCount(listId: number) {
  try {
    const members = await xanoFetch(`/mkt_contact_list_members?list_id=${listId}`);
    const count = Array.isArray(members) ? members.filter((m: any) => m.list_id == listId).length : 0;
    
    const existing = await xanoFetch(`/mkt_contact_lists/${listId}`);
    if (existing && !existing._error) {
      const payload = { ...existing, contactCount: count, mkt_contact_lists_id: listId };
      delete payload.created_at;
      await xanoFetch(`/mkt_contact_lists/${listId}`, 'PATCH', payload);
    }
  } catch (e) {}
}

// ============ CONTACTS ============
export async function createContact(data: InsertContact) {
  const result = await xanoFetch('/mkt_contacts', 'POST', mapToXano({ ...data, subscribed: true }));
  return { id: result.id || Math.floor(Math.random() * 1000) };
}

export async function bulkCreateContacts(dataArr: InsertContact[]) {
  if (dataArr.length === 0) return [];
  const results = await Promise.all(
    dataArr.map(c => xanoFetch('/mkt_contacts', 'POST', mapToXano({ ...c, subscribed: true })))
  );
  return results.filter(r => !r._error).map(r => ({ id: r.id }));
}

export async function getContacts(userId: number, opts?: { search?: string; listId?: number; page?: number; limit?: number }) {
  let contacts = await xanoFetch(`/mkt_contacts?user_id=${userId}`);
  if (!Array.isArray(contacts)) return { contacts: [], total: 0 };
  contacts = contacts.filter(contact => belongsToUser(contact, userId));

  if (opts?.listId) {
    const members = await xanoFetch(`/mkt_contact_list_members?list_id=${opts.listId}`);
    const memberIds = Array.isArray(members) ? members.map((m: any) => m.contact_id) : [];
    contacts = contacts.filter((c: any) => memberIds.includes(c.id));
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
  await xanoFetch(`/mkt_contacts/${id}`, 'PATCH', payload);
}

export async function deleteContact(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contacts/${id}`), userId, "Contato");
  await xanoFetch(`/mkt_contacts/${id}`, 'DELETE');
}

// 🔥 ANTI-DUPLICIDADE: Verifica antes de adicionar para o Xano não bloquear
export async function addContactsToList(contactIds: number[], listId: number, userId: number) {
  if (contactIds.length === 0) return;
  assertOwned(await xanoFetch(`/mkt_contact_lists/${listId}`), userId, "Lista");
  const ownedContacts = await Promise.all(contactIds.map(id => getContactById(id, userId)));
  if (ownedContacts.some(contact => !contact)) throw new Error("Um ou mais contatos não pertencem ao usuário.");
  
  // 1. Busca quem já está na lista
  const existingMembers = await xanoFetch(`/mkt_contact_list_members?list_id=${listId}`);
  let idsToAdd = contactIds;
  
  if (Array.isArray(existingMembers)) {
    const alreadyInList = new Set(existingMembers.map((m: any) => m.contact_id));
    // 2. Filtra e só adiciona quem ainda NÃO está na lista
    idsToAdd = contactIds.filter(id => !alreadyInList.has(id));
  }

  // 3. Adiciona os novos
  if (idsToAdd.length > 0) {
    await Promise.all(idsToAdd.map(cid => xanoFetch('/mkt_contact_list_members', 'POST', { contact_id: cid, list_id: listId })));
  }
  
  await recalcListCount(listId);
}

export async function removeContactFromList(contactId: number, listId: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_contact_lists/${listId}`), userId, "Lista");
  if (!await getContactById(contactId, userId)) throw new Error("Contato não encontrado ou sem permissão.");
  const members = await xanoFetch(`/mkt_contact_list_members?list_id=${listId}`);
  if (Array.isArray(members)) {
    const target = members.find((m: any) => m.contact_id === contactId);
    if (target) await xanoFetch(`/mkt_contact_list_members/${target.id}`, 'DELETE');
  }
  await recalcListCount(listId);
}

export async function getContactListsForContact(contactId: number, userId: number) {
  if (!await getContactById(contactId, userId)) return [];
  const members = await xanoFetch(`/mkt_contact_list_members?contact_id=${contactId}`);
  if (!Array.isArray(members) || members.length === 0) return [];
  const listIds = members.map((m: any) => m.list_id);
  const allLists = await xanoFetch('/mkt_contact_lists');
  return Array.isArray(allLists)
    ? allLists.filter((l: any) => belongsToUser(l, userId) && listIds.includes(l.id)).map(mapToApp)
    : [];
}

export async function getListContacts(listId: number, userId: number) {
  const list = await getContactListById(listId, userId);
  if (!list) return [];
  const members = await xanoFetch(`/mkt_contact_list_members?list_id=${listId}`);
  if (!Array.isArray(members) || members.length === 0) return [];

  // Endpoints genéricos do Xano podem ignorar query params e devolver todos os
  // vínculos. Reaplicamos o filtro antes de montar os destinatários da campanha.
  const contactIds = new Set(
    members
      .filter((member: any) => Number(member.list_id) === listId)
      .map((member: any) => Number(member.contact_id))
  );
  if (contactIds.size === 0) return [];

  const allContacts = await xanoFetch('/mkt_contacts');
  return Array.isArray(allContacts)
    ? allContacts
        .filter((contact: any) => contactIds.has(Number(contact.id)) && belongsToUser(contact, userId) && isSubscribed(contact.subscribed))
        .map(mapToApp)
    : [];
}

// ============ CAMPAIGNS ============
export async function createCampaign(data: InsertCampaign) {
  const result = await xanoFetch('/mkt_campaigns', 'POST', mapToXano({
    ...data, status: data.status || 'draft', subjectConfirmed: false
  }));
  return { id: result.id || Math.floor(Math.random() * 1000) };
}

export async function getCampaigns(userId: number) {
  const data = await xanoFetch(`/mkt_campaigns?user_id=${userId}`);
  return Array.isArray(data) ? data.filter(item => belongsToUser(item, userId)).map(mapToApp) : [];
}

export async function getCampaignById(id: number, userId: number) {
  const result = await xanoFetch(`/mkt_campaigns/${id}`);
  return result && !result._error && belongsToUser(result, userId) ? mapToApp(result) : undefined;
}

export async function updateCampaign(id: number, userId: number, data: Partial<InsertCampaign>) {
  const existing = assertOwned(await xanoFetch(`/mkt_campaigns/${id}`), userId, "Campanha");
  const payload = { ...existing, ...mapToXano(data), mkt_campaigns_id: id, user_id: userId };
  delete payload.created_at;

  const res = await xanoFetch(`/mkt_campaigns/${id}`, 'PATCH', payload);
  if (res._error) throw new Error("Erro ao salvar no Xano");
}

export async function deleteCampaign(id: number, userId: number) {
  assertOwned(await xanoFetch(`/mkt_campaigns/${id}`), userId, "Campanha");
  await xanoFetch(`/mkt_campaigns/${id}`, 'DELETE');
}

export async function getCampaignAttachments(campaignId: number, userId: number) {
  if (!await getCampaignById(campaignId, userId)) return [];
  const data = await xanoFetch(`/mkt_campaign_attachments?campaigns_id=${campaignId}`);
  return Array.isArray(data)
    ? data.filter(item => Number(item.campaigns_id ?? item.campaign_id) === campaignId).map(mapToApp)
    : [];
}

export async function addCampaignAttachment(data: any) {
  const result = await xanoFetch('/mkt_campaign_attachments', 'POST', mapToXano(data));
  return { id: result.id };
}

export async function deleteCampaignAttachment(id: number, userId: number) {
  const attachment = await xanoFetch(`/mkt_campaign_attachments/${id}`);
  const campaignId = Number(attachment?.campaigns_id ?? attachment?.campaign_id);
  if (!campaignId || !await getCampaignById(campaignId, userId)) {
    throw new Error("Anexo não encontrado ou sem permissão.");
  }
  await xanoFetch(`/mkt_campaign_attachments/${id}`, 'DELETE');
}

// ============ AUDIT LOGS E SMTP ============
export async function createAuditLog(data: InsertAuditLog) {
  await xanoFetch('/mkt_audit_logs', 'POST', mapToXano(data));
}

export async function getAuditLogs(userId: number, opts?: { page?: number; limit?: number; entityType?: string }) {
  let logs = await xanoFetch(`/mkt_audit_logs?user_id=${userId}`);
  if (!Array.isArray(logs)) return { logs: [], total: 0 };
  logs = logs.filter(log => belongsToUser(log, userId));
  if (opts?.entityType) logs = logs.filter((l: any) => l.entityType === opts.entityType);
  return { logs: logs.slice(0, opts?.limit ?? 50).map(mapToApp), total: logs.length };
}

export async function getSmtpSettings(userId: number) {
  const data = await xanoFetch(`/mkt_smtp_settings?user_id=${userId}`);
  const settings = Array.isArray(data)
    ? data.find(item => belongsToUser(item, userId))
    : (!data?._error && belongsToUser(data, userId) ? data : undefined);
  return settings ? mapToApp(settings) : undefined;
}

export async function upsertSmtpSettings(userId: number, data: Omit<InsertSmtpSettings, 'userId'>) {
  const existing = await getSmtpSettings(userId);
  if (existing?.id) {
    const raw = await xanoFetch(`/mkt_smtp_settings/${existing.id}`);
    const payload = { ...raw, ...mapToXano(data), mkt_smtp_settings_id: existing.id, user_id: userId, isActive: true };
    delete payload.created_at;
    await xanoFetch(`/mkt_smtp_settings/${existing.id}`, 'PATCH', payload);
    return { id: existing.id };
  }
  const result = await xanoFetch('/mkt_smtp_settings', 'POST', mapToXano({ ...data, user_id: userId, isActive: true }));
  return { id: result.id };
}

// ============ DASHBOARD STATS ============
export async function getDashboardStats(userId: number) {
  const [contacts, lists, campaigns] = await Promise.all([
    xanoFetch(`/mkt_contacts?user_id=${userId}`),
    xanoFetch(`/mkt_contact_lists?user_id=${userId}`),
    xanoFetch(`/mkt_campaigns?user_id=${userId}`),
  ]);

  const ownedContacts = Array.isArray(contacts) ? contacts.filter(item => belongsToUser(item, userId)) : [];
  const ownedLists = Array.isArray(lists) ? lists.filter(item => belongsToUser(item, userId)) : [];
  const ownedCampaigns = Array.isArray(campaigns) ? campaigns.filter(item => belongsToUser(item, userId)) : [];
  return {
    totalContacts: ownedContacts.length,
    totalLists: ownedLists.length,
    totalCampaigns: ownedCampaigns.length,
    sentCampaigns: ownedCampaigns.filter((c: any) => c.status === 'sent').length,
  };
}
