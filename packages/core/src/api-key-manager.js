/**
 * API Key Manager for beta authentication and multitenancy
 * Manages API keys, organizations, and access control
 */

import crypto from 'node:crypto';

export const ROLES = {
  ADMIN: 'admin',
  USER: 'user',
  READONLY: 'readonly'
};

export class ApiKeyManager {
  #keys = new Map(); // key -> { id, orgId, role, createdAt, expiresAt, lastUsedAt }
  #orgs = new Map(); // orgId -> { id, name, createdAt, quotaRemaining, quotaRefreshAt }

  constructor(options = {}) {
    this.#keys = options.keys ?? new Map();
    this.#orgs = options.orgs ?? new Map();
  }

  /**
   * Create a new API key for an organization
   * @param {string} orgId - Organization ID
   * @param {string} role - Role (admin, user, readonly)
   * @param {object} [options]
   * @param {number} [options.ttlDays=90] - Key lifetime in days (default 90)
   * @returns {object} { apiKey, id, orgId, role, createdAt, expiresAt }
   */
  createApiKey(orgId, role = ROLES.USER, options = {}) {
    if (!this.#orgs.has(orgId)) {
      throw new Error(`Organization ${orgId} does not exist`);
    }

    if (!Object.values(ROLES).includes(role)) {
      throw new Error(`Invalid role: ${role}`);
    }

    const apiKey = this.#generateKey();
    const id = `key_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const ttlDays = options.ttlDays ?? 90;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

    this.#keys.set(apiKey, {
      id,
      orgId,
      role,
      createdAt,
      expiresAt,
      lastUsedAt: null
    });

    return { apiKey, id, orgId, role, createdAt, expiresAt };
  }

  /**
   * Validate an API key
   * @param {string} apiKey - API key from Authorization header
   * @returns {object|null} Key metadata if valid, null otherwise
   */
  validateApiKey(apiKey) {
    if (!apiKey) {
      return null;
    }

    const keyData = this.#keys.get(apiKey);
    if (!keyData) {
      return null;
    }

    if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
      return null; // Key expired
    }

    // Update last used time
    keyData.lastUsedAt = new Date().toISOString();

    return keyData;
  }

  /**
   * Check if a role has permission for an action
   * @param {string} role - Role to check
   * @param {string} action - Action to check (register, verify, publish, admin)
   * @returns {boolean}
   */
  canPerform(role, action) {
    const permissions = {
      [ROLES.ADMIN]: ['register', 'verify', 'publish', 'admin', 'query'],
      [ROLES.USER]: ['register', 'verify', 'publish', 'query'],
      [ROLES.READONLY]: ['query', 'verify']
    };

    return (permissions[role] ?? []).includes(action);
  }

  /**
   * Create a new organization
   * @param {string} name - Organization name
   * @param {number} quotaPerHour - Registrations allowed per hour
   * @returns {object} { id, name, createdAt, quotaPerHour }
   */
  createOrganization(name, quotaPerHour = 100) {
    const orgId = `org_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.#orgs.set(orgId, {
      id: orgId,
      name,
      createdAt,
      quotaPerHour,
      quotaRemaining: quotaPerHour,
      quotaRefreshAt: new Date(Date.now() + 3600000).toISOString()
    });

    return { id: orgId, name, createdAt, quotaPerHour };
  }

  /**
   * Get organization by ID
   * @param {string} orgId - Organization ID
   * @returns {object|null}
   */
  getOrganization(orgId) {
    return this.#orgs.get(orgId) ?? null;
  }

  /**
   * Check quota for an organization
   * @param {string} orgId - Organization ID
   * @returns {object} { allowed, remaining, nextResetAt }
   */
  checkQuota(orgId) {
    const org = this.#orgs.get(orgId);
    if (!org) {
      throw new Error(`Organization ${orgId} not found`);
    }

    const now = new Date();
    const resetAt = new Date(org.quotaRefreshAt);

    if (now >= resetAt) {
      org.quotaRemaining = org.quotaPerHour;
      org.quotaRefreshAt = new Date(Date.now() + 3600000).toISOString();
    }

    return {
      allowed: org.quotaRemaining > 0,
      remaining: org.quotaRemaining,
      nextResetAt: org.quotaRefreshAt
    };
  }

  /**
   * Consume quota
   * @param {string} orgId - Organization ID
   * @returns {boolean} true if quota available, false otherwise
   */
  consumeQuota(orgId) {
    const org = this.#orgs.get(orgId);
    if (!org) {
      return false;
    }

    const now = new Date();
    const resetAt = new Date(org.quotaRefreshAt);

    if (now >= resetAt) {
      org.quotaRemaining = org.quotaPerHour;
      org.quotaRefreshAt = new Date(Date.now() + 3600000).toISOString();
    }

    if (org.quotaRemaining > 0) {
      org.quotaRemaining--;
      return true;
    }

    return false;
  }

  #generateKey() {
    const randomPart = crypto.randomBytes(24).toString('base64url');
    const timestampPart = Date.now().toString(36);
    return `vri_${timestampPart}_${randomPart}`;
  }

  getKeyMetadata(apiKey) {
    return this.#keys.get(apiKey) ?? null;
  }

  revokeApiKey(apiKey) {
    return this.#keys.delete(apiKey);
  }

  getAllKeys() {
    const result = [];
    for (const [key, data] of this.#keys.entries()) {
      result.push({ apiKey: key.substring(0, 10) + '...', ...data });
    }
    return result;
  }

  getAllOrganizations() {
    return Array.from(this.#orgs.values());
  }
}

export function createApiKeyManager(options = {}) {
  return new ApiKeyManager(options);
}
