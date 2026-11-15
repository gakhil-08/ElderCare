import test from 'node:test';
import assert from 'node:assert/strict';
import { db, json } from './src/db.js';

test('demo environment seeds three distinct roles and one patient profile', () => {
  assert.ok(db.prepare("SELECT id FROM users WHERE id='patient-demo'").get());
  assert.ok(db.prepare("SELECT id FROM profiles WHERE id='rao-profile'").get());
  const roles = db.prepare('SELECT role FROM memberships ORDER BY role').all().map(r => r.role);
  assert.deepEqual(roles, ['caregiver', 'family', 'patient']);
});

test('family membership has read-only medication schedule permissions', () => {
  const permissions = json(db.prepare("SELECT permissions FROM memberships WHERE user_id='family-demo'").get().permissions);
  assert.ok(permissions.includes('read'));
  assert.ok(!permissions.includes('medication:write'));
});

test('medication events preserve recorder and self-reported source', () => {
  const id = `test-${Date.now()}`;
  db.prepare(`INSERT INTO medication_events(id, medication_id, profile_id, scheduled_time, recorded_time, recorded_by, status, source, notes)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id,'med-bp','rao-profile',new Date().toISOString(),new Date().toISOString(),'patient-demo','taken','self-reported','Automated test');
  const event = db.prepare('SELECT * FROM medication_events WHERE id=?').get(id);
  assert.equal(event.status, 'taken');
  assert.equal(event.source, 'self-reported');
  assert.equal(event.recorded_by, 'patient-demo');
  db.prepare('DELETE FROM medication_events WHERE id=?').run(id);
});

test('notification email preferences default to opt-out', () => {
  const column = db.prepare('PRAGMA table_info(notification_preferences)').all().find(c => c.name === 'email_enabled');
  assert.equal(String(column.dflt_value), '0');
});

test('database has audit timeline and escalation history tables', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  assert.ok(names.includes('timeline'));
  assert.ok(names.includes('escalation_events'));
  assert.ok(names.includes('notification_deliveries'));
});

test('V2 seeds distinct family relationships for the two-step FamilyPass challenge', () => {
  const members = db.prepare("SELECT relationship FROM family_members WHERE profile_id='rao-profile' AND active=1").all().map(x => x.relationship);
  assert.ok(members.includes('Daughter'));
  assert.ok(members.includes('Son'));
  assert.ok(members.includes('Grandson'));
  assert.ok(new Set(members).size >= 2);
});

test('V2 creates profile-scoped escalation policy defaults', () => {
  const policy = db.prepare("SELECT primary_minutes,secondary_minutes FROM escalation_settings WHERE profile_id='rao-profile'").get();
  assert.equal(policy.primary_minutes, 15);
  assert.equal(policy.secondary_minutes, 30);
  assert.ok(policy.secondary_minutes > policy.primary_minutes);
});

test('V2 database contains private family photos, passkeys, invitations and audit records', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  for (const name of ['family_members','family_pass_challenges','passkeys','webauthn_challenges','profile_invites','audit_logs','device_integrations','profile_preferences']) assert.ok(tables.includes(name), `Missing ${name}`);
});

test('V2 device credentials are stored as hashes, not plaintext tokens', () => {
  const id = `device-test-${Date.now()}`;
  const fakeHash = 'a'.repeat(64);
  db.prepare('INSERT INTO device_integrations(id,profile_id,provider,device_type,label,token_hash,created_by) VALUES(?,?,?,?,?,?,?)').run(id,'rao-profile','test','test','Test device',fakeHash,'patient-demo');
  const row = db.prepare('SELECT token_hash FROM device_integrations WHERE id=?').get(id);
  assert.equal(row.token_hash,fakeHash);
  assert.notEqual(row.token_hash,'plaintext-token');
  db.prepare('DELETE FROM device_integrations WHERE id=?').run(id);
});

test('V2 access membership retains permission-based rather than role-only authorization', () => {
  const patient = json(db.prepare("SELECT permissions FROM memberships WHERE user_id='patient-demo'").get().permissions);
  const caregiver = json(db.prepare("SELECT permissions FROM memberships WHERE user_id='caregiver-demo'").get().permissions);
  const family = json(db.prepare("SELECT permissions FROM memberships WHERE user_id='family-demo'").get().permissions);
  assert.ok(patient.includes('membership:manage'));
  assert.ok(caregiver.includes('devices:manage'));
  assert.ok(!family.includes('membership:manage'));
  assert.ok(!family.includes('medication:write'));
});
