import { test } from "node:test";
import assert from "node:assert";
import { createApiKeyManager, ROLES } from "../../core/src/api-key-manager.js";

test("API Key Manager - create organization", () => {
  const km = createApiKeyManager();
  const org = km.createOrganization("Test Org", 50);

  assert(org.id.startsWith("org_"));
  assert.strictEqual(org.name, "Test Org");
  assert.strictEqual(org.quotaPerHour, 50);
  assert(org.createdAt);
});

test("API Key Manager - create API key for organization", () => {
  const km = createApiKeyManager();
  const org = km.createOrganization("Test Org");
  const apiKey = km.createApiKey(org.id, ROLES.USER);

  assert(apiKey.apiKey.startsWith("vri_"));
  assert.strictEqual(apiKey.orgId, org.id);
  assert.strictEqual(apiKey.role, ROLES.USER);
});

test("API Key Manager - validate API key", () => {
  const km = createApiKeyManager();
  const org = km.createOrganization("Test Org");
  const { apiKey } = km.createApiKey(org.id, ROLES.ADMIN);

  const keyData = km.validateApiKey(apiKey);
  assert(keyData);
  assert.strictEqual(keyData.orgId, org.id);
  assert.strictEqual(keyData.role, ROLES.ADMIN);
  assert(keyData.lastUsedAt);
});

test("API Key Manager - invalid API key returns null", () => {
  const km = createApiKeyManager();
  const keyData = km.validateApiKey("invalid_key");

  assert.strictEqual(keyData, null);
});

test("API Key Manager - role-based permissions", () => {
  const km = createApiKeyManager();

  assert(km.canPerform(ROLES.ADMIN, "register"));
  assert(km.canPerform(ROLES.ADMIN, "admin"));
  assert(km.canPerform(ROLES.USER, "register"));
  assert(!km.canPerform(ROLES.USER, "admin"));
  assert(!km.canPerform(ROLES.READONLY, "register"));
  assert(km.canPerform(ROLES.READONLY, "verify"));
});

test("API Key Manager - quota management", () => {
  const km = createApiKeyManager();
  const org = km.createOrganization("Test Org", 2);

  const quota1 = km.checkQuota(org.id);
  assert.strictEqual(quota1.remaining, 2);
  assert(quota1.allowed);

  assert(km.consumeQuota(org.id));
  const quota2 = km.checkQuota(org.id);
  assert.strictEqual(quota2.remaining, 1);

  assert(km.consumeQuota(org.id));
  const quota3 = km.checkQuota(org.id);
  assert.strictEqual(quota3.remaining, 0);
  assert(!quota3.allowed);

  assert(!km.consumeQuota(org.id));
});

test("API Key Manager - revoke API key", () => {
  const km = createApiKeyManager();
  const org = km.createOrganization("Test Org");
  const { apiKey } = km.createApiKey(org.id);

  assert(km.validateApiKey(apiKey));
  assert(km.revokeApiKey(apiKey));
  assert(!km.validateApiKey(apiKey));
});

test("API Key Manager - error on organization not found", () => {
  const km = createApiKeyManager();

  assert.throws(() => {
    km.createApiKey("invalid_org");
  }, /Organization invalid_org does not exist/);
});
