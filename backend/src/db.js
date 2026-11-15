import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'eldercare.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
 relationship TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profiles (
 id TEXT PRIMARY KEY, full_name TEXT NOT NULL, dob TEXT, phone TEXT, address TEXT,
 emergency_contact TEXT, conditions TEXT DEFAULT '[]', allergies TEXT DEFAULT '[]',
 doctor_name TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS memberships (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
 role TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
 UNIQUE(user_id, profile_id)
);
CREATE TABLE IF NOT EXISTS medications (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL, dosage TEXT NOT NULL,
 frequency TEXT NOT NULL, times TEXT NOT NULL, food_instruction TEXT DEFAULT '', start_date TEXT, end_date TEXT,
 doctor TEXT DEFAULT '', instructions TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS medication_events (
 id TEXT PRIMARY KEY, medication_id TEXT NOT NULL REFERENCES medications(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
 scheduled_time TEXT NOT NULL, recorded_time TEXT, recorded_by TEXT NOT NULL, status TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'self-reported', notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS appointments (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), doctor TEXT NOT NULL, specialty TEXT DEFAULT '',
 clinic TEXT DEFAULT '', appointment_at TEXT NOT NULL, location TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'scheduled',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS health_readings (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), parameter TEXT NOT NULL, value REAL NOT NULL,
 secondary_value REAL, unit TEXT NOT NULL, recorded_at TEXT NOT NULL, recorded_by TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'manual', note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS thresholds (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), parameter TEXT NOT NULL,
 min_value REAL, max_value REAL, enabled INTEGER NOT NULL DEFAULT 1, configured_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), category TEXT NOT NULL, title TEXT NOT NULL,
 message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', severity TEXT DEFAULT 'info', related_id TEXT,
 acknowledged_by TEXT, acknowledged_at TEXT, resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS observations (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), author_id TEXT NOT NULL, note TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), title TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT
);
CREATE TABLE IF NOT EXISTS documents (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL, type TEXT NOT NULL,
 description TEXT DEFAULT '', storage_name TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS summaries (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), summary_date TEXT NOT NULL,
 patient_summary TEXT NOT NULL, family_summary TEXT NOT NULL, caregiver_summary TEXT NOT NULL,
 generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(profile_id, summary_date)
);
CREATE TABLE IF NOT EXISTS sos_events (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), activated_by TEXT NOT NULL,
 latitude REAL, longitude REAL, location_status TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, acknowledged_by TEXT, acknowledged_at TEXT, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), recipient_id TEXT,
 category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempted_at TEXT, delivery_result TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notification_preferences (
 user_id TEXT NOT NULL REFERENCES users(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
 email_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id, profile_id)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
 id TEXT PRIMARY KEY, notification_id TEXT NOT NULL REFERENCES notifications(id), recipient_id TEXT NOT NULL REFERENCES users(id),
 channel TEXT NOT NULL DEFAULT 'email', status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, attempted_at TEXT NOT NULL, result TEXT DEFAULT '',
 UNIQUE(notification_id, recipient_id, channel)
);
CREATE TABLE IF NOT EXISTS timeline (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), category TEXT NOT NULL,
 title TEXT NOT NULL, description TEXT DEFAULT '', actor_id TEXT, related_id TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS escalation_events (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), alert_id TEXT NOT NULL REFERENCES alerts(id),
 stage TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(alert_id, stage, recipient_id)
);
CREATE TABLE IF NOT EXISTS family_members (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), name TEXT NOT NULL,
 relationship TEXT NOT NULL, user_id TEXT REFERENCES users(id), photo_storage TEXT, photo_mime TEXT,
 active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS family_pass_challenges (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
 targets_json TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profile_preferences (
 user_id TEXT NOT NULL REFERENCES users(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
 language TEXT NOT NULL DEFAULT 'en', text_scale TEXT NOT NULL DEFAULT 'normal', high_contrast INTEGER NOT NULL DEFAULT 0,
 simple_mode INTEGER NOT NULL DEFAULT 0, voice_assistance INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id, profile_id)
);
CREATE TABLE IF NOT EXISTS escalation_settings (
 profile_id TEXT PRIMARY KEY REFERENCES profiles(id), primary_minutes INTEGER NOT NULL DEFAULT 15,
 secondary_minutes INTEGER NOT NULL DEFAULT 30, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS device_integrations (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), provider TEXT NOT NULL,
 device_type TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), actor_id TEXT NOT NULL,
 action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, details_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS profile_invites (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), email TEXT NOT NULL,
 role TEXT NOT NULL, permissions_json TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 invited_by TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS passkeys (
 credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), public_key TEXT NOT NULL,
 counter INTEGER NOT NULL DEFAULT 0, transports_json TEXT NOT NULL DEFAULT '[]', device_type TEXT DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), challenge TEXT NOT NULL,
 flow TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meds_profile ON medications(profile_id, active);
CREATE INDEX IF NOT EXISTS idx_events_profile_time ON medication_events(profile_id, scheduled_time DESC);
CREATE INDEX IF NOT EXISTS idx_readings_profile_time ON health_readings(profile_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_profile_time ON timeline(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_family_profile ON family_members(profile_id, active);
CREATE INDEX IF NOT EXISTS idx_audit_profile_time ON audit_logs(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_email_status ON profile_invites(email, status);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
`);

const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (count === 0) {
  const insertUser = db.prepare('INSERT INTO users(id,email,name,role,relationship) VALUES(?,?,?,?,?)');
  insertUser.run('patient-demo','patient@eldercare.demo','Mr. Rao','patient','Self');
  insertUser.run('caregiver-demo','caregiver@eldercare.demo','Meera','caregiver','Primary caregiver');
  insertUser.run('family-demo','family@eldercare.demo','Ananya Rao','family','Daughter');
  db.prepare(`INSERT INTO profiles(id,full_name,dob,phone,address,emergency_contact,conditions,allergies,doctor_name)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('rao-profile','Mr. Rao','1954-03-18','+91 90000 10001','Warangal, Telangana','Ananya · +91 90000 10002',JSON.stringify(['Hypertension (demo profile)']),JSON.stringify(['None recorded']), 'Dr. S. Kumar');
  const patientPerms = JSON.stringify(['read','medication:write','event:write','appointment:write','reading:write','document:write','chat:write','observation:write','alert:manage','sos:manage','membership:manage','family:manage','profile:manage','devices:manage','escalation:manage','preferences:manage']);
  const caregiverPerms = JSON.stringify(['read','medication:write','event:write','appointment:write','reading:write','document:write','chat:write','observation:write','alert:manage','sos:manage','devices:manage','escalation:manage']);
  db.prepare('INSERT INTO memberships(user_id,profile_id,role,permissions) VALUES(?,?,?,?)').run('patient-demo','rao-profile','patient',patientPerms);
  db.prepare('INSERT INTO memberships(user_id,profile_id,role,permissions) VALUES(?,?,?,?)').run('caregiver-demo','rao-profile','caregiver',caregiverPerms);
  db.prepare('INSERT INTO memberships(user_id,profile_id,role,permissions) VALUES(?,?,?,?)').run('family-demo','rao-profile','family',JSON.stringify(['read','event:write','chat:write','observation:write','sos:manage']));
  const addFamily = db.prepare('INSERT INTO family_members(id,profile_id,name,relationship,user_id,created_by) VALUES(?,?,?,?,?,?)');
  addFamily.run('family-ananya','rao-profile','Ananya','Daughter','family-demo','patient-demo');
  addFamily.run('family-arjun','rao-profile','Arjun','Son',null,'patient-demo');
  addFamily.run('family-rohan','rao-profile','Rohan','Grandson',null,'patient-demo');
  db.prepare('INSERT INTO escalation_settings(profile_id,primary_minutes,secondary_minutes,updated_by) VALUES(?,?,?,?)').run('rao-profile',15,30,'patient-demo');

  const now = new Date();
  const day = now.toISOString().slice(0,10);
  const addMed = db.prepare(`INSERT INTO medications(id,profile_id,name,dosage,frequency,times,food_instruction,start_date,doctor,instructions,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  addMed.run('med-bp','rao-profile','Amlodipine','5 mg','Once daily',JSON.stringify(['08:00']),'After food',day,'Dr. S. Kumar','Demo schedule — follow the treating clinician’s actual prescription.','caregiver-demo');
  addMed.run('med-vit','rao-profile','Vitamin D3','1000 IU','Once daily',JSON.stringify(['20:00']),'After dinner',day,'Dr. S. Kumar','Demonstration schedule only.','caregiver-demo');
  const addEvent = db.prepare(`INSERT INTO medication_events(id,medication_id,profile_id,scheduled_time,recorded_time,recorded_by,status,source,notes)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  addEvent.run('evt-bp','med-bp','rao-profile',`${day}T08:00:00`,`${day}T08:05:00`,'patient-demo','taken','self-reported','Demo event');
  addEvent.run('evt-vit','med-vit','rao-profile',`${day}T20:00:00`,null,'patient-demo','scheduled','system','Demo event');
  const addReading = db.prepare(`INSERT INTO health_readings(id,profile_id,parameter,value,secondary_value,unit,recorded_at,recorded_by,source,note) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const values = [
    ['bp1','blood_pressure',126,82,'mmHg'],['hr1','heart_rate',74,null,'bpm'],['gl1','blood_glucose',108,null,'mg/dL'],['sp1','spo2',98,null,'%'],['tp1','temperature',36.8,null,'°C']
  ];
  for (const [id,p,v,s,u] of values) addReading.run(id,'rao-profile',p,v,s,u,now.toISOString(),'caregiver-demo','demo','Sample demonstration data — not a real patient measurement.');
  const addAppt = db.prepare('INSERT INTO appointments(id,profile_id,doctor,specialty,clinic,appointment_at,location,notes,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
  addAppt.run('appt1','rao-profile','Dr. S. Kumar','Cardiology','City Care Clinic',new Date(now.getTime()+3*86400000).toISOString(),'Warangal','Routine follow-up (demo)','scheduled','family-demo');
  db.prepare('INSERT INTO conversations(id,profile_id,title) VALUES(?,?,?)').run('conv1','rao-profile','Family care group');
  db.prepare('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES(?,?,?,?)').run('msg1','conv1','family-demo','Good morning! Please let me know how the morning is going.');
  db.prepare('INSERT INTO messages(id,conversation_id,sender_id,body) VALUES(?,?,?,?)').run('msg2','conv1','caregiver-demo','All good. The morning medicine has been recorded.');
  db.prepare('INSERT INTO observations(id,profile_id,author_id,note) VALUES(?,?,?,?)').run('obs1','rao-profile','caregiver-demo','Mr. Rao was comfortable during the morning check-in. (Demo observation)');
  db.prepare('INSERT INTO timeline(id,profile_id,category,title,description,actor_id) VALUES(?,?,?,?,?,?)').run('tl1','rao-profile','system','ElderCare demo profile created','Sample profile and sample readings are clearly marked.','caregiver-demo');
}

export function json(value, fallback = []) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
