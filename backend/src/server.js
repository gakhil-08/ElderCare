import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, json } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 8080);
const isProd = process.env.NODE_ENV === 'production';
const demoEnabled = process.env.DEMO_MODE === 'true';
const tokenSecret = process.env.DEMO_TOKEN_SECRET || 'local-demo-only-change-this-secret';
const uploadDir = path.resolve(__dirname, '../uploads');
const familyPhotoDir = path.resolve(__dirname, '../family-photos');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(familyPhotoDir, { recursive: true });
const profileEvents = new EventEmitter();
profileEvents.setMaxListeners(0);
const streamTickets = new Map();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : (isProd ? false : true), credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

const uid = () => crypto.randomUUID();
const iso = () => new Date().toISOString();
const safe = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([,v]) => v !== undefined));
const demoUsers = {
  'patient@eldercare.demo': { id: 'patient-demo', password: 'Demo@123', name: 'Mr. Rao', role: 'patient' },
  'caregiver@eldercare.demo': { id: 'caregiver-demo', password: 'Demo@123', name: 'Meera', role: 'caregiver' },
  'family@eldercare.demo': { id: 'family-demo', password: 'Demo@123', name: 'Ananya Rao', role: 'family' }
};

function signDemoToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: user.id, email: user.email, name: user.name, role: user.role, demo: true, exp: Math.floor(Date.now()/1000)+60*60*12 })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', tokenSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}
function verifyDemoToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.demo || payload.exp < Date.now()/1000) return null;
    return payload;
  } catch { return null; }
}

let firebaseAuth = null;
let webauthn = null;
try { webauthn = await import('@simplewebauthn/server'); console.log('WebAuthn/passkey support enabled.'); } catch { console.warn('Passkey support unavailable until @simplewebauthn/server is installed.'); }
const webauthnRpId = process.env.WEBAUTHN_RP_ID || 'localhost';
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';
if (process.env.FIREBASE_PROJECT_ID) {
  try {
    const { initializeApp, applicationDefault, getApps } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const adminApp = getApps()[0] || initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
    firebaseAuth = getAuth(adminApp);
    console.log('Firebase Admin token verification enabled.');
  } catch (error) {
    console.warn('Firebase Admin could not initialize:', error.message);
  }
}

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  const demo = demoEnabled ? verifyDemoToken(token) : null;
  if (demo) { req.user = { id: demo.sub, email: demo.email, name: demo.name, role: demo.role, demo: true }; return next(); }
  if (firebaseAuth) {
    try {
      const decoded = await firebaseAuth.verifyIdToken(token);
      // Existing local members are matched by UID first, then by a verified email address.
      // Keep the database's membership key as the canonical ID; do not substitute a Firebase UID
      // unless the invitation flow created the local user row with that UID.
      let user = db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(decoded.uid);
      if (!user && decoded.email && decoded.email_verified) {
        user = db.prepare('SELECT id,email,name,role FROM users WHERE lower(email)=lower(?)').get(decoded.email);
      }
      if (!user) {
        if (!decoded.email || !decoded.email_verified) return res.status(403).json({ error: 'Verify your email address before accepting an ElderCare invitation.' });
        const invitation = db.prepare("SELECT role FROM profile_invites WHERE lower(email)=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(String(decoded.email).toLowerCase(), iso());
        if (!invitation) return res.status(403).json({ error: 'This authenticated account has no ElderCare membership or pending invitation.' });
        db.prepare('INSERT INTO users(id,email,name,role,relationship) VALUES(?,?,?,?,?)').run(decoded.uid,decoded.email,decoded.name||decoded.email,invitation.role,invitation.role==='family'?'Invited family member':'Invited caregiver');
        user = db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(decoded.uid);
      }
      req.user = { ...user, demo: false };
      return next();
    } catch { return res.status(401).json({ error: 'Invalid or expired authentication token.' }); }
  }
  return res.status(401).json({ error: 'Firebase Authentication is not configured for this deployment.' });
}

function membership(userId, profileId) {
  const row = db.prepare(`SELECT m.*, u.name AS user_name, u.email, u.role AS account_role
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.profile_id=? AND m.active=1`).get(userId, profileId);
  if (!row) return null;
  return { ...row, permissions: json(row.permissions) };
}
function access(req, res, profileId, permission = 'read') {
  const member = membership(req.user.id, profileId);
  if (!member) { res.status(403).json({ error: 'You do not have access to this elderly profile.' }); return null; }
  if (permission && !member.permissions.includes(permission) && !member.permissions.includes('*')) {
    res.status(403).json({ error: `Your profile permissions do not allow ${permission}.` }); return null;
  }
  return member;
}
function rowToObject(row) { return row ? { ...row } : null; }
function addTimeline(profileId, category, title, description = '', actorId = null, relatedId = null) {
  db.prepare('INSERT INTO timeline(id,profile_id,category,title,description,actor_id,related_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(uid(), profileId, category, title, description, actorId, relatedId, iso());
}
function auditTrail(profileId, actorId, action, entityType, entityId = null, details = {}) {
  db.prepare('INSERT INTO audit_logs(id,profile_id,actor_id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(uid(), profileId, actorId, action, entityType, entityId, JSON.stringify(details), iso());
}
function notifyProfile(profileId, event) { profileEvents.emit(`profile:${profileId}`, event); }
function addNotification(profileId, category, title, body, recipientId = null) {
  const id = uid();
  db.prepare('INSERT INTO notifications(id,profile_id,recipient_id,category,title,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, profileId, recipientId, category, title, body, 'queued', iso());
  return id;
}
async function sendEmail(to, subject, text) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !to) return { sent: false, reason: 'Email provider is not configured; notification remains in-app.' };
  try {
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (e) { return { sent: false, reason: e.message }; }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  const allowed = ['application/pdf','image/png','image/jpeg'];
  if (!allowed.includes(file.mimetype)) return cb(new Error('Only PDF, PNG and JPEG files are accepted.'));
  cb(null, true);
} });
const familyPhotoUpload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, familyPhotoDir), filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ['image/jpeg','image/png','image/webp'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Family photos must be JPEG, PNG or WebP images.'))
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'eldercare-api', time: iso(), database: 'sqlite', firebaseAuth: Boolean(firebaseAuth), demoMode: demoEnabled }));
app.post('/api/auth/demo-login', (req, res) => {
  if (!demoEnabled) return res.status(404).json({ error: 'Demo authentication is disabled.' });
  const { email, password } = req.body || {};
  const user = demoUsers[String(email || '').toLowerCase()];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Incorrect demo email or password.' });
  const account = db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(user.id);
  return res.json({ token: signDemoToken({ ...account, demo: true }), user: { ...account, demo: true } });
});
app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

// WebAuthn passkeys are optional when package support and a matching relying-party origin are configured.
app.get('/api/auth/passkeys/status', (_req,res) => res.json({available:Boolean(webauthn),rpId:webauthnRpId,notice:webauthn?'Passkey registration and sign-in are available on supported secure browser origins.':'Install the WebAuthn server package and configure the relying-party ID and origin.'}));
app.post('/api/auth/passkeys/login/options', async (req,res) => {
  if(!webauthn)return res.status(503).json({error:'Passkey support is not installed on this server.'});
  try {
    const email=String(req.body?.email||'').trim().toLowerCase(); const user=db.prepare('SELECT id,email FROM users WHERE lower(email)=?').get(email);
    if(!user)return res.status(404).json({error:'No passkey account is registered for that email.'});
    const credentials=db.prepare('SELECT credential_id,transports_json FROM passkeys WHERE user_id=?').all(user.id);
    if(!credentials.length)return res.status(404).json({error:'No passkey is registered for this account.'});
    const options=await webauthn.generateAuthenticationOptions({rpID:webauthnRpId,allowCredentials:credentials.map(c=>({id:c.credential_id,transports:json(c.transports_json)})),userVerification:'required'});
    const id=uid(); db.prepare('INSERT INTO webauthn_challenges(id,user_id,challenge,flow,expires_at) VALUES(?,?,?,?,?)').run(id,user.id,options.challenge,'login',new Date(Date.now()+5*60000).toISOString());
    res.json({challengeId:id,options});
  } catch (error) { console.error('Passkey authentication options error:', error.message); res.status(503).json({error:'Could not prepare a passkey challenge. Check relying-party configuration.'}); }
});
app.post('/api/auth/passkeys/login/verify', async (req,res) => {
  if(!webauthn)return res.status(503).json({error:'Passkey support is not installed on this server.'});
  const challenge=db.prepare("SELECT * FROM webauthn_challenges WHERE id=? AND flow='login'").get(req.body?.challengeId);
  if(!challenge||new Date(challenge.expires_at)<new Date())return res.status(410).json({error:'Passkey challenge expired. Start again.'});
  const credentialId=String(req.body?.response?.id||''); const credential=db.prepare('SELECT * FROM passkeys WHERE credential_id=? AND user_id=?').get(credentialId,challenge.user_id);
  if(!credential)return res.status(401).json({error:'Passkey credential was not found for this account.'});
  try{
    const verification=await webauthn.verifyAuthenticationResponse({response:req.body.response,expectedChallenge:challenge.challenge,expectedOrigin:webauthnOrigin,expectedRPID:webauthnRpId,credential:{id:credential.credential_id,publicKey:Buffer.from(credential.public_key,'base64'),counter:credential.counter,transports:json(credential.transports_json)}});
    if(!verification.verified)return res.status(401).json({error:'Passkey verification failed.'});
    db.prepare('UPDATE passkeys SET counter=?,last_used_at=? WHERE credential_id=?').run(verification.authenticationInfo.newCounter,iso(),credentialId);
    db.prepare('DELETE FROM webauthn_challenges WHERE id=?').run(challenge.id);
    const user=db.prepare('SELECT id,email,name,role FROM users WHERE id=?').get(challenge.user_id);
    if(firebaseAuth){const firebaseCustomToken=await firebaseAuth.createCustomToken(user.id);return res.json({firebaseCustomToken,user});}
    return res.json({token:signDemoToken({...user,demo:true}),user:{...user,demo:true}});
  }catch(error){db.prepare('DELETE FROM webauthn_challenges WHERE id=?').run(challenge.id);return res.status(401).json({error:'Passkey could not be verified. Use secure sign-in instead.'});}
});

// FamilyPass is a recognition challenge only. It never authenticates a session; a real account sign-in is still required.
app.post('/api/auth/familypass/challenge', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare("SELECT id FROM users WHERE lower(email)=? AND role='patient'").get(email);
  if (!user) return res.status(404).json({ error: 'No patient account is registered for this email.' });
  const membershipRow = db.prepare("SELECT profile_id FROM memberships WHERE user_id=? AND role='patient' AND active=1 LIMIT 1").get(user.id);
  if (!membershipRow) return res.status(403).json({ error: 'This account is not linked to an elderly profile.' });
  const members = db.prepare("SELECT id,name,relationship FROM family_members WHERE profile_id=? AND active=1 ORDER BY name").all(membershipRow.profile_id);
  const relationships = [...new Set(members.map(m => m.relationship))];
  if (relationships.length < 2 || members.length < 3) return res.status(409).json({ error: 'FamilyPass needs at least three registered family members and two distinct relationships. Use secure login instead.' });
  const shuffledRelationships = [...relationships]; for (let i=shuffledRelationships.length-1;i>0;i--){const j=crypto.randomInt(i+1);[shuffledRelationships[i],shuffledRelationships[j]]=[shuffledRelationships[j],shuffledRelationships[i]];} const picked = shuffledRelationships.slice(0,2);
  const targets = picked.map(rel => members.find(m => m.relationship === rel));
  const id = uid(); const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO family_pass_challenges(id,user_id,profile_id,targets_json,expires_at,status) VALUES(?,?,?,?,?,?)').run(id,user.id,membershipRow.profile_id,JSON.stringify({targets:targets.map(x => ({ id: x.id, relationship: x.relationship })),optionIds:members.map(m=>m.id)}),expiresAt,'pending');
  const questions = targets.map((target, index) => { const options=[...members]; for(let i=options.length-1;i>0;i--){const j=crypto.randomInt(i+1);[options[i],options[j]]=[options[j],options[i]];} return { question: `Who is your ${target.relationship.toLowerCase()}?`, step: index + 1, options: options.map(m => ({ id: m.id, name: m.name, relationship: m.relationship, initials: m.name.split(/\s+/).map(x => x[0]).join('').slice(0,2).toUpperCase(), photoUrl:m.photo_storage?`/api/auth/familypass/challenge/${id}/photo/${m.id}`:null })) }; });
  res.json({ challengeId: id, expiresAt, questions, notice: 'This recognition challenge is not a login factor. Your account credentials or passkey are still required.' });
});
app.get('/api/auth/familypass/challenge/:id/photo/:memberId', (req,res) => {
  const challenge=db.prepare("SELECT * FROM family_pass_challenges WHERE id=? AND status='pending'").get(req.params.id);
  if(!challenge||new Date(challenge.expires_at)<new Date())return res.status(410).end();
  const data=json(challenge.targets_json); if(!(data.optionIds||[]).includes(req.params.memberId))return res.status(404).end();
  const member=db.prepare('SELECT photo_storage,photo_mime FROM family_members WHERE id=? AND profile_id=? AND active=1').get(req.params.memberId,challenge.profile_id);
  if(!member?.photo_storage)return res.status(404).end();const file=path.join(familyPhotoDir,path.basename(member.photo_storage));if(!fs.existsSync(file))return res.status(404).end();res.type(member.photo_mime).set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}).sendFile(file);
});
app.post('/api/auth/familypass/challenge/:id/verify', (req, res) => {
  const challenge = db.prepare('SELECT * FROM family_pass_challenges WHERE id=?').get(req.params.id);
  if (!challenge || challenge.status !== 'pending' || new Date(challenge.expires_at) < new Date()) return res.status(410).json({ error: 'FamilyPass challenge expired. Start again or use secure login.' });
  if (challenge.attempts >= 5) { db.prepare("UPDATE family_pass_challenges SET status='locked' WHERE id=?").run(challenge.id); return res.status(429).json({ error: 'Too many attempts. Use secure login or request a new challenge later.' }); }
  const submitted = Array.isArray(req.body?.answers) ? req.body.answers.map(String) : [];
  const challengeData = json(challenge.targets_json); const expected = Array.isArray(challengeData) ? challengeData : challengeData.targets;
  const valid = submitted.length === 2 && submitted[0] === expected[0]?.id && submitted[1] === expected[1]?.id;
  db.prepare('UPDATE family_pass_challenges SET attempts=attempts+1,status=? WHERE id=?').run(valid ? 'passed' : (challenge.attempts + 1 >= 5 ? 'locked' : 'pending'), challenge.id);
  if (!valid) return res.status(challenge.attempts + 1 >= 5 ? 429 : 400).json({ error: 'Those selections did not match this challenge. Try again or use secure login.', attemptsRemaining: Math.max(0, 4 - challenge.attempts) });
  res.json({ passed: true, requiresAccountSignIn: true, notice: 'Recognition completed. Sign in with your account to access healthcare information.' });
});

app.use('/api', (req, res, next) => {
  if ((req.method === 'POST' && req.path === '/jobs/process') || req.path.startsWith('/device-ingest/') || req.path === '/chat/stream') return next();
  return authenticate(req, res, next);
});
app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.get('/api/passkeys', (req,res) => { const rows=db.prepare('SELECT credential_id,device_type,created_at,last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at DESC').all(req.user.id); res.json({passkeys:rows}); });
app.post('/api/passkeys/register/options', async (req,res) => {
  if(!webauthn)return res.status(503).json({error:'Passkey support is not installed on this server.'});
  try {
    const credentials=db.prepare('SELECT credential_id,transports_json FROM passkeys WHERE user_id=?').all(req.user.id);
    const options=await webauthn.generateRegistrationOptions({rpName:'ElderCare',rpID:webauthnRpId,userName:req.user.email,userDisplayName:req.user.name,userID:Buffer.from(req.user.id),attestationType:'none',authenticatorSelection:{residentKey:'preferred',userVerification:'required'},excludeCredentials:credentials.map(c=>({id:c.credential_id,transports:json(c.transports_json)}))});
    const id=uid();db.prepare('INSERT INTO webauthn_challenges(id,user_id,challenge,flow,expires_at) VALUES(?,?,?,?,?)').run(id,req.user.id,options.challenge,'register',new Date(Date.now()+5*60000).toISOString());res.json({challengeId:id,options});
  } catch (error) { console.error('Passkey registration options error:', error.message); res.status(503).json({error:'Could not prepare passkey registration. Check relying-party configuration.'}); }
});
app.post('/api/passkeys/register/verify', async (req,res) => {
  if(!webauthn)return res.status(503).json({error:'Passkey support is not installed on this server.'});
  const challenge=db.prepare("SELECT * FROM webauthn_challenges WHERE id=? AND user_id=? AND flow='register'").get(req.body?.challengeId,req.user.id);if(!challenge||new Date(challenge.expires_at)<new Date())return res.status(410).json({error:'Registration challenge expired. Start again.'});
  try{const verification=await webauthn.verifyRegistrationResponse({response:req.body.response,expectedChallenge:challenge.challenge,expectedOrigin:webauthnOrigin,expectedRPID:webauthnRpId,requireUserVerification:true});if(!verification.verified||!verification.registrationInfo)return res.status(400).json({error:'Passkey registration could not be verified.'});const c=verification.registrationInfo.credential;db.prepare('INSERT INTO passkeys(credential_id,user_id,public_key,counter,transports_json,device_type,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id,req.user.id,Buffer.from(c.publicKey).toString('base64'),c.counter,JSON.stringify(c.transports||[]),verification.registrationInfo.credentialDeviceType||'unknown',iso());db.prepare('DELETE FROM webauthn_challenges WHERE id=?').run(challenge.id);const m=db.prepare('SELECT profile_id FROM memberships WHERE user_id=? AND active=1').all(req.user.id);for(const row of m)auditTrail(row.profile_id,req.user.id,'passkey.registered','passkey',c.id,{});res.json({verified:true,credentialId:c.id});}catch(error){db.prepare('DELETE FROM webauthn_challenges WHERE id=?').run(challenge.id);res.status(400).json({error:'Passkey registration failed. Check browser support and relying-party configuration.'});}
});
app.delete('/api/passkeys/:credentialId', (req,res) => { const result=db.prepare('DELETE FROM passkeys WHERE credential_id=? AND user_id=?').run(req.params.credentialId,req.user.id);if(!result.changes)return res.status(404).json({error:'Passkey not found.'});const m=db.prepare('SELECT profile_id FROM memberships WHERE user_id=? AND active=1').all(req.user.id);for(const row of m)auditTrail(row.profile_id,req.user.id,'passkey.revoked','passkey',req.params.credentialId,{});res.json({ok:true}); });
app.get('/api/profiles', (req, res) => {
  const rows = db.prepare(`SELECT p.*, m.role AS member_role, m.permissions FROM memberships m JOIN profiles p ON p.id=m.profile_id WHERE m.user_id=? AND m.active=1`).all(req.user.id);
  res.json({ profiles: rows.map(r => ({ ...r, conditions: json(r.conditions), allergies: json(r.allergies), permissions: json(r.permissions) })) });
});
app.get('/api/dashboard/:profileId', (req, res) => {
  const m = access(req,res,req.params.profileId); if (!m) return;
  const profile = db.prepare('SELECT * FROM profiles WHERE id=?').get(req.params.profileId);
  const meds = db.prepare('SELECT * FROM medications WHERE profile_id=? AND active=1 ORDER BY name').all(profile.id).map(x => ({ ...x, times: json(x.times) }));
  const events = db.prepare('SELECT * FROM medication_events WHERE profile_id=? ORDER BY scheduled_time DESC LIMIT 50').all(profile.id);
  const readings = db.prepare('SELECT * FROM health_readings WHERE profile_id=? ORDER BY recorded_at DESC LIMIT 25').all(profile.id);
  const appointments = db.prepare(`SELECT * FROM appointments WHERE profile_id=? AND status!='cancelled' ORDER BY appointment_at LIMIT 10`).all(profile.id);
  const alerts = db.prepare(`SELECT * FROM alerts WHERE profile_id=? AND status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 10`).all(profile.id);
  const timelineRows = db.prepare('SELECT * FROM timeline WHERE profile_id=? ORDER BY created_at DESC LIMIT 8').all(profile.id);
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE profile_id=? AND (recipient_id IS NULL OR recipient_id=?) AND status IN (\'queued\',\'sent\')').get(profile.id,req.user.id).n;
  res.json({ profile: { ...profile, conditions: json(profile.conditions), allergies: json(profile.allergies) }, role: m.role, permissions: m.permissions, medications: meds, medicationEvents: events, readings, appointments, alerts, timeline: timelineRows, unreadNotifications: unread });
});

// Patient profile, care-circle access, privacy settings and audit history.
app.get('/api/profiles/:profileId/profile', (req,res) => { if(!access(req,res,req.params.profileId)) return; const p=db.prepare('SELECT * FROM profiles WHERE id=?').get(req.params.profileId); res.json({profile:{...p,conditions:json(p.conditions),allergies:json(p.allergies)}}); });
app.patch('/api/profiles/:profileId/profile', (req,res) => {
  if(!access(req,res,req.params.profileId,'profile:manage')) return;
  const old=db.prepare('SELECT * FROM profiles WHERE id=?').get(req.params.profileId); if(!old) return res.status(404).json({error:'Profile not found.'});
  const b=req.body||{}; const allowed=['full_name','dob','phone','address','emergency_contact','doctor_name'];
  const values=allowed.map(k=>b[k]===undefined?old[k]:String(b[k]??'').slice(0,k==='full_name'?100:300));
  const conditions=b.conditions===undefined?old.conditions:JSON.stringify(Array.isArray(b.conditions)?b.conditions.slice(0,30):[]);
  const allergies=b.allergies===undefined?old.allergies:JSON.stringify(Array.isArray(b.allergies)?b.allergies.slice(0,30):[]);
  db.prepare('UPDATE profiles SET full_name=?,dob=?,phone=?,address=?,emergency_contact=?,doctor_name=?,conditions=?,allergies=? WHERE id=?').run(...values,conditions,allergies,req.params.profileId);
  auditTrail(req.params.profileId,req.user.id,'profile.updated','profile',req.params.profileId,{fields:Object.keys(b)});
  addTimeline(req.params.profileId,'profile','Patient profile updated','Profile details were updated.',req.user.id,req.params.profileId);
  res.json({ok:true});
});
app.get('/api/profiles/:profileId/members', (req,res) => { if(!access(req,res,req.params.profileId)) return; const rows=db.prepare(`SELECT m.user_id,m.role,m.permissions,m.active,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.profile_id=? ORDER BY m.role,u.name`).all(req.params.profileId); res.json({members:rows.map(r=>({...r,active:Boolean(r.active),permissions:json(r.permissions)}))}); });
app.patch('/api/profiles/:profileId/members/:userId', (req,res) => {
  if(!access(req,res,req.params.profileId,'membership:manage')) return;
  if(req.params.userId===req.user.id) return res.status(400).json({error:'You cannot revoke or downgrade your own owner access here.'});
  const m=db.prepare('SELECT * FROM memberships WHERE profile_id=? AND user_id=?').get(req.params.profileId,req.params.userId); if(!m) return res.status(404).json({error:'Membership not found.'});
  const b=req.body||{}; const role=b.role??m.role; if(!['family','caregiver'].includes(role)) return res.status(400).json({error:'Only family and caregiver membership roles can be assigned here.'});
  const allowed=new Set(['read','medication:write','event:write','appointment:write','reading:write','document:write','chat:write','observation:write','alert:manage','sos:manage','devices:manage','escalation:manage']);
  const permissions=b.permissions===undefined?json(m.permissions):b.permissions;
  if(!Array.isArray(permissions)||permissions.some(x=>!allowed.has(x))) return res.status(400).json({error:'One or more permissions are not supported.'});
  const active=b.active===undefined?m.active:(b.active?1:0);
  db.prepare('UPDATE memberships SET role=?,permissions=?,active=? WHERE profile_id=? AND user_id=?').run(role,JSON.stringify(permissions),active,req.params.profileId,req.params.userId);
  auditTrail(req.params.profileId,req.user.id,active?'membership.updated':'membership.revoked','membership',req.params.userId,{role,permissions,active:Boolean(active)});
  addTimeline(req.params.profileId,active?'access':'security',active?'Care-circle access updated':'Care-circle access revoked',`Access for ${req.params.userId} was ${active?'updated':'revoked'}.`,req.user.id,req.params.userId);
  res.json({ok:true});
});
app.post('/api/profiles/:profileId/invites', async (req,res) => {
  if(!access(req,res,req.params.profileId,'membership:manage')) return;
  const email=String(req.body?.email||'').trim().toLowerCase(); const role=String(req.body?.role||'family');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['family','caregiver'].includes(role)) return res.status(400).json({error:'Enter a valid email and choose family or caregiver.'});
  const smtpConfigured=Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS);
  if(isProd&&!smtpConfigured)return res.status(503).json({error:'Configure SMTP delivery before creating invitations in production.'});
  const token=crypto.randomBytes(32).toString('base64url'); const permissions=role==='caregiver'?['read','medication:write','event:write','appointment:write','reading:write','document:write','chat:write','observation:write','alert:manage','sos:manage']:['read','event:write','chat:write','observation:write','sos:manage'];
  const id=uid(); const expires=new Date(Date.now()+7*86400000).toISOString();
  db.prepare('INSERT INTO profile_invites(id,profile_id,email,role,permissions_json,token_hash,invited_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,req.params.profileId,email,role,JSON.stringify(permissions),crypto.createHash('sha256').update(token).digest('hex'),req.user.id,expires,iso());
  auditTrail(req.params.profileId,req.user.id,'invite.created','invite',id,{email,role});
  let delivery='Share the one-time token with the invited person through a trusted channel.';
  if(smtpConfigured){const frontendUrl=(process.env.FRONTEND_URL||(process.env.CORS_ORIGIN||'http://localhost:5173').split(',')[0]).replace(/\/$/,'');const inviteUrl=`${frontendUrl}/?invite=${encodeURIComponent(token)}`;const sent=await sendEmail(email,'ElderCare care-circle invitation',`You have been invited to join an ElderCare profile.\nOpen this link to create or sign in to your account: ${inviteUrl}\nThis one-time invitation expires in 7 days.`);if(!sent.sent){db.prepare('DELETE FROM profile_invites WHERE id=?').run(id);return res.status(502).json({error:'Invitation email could not be delivered. The unused invitation was removed; check SMTP settings and retry.'});}delivery='Invitation email sent.';}
  res.status(201).json({invite:{id,email,role,expiresAt:expires,token:!isProd?token:undefined},delivery});
});
app.post('/api/invites/accept', (req,res) => {
  const token=String(req.body?.token||''); if(token.length<30||token.length>200) return res.status(400).json({error:'A valid one-time invitation token is required.'});
  const invite=db.prepare("SELECT * FROM profile_invites WHERE token_hash=? AND status='pending'").get(crypto.createHash('sha256').update(token).digest('hex'));
  if(!invite||new Date(invite.expires_at)<new Date()) return res.status(410).json({error:'Invitation is invalid or expired.'});
  if(String(req.user.email||'').toLowerCase()!==invite.email) return res.status(403).json({error:'Sign in with the email address to which this invitation was issued.'});
  const exists=db.prepare('SELECT id FROM memberships WHERE user_id=? AND profile_id=?').get(req.user.id,invite.profile_id);
  if(exists) return res.status(409).json({error:'This account is already linked to the profile.'});
  db.prepare('INSERT INTO memberships(user_id,profile_id,role,permissions,active) VALUES(?,?,?,?,1)').run(req.user.id,invite.profile_id,invite.role,invite.permissions_json);
  db.prepare("UPDATE profile_invites SET status='accepted' WHERE id=?").run(invite.id);
  auditTrail(invite.profile_id,req.user.id,'invite.accepted','invite',invite.id,{});
  res.json({ok:true,profileId:invite.profile_id,role:invite.role});
});
app.get('/api/profiles/:profileId/family-members', (req,res) => { if(!access(req,res,req.params.profileId)) return; const rows=db.prepare('SELECT id,name,relationship,user_id,photo_storage,active,created_at FROM family_members WHERE profile_id=? ORDER BY active DESC,name').all(req.params.profileId); res.json({familyMembers:rows.map(x=>({...x,hasPhoto:Boolean(x.photo_storage),photo_storage:undefined,active:Boolean(x.active)}))}); });
app.post('/api/profiles/:profileId/family-members', (req,res) => { if(!access(req,res,req.params.profileId,'family:manage')) return; const name=String(req.body?.name||'').trim(); const relationship=String(req.body?.relationship||'').trim(); if(!name||name.length>80||!relationship||relationship.length>40) return res.status(400).json({error:'Name and relationship are required.'}); const id=uid(); db.prepare('INSERT INTO family_members(id,profile_id,name,relationship,created_by) VALUES(?,?,?,?,?)').run(id,req.params.profileId,name,relationship,req.user.id); auditTrail(req.params.profileId,req.user.id,'family_member.created','family_member',id,{relationship}); addTimeline(req.params.profileId,'family','Family member added',`${name} Â· ${relationship}`,req.user.id,id); res.status(201).json({familyMember:{id,name,relationship,active:true,hasPhoto:false}}); });
app.patch('/api/profiles/:profileId/family-members/:memberId', (req,res) => { if(!access(req,res,req.params.profileId,'family:manage')) return; const row=db.prepare('SELECT * FROM family_members WHERE id=? AND profile_id=?').get(req.params.memberId,req.params.profileId); if(!row) return res.status(404).json({error:'Family member not found.'}); const b=req.body||{}; const name=String(b.name??row.name).trim().slice(0,80); const relationship=String(b.relationship??row.relationship).trim().slice(0,40); const active=b.active===undefined?row.active:(b.active?1:0); db.prepare('UPDATE family_members SET name=?,relationship=?,active=? WHERE id=?').run(name,relationship,active,row.id); auditTrail(req.params.profileId,req.user.id,'family_member.updated','family_member',row.id,{name,relationship,active:Boolean(active)}); res.json({ok:true}); });
app.post('/api/profiles/:profileId/family-members/:memberId/photo', (req,res,next) => { if(!access(req,res,req.params.profileId,'family:manage')) return; next(); }, familyPhotoUpload.single('photo'), (req,res) => { if(!req.file) return res.status(400).json({error:'Choose a JPEG, PNG or WebP photo.'}); const row=db.prepare('SELECT * FROM family_members WHERE id=? AND profile_id=?').get(req.params.memberId,req.params.profileId); if(!row){fs.unlinkSync(req.file.path);return res.status(404).json({error:'Family member not found.'});} const fd=fs.openSync(req.file.path,'r'); const sig=Buffer.alloc(12); fs.readSync(fd,sig,0,12,0); fs.closeSync(fd); const valid=(req.file.mimetype==='image/jpeg'&&sig[0]===255&&sig[1]===216&&sig[2]===255)||(req.file.mimetype==='image/png'&&sig.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(req.file.mimetype==='image/webp'&&sig.subarray(0,4).toString()==='RIFF'&&sig.subarray(8,12).toString()==='WEBP'); if(!valid){fs.unlinkSync(req.file.path);return res.status(400).json({error:'Photo content does not match its file type.'});} if(row.photo_storage){const old=path.join(familyPhotoDir,path.basename(row.photo_storage));if(fs.existsSync(old))fs.unlinkSync(old);} db.prepare('UPDATE family_members SET photo_storage=?,photo_mime=? WHERE id=?').run(req.file.filename,req.file.mimetype,row.id); auditTrail(req.params.profileId,req.user.id,'family_photo.uploaded','family_member',row.id,{}); res.json({ok:true}); });
app.get('/api/profiles/:profileId/family-members/:memberId/photo', (req,res) => { if(!access(req,res,req.params.profileId)) return; const row=db.prepare('SELECT photo_storage,photo_mime FROM family_members WHERE id=? AND profile_id=?').get(req.params.memberId,req.params.profileId); if(!row?.photo_storage) return res.status(404).json({error:'No family photo is stored.'}); const file=path.join(familyPhotoDir,path.basename(row.photo_storage)); if(!fs.existsSync(file)) return res.status(404).json({error:'Family photo is unavailable.'}); res.type(row.photo_mime).set('Cache-Control','private, no-store').sendFile(file); });
app.get('/api/profiles/:profileId/preferences', (req,res) => { if(!access(req,res,req.params.profileId)) return; const row=db.prepare('SELECT * FROM profile_preferences WHERE user_id=? AND profile_id=?').get(req.user.id,req.params.profileId); res.json({preferences:row||{language:'en',text_scale:'normal',high_contrast:0,simple_mode:0,voice_assistance:0}}); });
app.put('/api/profiles/:profileId/preferences', (req,res) => { if(!access(req,res,req.params.profileId)) return; const b=req.body||{}; const language=['en','te','hi'].includes(b.language)?b.language:'en'; const scale=['normal','large','xlarge'].includes(b.textScale)?b.textScale:'normal'; db.prepare(`INSERT INTO profile_preferences(user_id,profile_id,language,text_scale,high_contrast,simple_mode,voice_assistance,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,profile_id) DO UPDATE SET language=excluded.language,text_scale=excluded.text_scale,high_contrast=excluded.high_contrast,simple_mode=excluded.simple_mode,voice_assistance=excluded.voice_assistance,updated_at=excluded.updated_at`).run(req.user.id,req.params.profileId,language,scale,b.highContrast?1:0,b.simpleMode?1:0,b.voiceAssistance?1:0,iso()); res.json({ok:true}); });
app.get('/api/profiles/:profileId/escalation-settings', (req,res) => { if(!access(req,res,req.params.profileId)) return; const settings=db.prepare('SELECT * FROM escalation_settings WHERE profile_id=?').get(req.params.profileId)||{primary_minutes:15,secondary_minutes:30}; res.json({settings}); });
app.put('/api/profiles/:profileId/escalation-settings', (req,res) => { if(!access(req,res,req.params.profileId,'escalation:manage')) return; const a=Math.max(1,Math.min(1440,Number(req.body?.primaryMinutes||15))); const b=Math.max(a+1,Math.min(2880,Number(req.body?.secondaryMinutes||30))); db.prepare('INSERT INTO escalation_settings(profile_id,primary_minutes,secondary_minutes,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET primary_minutes=excluded.primary_minutes,secondary_minutes=excluded.secondary_minutes,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(req.params.profileId,a,b,req.user.id,iso()); auditTrail(req.params.profileId,req.user.id,'escalation.settings.updated','escalation_settings',req.params.profileId,{primaryMinutes:a,secondaryMinutes:b}); res.json({ok:true,primaryMinutes:a,secondaryMinutes:b}); });
app.get('/api/profiles/:profileId/audit-logs', (req,res) => { if(!access(req,res,req.params.profileId,'membership:manage')) return; const limit=Math.min(100,Math.max(1,Number(req.query.limit||50))); const rows=db.prepare('SELECT a.*,u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.profile_id=? ORDER BY a.created_at DESC LIMIT ?').all(req.params.profileId,limit); res.json({auditLogs:rows.map(x=>({...x,details:json(x.details_json)}))}); });

// Device integration tokens are returned once. Readings only receive the device source label through this authenticated ingestion route.
app.get('/api/profiles/:profileId/device-integrations', (req,res) => { if(!access(req,res,req.params.profileId)) return; const rows=db.prepare('SELECT id,provider,device_type,label,status,created_at,last_seen_at FROM device_integrations WHERE profile_id=? ORDER BY created_at DESC').all(req.params.profileId); res.json({integrations:rows}); });
app.post('/api/profiles/:profileId/device-integrations', (req,res) => { if(!access(req,res,req.params.profileId,'devices:manage')) return; const b=req.body||{}; const provider=String(b.provider||'custom-api').slice(0,50); const deviceType=String(b.deviceType||'health-monitor').slice(0,60); const label=String(b.label||'Connected health device').slice(0,80); const token=crypto.randomBytes(32).toString('base64url'); const id=uid(); db.prepare('INSERT INTO device_integrations(id,profile_id,provider,device_type,label,token_hash,created_by) VALUES(?,?,?,?,?,?,?)').run(id,req.params.profileId,provider,deviceType,label,crypto.createHash('sha256').update(token).digest('hex'),req.user.id); auditTrail(req.params.profileId,req.user.id,'device.integration.created','device_integration',id,{provider,deviceType,label}); res.status(201).json({integration:{id,provider,device_type:deviceType,label,status:'active'},deviceToken:token,ingestPath:`/api/device-ingest/${id}/readings`,notice:'Store this token in the connected device. It is shown only once. No device is connected until it sends a signed reading.'}); });
app.delete('/api/profiles/:profileId/device-integrations/:integrationId', (req,res) => { if(!access(req,res,req.params.profileId,'devices:manage')) return; const row=db.prepare('SELECT * FROM device_integrations WHERE id=? AND profile_id=?').get(req.params.integrationId,req.params.profileId); if(!row)return res.status(404).json({error:'Device integration not found.'}); db.prepare("UPDATE device_integrations SET status='revoked',token_hash='' WHERE id=?").run(row.id); auditTrail(req.params.profileId,req.user.id,'device.integration.revoked','device_integration',row.id,{}); res.json({ok:true}); });
app.post('/api/device-ingest/:integrationId/readings', (req,res) => { const row=db.prepare("SELECT * FROM device_integrations WHERE id=? AND status='active'").get(req.params.integrationId); const supplied=String(req.headers['x-device-token']||''); if(!row||!supplied||crypto.createHash('sha256').update(supplied).digest('hex')!==row.token_hash)return res.status(401).json({error:'Invalid device credentials.'}); const b=req.body||{}; const units={blood_pressure:'mmHg',heart_rate:'bpm',blood_glucose:'mg/dL',spo2:'%',temperature:'Â°C'}; if(!units[b.parameter]||!Number.isFinite(Number(b.value))||(b.parameter==='blood_pressure'&&!Number.isFinite(Number(b.secondaryValue))))return res.status(400).json({error:'Unsupported or invalid health reading.'}); const id=uid(); db.prepare('INSERT INTO health_readings(id,profile_id,parameter,value,secondary_value,unit,recorded_at,recorded_by,source,note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,row.profile_id,b.parameter,Number(b.value),b.secondaryValue==null?null:Number(b.secondaryValue),units[b.parameter],iso(),row.created_by,'connected-device',`Device: ${row.label}`); db.prepare('UPDATE device_integrations SET last_seen_at=? WHERE id=?').run(iso(),row.id); addTimeline(row.profile_id,'health','Connected-device reading received',`${b.parameter}: ${b.value} ${units[b.parameter]} Â· ${row.label}`,row.created_by,id); res.status(201).json({ok:true,readingId:id,source:'connected-device'}); });

// One-time stream tickets let EventSource consume real-time messages without putting bearer tokens in URLs.
app.post('/api/profiles/:profileId/chat/stream-ticket', (req,res) => { if(!access(req,res,req.params.profileId)) return; const ticket=crypto.randomBytes(24).toString('base64url'); streamTickets.set(ticket,{userId:req.user.id,profileId:req.params.profileId,expiresAt:Date.now()+60000}); res.json({ticket,expiresInSeconds:60}); });
app.get('/api/chat/stream', (req,res) => { const ticket=String(req.query.ticket||''); const data=streamTickets.get(ticket); streamTickets.delete(ticket); if(!data||data.expiresAt<Date.now()) return res.status(401).end(); const active=membership(data.userId,data.profileId); if(!active) return res.status(403).end(); res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}); res.flushHeaders?.(); res.write(`event: ready\ndata: {"connected":true}\n\n`); const channel=`profile:${data.profileId}`; const listener=event=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`); profileEvents.on(channel,listener); const heartbeat=setInterval(()=>res.write(': ping\n\n'),20000); req.on('close',()=>{clearInterval(heartbeat);profileEvents.off(channel,listener);}); });

// Medication schedules and independently persisted adherence events.
app.get('/api/profiles/:profileId/medications', (req,res) => { if (!access(req,res,req.params.profileId)) return; const rows=db.prepare('SELECT * FROM medications WHERE profile_id=? ORDER BY active DESC,name').all(req.params.profileId); res.json({ medications: rows.map(r=>({...r,times:json(r.times)})) }); });
app.post('/api/profiles/:profileId/medications', (req,res) => {
  if (!access(req,res,req.params.profileId,'medication:write')) return;
  const b=req.body||{}; if (!b.name || !b.dosage || !b.frequency || !Array.isArray(b.times) || !b.times.length) return res.status(400).json({error:'Name, dosage, frequency and at least one time are required.'});
  const id=uid(); db.prepare(`INSERT INTO medications(id,profile_id,name,dosage,frequency,times,food_instruction,start_date,end_date,doctor,instructions,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,req.params.profileId,String(b.name).slice(0,100),String(b.dosage).slice(0,60),String(b.frequency).slice(0,60),JSON.stringify(b.times.slice(0,8)),String(b.foodInstruction||''),b.startDate||new Date().toISOString().slice(0,10),b.endDate||null,String(b.doctor||''),String(b.instructions||''),req.user.id);
  addTimeline(req.params.profileId,'medication','Medication schedule added',`${b.name} Â· ${b.dosage}`,req.user.id,id);
  res.status(201).json({ medication: db.prepare('SELECT * FROM medications WHERE id=?').get(id) });
});
app.patch('/api/profiles/:profileId/medications/:id', (req,res) => {
  if (!access(req,res,req.params.profileId,'medication:write')) return;
  const old=db.prepare('SELECT * FROM medications WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId); if(!old) return res.status(404).json({error:'Medication not found.'});
  const b=req.body||{}; const fields={name:b.name??old.name,dosage:b.dosage??old.dosage,frequency:b.frequency??old.frequency,times:JSON.stringify(b.times??json(old.times)),food_instruction:b.foodInstruction??old.food_instruction,instructions:b.instructions??old.instructions,active:b.active===undefined?old.active:(b.active?1:0)};
  db.prepare('UPDATE medications SET name=?,dosage=?,frequency=?,times=?,food_instruction=?,instructions=?,active=? WHERE id=?').run(fields.name,fields.dosage,fields.frequency,fields.times,fields.food_instruction,fields.instructions,fields.active,old.id);
  addTimeline(req.params.profileId,'medication','Medication schedule updated',old.name,req.user.id,old.id); res.json({ok:true});
});
app.post('/api/profiles/:profileId/medications/:id/events', (req,res) => {
  if (!access(req,res,req.params.profileId,'event:write')) return;
  const med=db.prepare('SELECT * FROM medications WHERE id=? AND profile_id=? AND active=1').get(req.params.id,req.params.profileId); if(!med) return res.status(404).json({error:'Active medication not found.'});
  const status=['taken','missed','acknowledged','reminded'].includes(req.body?.status)?req.body.status:'taken';
  const scheduledTime=req.body?.scheduledTime || iso(); const id=uid();
  db.prepare(`INSERT INTO medication_events(id,medication_id,profile_id,scheduled_time,recorded_time,recorded_by,status,source,notes) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,med.id,req.params.profileId,scheduledTime,iso(),req.user.id,status,req.user.role==='caregiver'?'caregiver-recorded':'self-reported',String(req.body?.notes||'').slice(0,300));
  addTimeline(req.params.profileId,'medication',status==='taken'?'Dose marked as taken':`Dose ${status}`,`${med.name} Â· ${med.dosage} Â· ${req.user.role==='caregiver'?'recorded by caregiver':'self-reported'}`,req.user.id,id);
  addNotification(req.params.profileId,'medication',`Medication ${status}`,`${med.name}: ${status.replace('-',' ')}. This is a recorded event, not physical verification.`);
  res.status(201).json({event:db.prepare('SELECT * FROM medication_events WHERE id=?').get(id)});
});

// Appointments.
app.get('/api/profiles/:profileId/appointments',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({appointments:db.prepare('SELECT * FROM appointments WHERE profile_id=? ORDER BY appointment_at DESC').all(req.params.profileId)});});
app.post('/api/profiles/:profileId/appointments',(req,res)=>{if(!access(req,res,req.params.profileId,'appointment:write'))return;const b=req.body||{};if(!b.doctor||!b.appointmentAt)return res.status(400).json({error:'Doctor and date/time are required.'});const id=uid();db.prepare('INSERT INTO appointments(id,profile_id,doctor,specialty,clinic,appointment_at,location,notes,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,req.params.profileId,b.doctor,b.specialty||'',b.clinic||'',b.appointmentAt,b.location||'',b.notes||'','scheduled',req.user.id);addTimeline(req.params.profileId,'appointment','Appointment scheduled',`${b.doctor} Â· ${b.appointmentAt}`,req.user.id,id);addNotification(req.params.profileId,'appointment','Doctor appointment added',`${b.doctor} appointment has been added.`);res.status(201).json({appointment:db.prepare('SELECT * FROM appointments WHERE id=?').get(id)});});
app.patch('/api/profiles/:profileId/appointments/:id',(req,res)=>{if(!access(req,res,req.params.profileId,'appointment:write'))return;const a=db.prepare('SELECT * FROM appointments WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId);if(!a)return res.status(404).json({error:'Appointment not found.'});const b=req.body||{};db.prepare('UPDATE appointments SET doctor=?,specialty=?,clinic=?,appointment_at=?,location=?,notes=?,status=? WHERE id=?').run(b.doctor??a.doctor,b.specialty??a.specialty,b.clinic??a.clinic,b.appointmentAt??a.appointment_at,b.location??a.location,b.notes??a.notes,b.status??a.status,a.id);addTimeline(req.params.profileId,'appointment','Appointment updated',a.doctor,req.user.id,a.id);res.json({ok:true});});

// Health readings and explicitly configured, clinician-supplied thresholds.
app.get('/api/profiles/:profileId/readings',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({readings:db.prepare('SELECT * FROM health_readings WHERE profile_id=? ORDER BY recorded_at DESC LIMIT 300').all(req.params.profileId)});});
app.post('/api/profiles/:profileId/readings',(req,res)=>{
  if(!access(req,res,req.params.profileId,'reading:write'))return;const b=req.body||{};const allowed=['blood_pressure','heart_rate','blood_glucose','spo2','temperature'];if(!allowed.includes(b.parameter)||!Number.isFinite(Number(b.value)))return res.status(400).json({error:'Choose a supported parameter and provide a numeric value.'});
  const units={blood_pressure:'mmHg',heart_rate:'bpm',blood_glucose:'mg/dL',spo2:'%',temperature:'Â°C'};if(b.parameter==='blood_pressure'&&!Number.isFinite(Number(b.secondaryValue)))return res.status(400).json({error:'A diastolic value is required for blood pressure.'});
  const id=uid();db.prepare('INSERT INTO health_readings(id,profile_id,parameter,value,secondary_value,unit,recorded_at,recorded_by,source,note) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,req.params.profileId,b.parameter,Number(b.value),b.secondaryValue==null?null:Number(b.secondaryValue),units[b.parameter],b.recordedAt||iso(),req.user.id,'manual',String(b.note||'').slice(0,300));addTimeline(req.params.profileId,'health','Health reading recorded',`${b.parameter.replace('_',' ')}: ${b.value}${b.secondaryValue==null?'':`/${b.secondaryValue}`} ${units[b.parameter]}`,req.user.id,id);
  const rules=db.prepare('SELECT * FROM thresholds WHERE profile_id=? AND parameter=? AND enabled=1').all(req.params.profileId,b.parameter);for(const rule of rules){const v=Number(b.value);if((rule.min_value!=null&&v<rule.min_value)||(rule.max_value!=null&&v>rule.max_value)){const alertId=uid();db.prepare('INSERT INTO alerts(id,profile_id,category,title,message,severity,related_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(alertId,req.params.profileId,'health','Configured health threshold crossed',`${b.parameter}: ${v} ${units[b.parameter]}. This reading is outside a care-plan threshold configured by an authorized user.`, 'warning',id,iso());addNotification(req.params.profileId,'health-alert','Health alert created',`A ${b.parameter.replace('_',' ')} reading crossed a configured care-plan threshold.`);}}
  res.status(201).json({reading:db.prepare('SELECT * FROM health_readings WHERE id=?').get(id)});
});
app.get('/api/profiles/:profileId/thresholds',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({thresholds:db.prepare('SELECT * FROM thresholds WHERE profile_id=?').all(req.params.profileId)});});
app.post('/api/profiles/:profileId/thresholds',(req,res)=>{if(!access(req,res,req.params.profileId,'alert:manage'))return;const b=req.body||{};const allowed=['blood_pressure','heart_rate','blood_glucose','spo2','temperature'];if(!allowed.includes(b.parameter))return res.status(400).json({error:'Unsupported parameter.'});if(b.minValue==null&&b.maxValue==null)return res.status(400).json({error:'Enter a clinician-provided lower or upper threshold.'});const id=uid();db.prepare('INSERT INTO thresholds(id,profile_id,parameter,min_value,max_value,enabled,configured_by) VALUES(?,?,?,?,?,?,?)').run(id,req.params.profileId,b.parameter,b.minValue===''||b.minValue==null?null:Number(b.minValue),b.maxValue===''||b.maxValue==null?null:Number(b.maxValue),1,req.user.id);res.status(201).json({threshold:db.prepare('SELECT * FROM thresholds WHERE id=?').get(id)});});

// Alerts, observations and timeline.
app.get('/api/profiles/:profileId/alerts',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({alerts:db.prepare('SELECT * FROM alerts WHERE profile_id=? ORDER BY created_at DESC').all(req.params.profileId)});});
app.patch('/api/profiles/:profileId/alerts/:id',(req,res)=>{if(!access(req,res,req.params.profileId,'alert:manage'))return;const a=db.prepare('SELECT * FROM alerts WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId);if(!a)return res.status(404).json({error:'Alert not found.'});const status=req.body?.status;if(!['acknowledged','resolved','closed'].includes(status))return res.status(400).json({error:'Unsupported alert status.'});db.prepare('UPDATE alerts SET status=?,acknowledged_by=CASE WHEN ?=\'acknowledged\' THEN ? ELSE acknowledged_by END,acknowledged_at=CASE WHEN ?=\'acknowledged\' THEN ? ELSE acknowledged_at END,resolved_by=CASE WHEN ? IN (\'resolved\',\'closed\') THEN ? ELSE resolved_by END,resolved_at=CASE WHEN ? IN (\'resolved\',\'closed\') THEN ? ELSE resolved_at END WHERE id=?').run(status,status,req.user.id,status,iso(),status,req.user.id,status,iso(),a.id);addTimeline(req.params.profileId,'alert',`Alert ${status}`,a.title,req.user.id,a.id);res.json({ok:true});});
app.get('/api/profiles/:profileId/observations',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({observations:db.prepare('SELECT o.*,u.name AS author FROM observations o LEFT JOIN users u ON u.id=o.author_id WHERE o.profile_id=? ORDER BY o.created_at DESC').all(req.params.profileId)});});
app.post('/api/profiles/:profileId/observations',(req,res)=>{if(!access(req,res,req.params.profileId,'observation:write'))return;const note=String(req.body?.note||'').trim();if(!note||note.length>2000)return res.status(400).json({error:'Observation must contain 1â€“2000 characters.'});const id=uid();db.prepare('INSERT INTO observations(id,profile_id,author_id,note,created_at) VALUES(?,?,?,?,?)').run(id,req.params.profileId,req.user.id,note,iso());addTimeline(req.params.profileId,'observation','Caregiver observation added',note.slice(0,140),req.user.id,id);res.status(201).json({ok:true,id});});
app.get('/api/profiles/:profileId/timeline',(req,res)=>{if(!access(req,res,req.params.profileId))return;const limit=Math.min(100,Math.max(1,Number(req.query.limit||30)));const offset=Math.max(0,Number(req.query.offset||0));const rows=db.prepare('SELECT t.*,u.name AS actor_name FROM timeline t LEFT JOIN users u ON u.id=t.actor_id WHERE t.profile_id=? ORDER BY t.created_at DESC LIMIT ? OFFSET ?').all(req.params.profileId,limit,offset);res.json({timeline:rows,nextOffset:rows.length===limit?offset+limit:null});});

// Real-time chat uses client polling for the local MVP; Firestore listeners can replace this adapter.
app.get('/api/profiles/:profileId/chat',(req,res)=>{if(!access(req,res,req.params.profileId))return;const conv=db.prepare('SELECT * FROM conversations WHERE profile_id=? ORDER BY created_at LIMIT 1').get(req.params.profileId);if(!conv)return res.json({conversation:null,messages:[]});const rows=db.prepare('SELECT m.*,u.name AS sender_name,u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? ORDER BY m.created_at DESC LIMIT 100').all(conv.id).reverse();res.json({conversation:conv,messages:rows});});
app.patch('/api/profiles/:profileId/chat/read',(req,res)=>{if(!access(req,res,req.params.profileId,'chat:write'))return;const conv=db.prepare('SELECT id FROM conversations WHERE profile_id=? ORDER BY created_at LIMIT 1').get(req.params.profileId);if(conv)db.prepare('UPDATE messages SET read_at=? WHERE conversation_id=? AND sender_id!=? AND read_at IS NULL').run(iso(),conv.id,req.user.id);res.json({ok:true});});
app.post('/api/profiles/:profileId/chat',(req,res)=>{if(!access(req,res,req.params.profileId,'chat:write'))return;const body=String(req.body?.body||'').trim();if(!body||body.length>2000)return res.status(400).json({error:'Message must contain 1â€“2000 characters.'});let conv=db.prepare('SELECT * FROM conversations WHERE profile_id=? ORDER BY created_at LIMIT 1').get(req.params.profileId);if(!conv){const id=uid();db.prepare('INSERT INTO conversations(id,profile_id,title) VALUES(?,?,?)').run(id,req.params.profileId,'Care team');conv={id};}const id=uid();db.prepare('INSERT INTO messages(id,conversation_id,sender_id,body,created_at) VALUES(?,?,?,?,?)').run(id,conv.id,req.user.id,body,iso());addTimeline(req.params.profileId,'chat','Care team message sent',body.slice(0,120),req.user.id,id);const message=db.prepare('SELECT m.*,u.name AS sender_name,u.role AS sender_role FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(id);notifyProfile(req.params.profileId,{type:'message',payload:{messageId:id}});res.status(201).json({message});});

// Private healthcare documents. Never expose the uploads directory as static content.
app.get('/api/profiles/:profileId/documents',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({documents:db.prepare('SELECT id,profile_id,name,type,description,uploaded_by,created_at FROM documents WHERE profile_id=? ORDER BY created_at DESC').all(req.params.profileId)});});
app.post('/api/profiles/:profileId/documents', (req,res,next)=>{if(!access(req,res,req.params.profileId,'document:write'))return;next();}, upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Select a PDF, PNG or JPEG document.'});
  const fd=fs.openSync(req.file.path,'r');const signature=Buffer.alloc(8);fs.readSync(fd,signature,0,8,0);fs.closeSync(fd);
  const valid=(req.file.mimetype==='application/pdf'&&signature.subarray(0,5).toString()==='%PDF-')||(req.file.mimetype==='image/png'&&signature.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(req.file.mimetype==='image/jpeg'&&signature[0]===0xff&&signature[1]===0xd8&&signature[2]===0xff);
  if(!valid){fs.unlinkSync(req.file.path);return res.status(400).json({error:'The file content does not match an allowed PDF, PNG or JPEG format.'});}
  const id=uid();const type=req.body?.type||'medical-report';db.prepare('INSERT INTO documents(id,profile_id,name,type,description,storage_name,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,req.params.profileId,path.basename(req.file.originalname).slice(0,150),type,String(req.body?.description||'').slice(0,500),req.file.filename,req.user.id,iso());addTimeline(req.params.profileId,'document','Medical document uploaded',path.basename(req.file.originalname),req.user.id,id);res.status(201).json({document:{id,name:req.file.originalname,type}});
});
app.get('/api/profiles/:profileId/documents/:id/download',(req,res)=>{if(!access(req,res,req.params.profileId))return;const d=db.prepare('SELECT * FROM documents WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId);if(!d)return res.status(404).json({error:'Document not found.'});const file=path.join(uploadDir,path.basename(d.storage_name));if(!fs.existsSync(file))return res.status(404).json({error:'Stored file is unavailable.'});res.download(file,d.name);});
app.delete('/api/profiles/:profileId/documents/:id',(req,res)=>{if(!access(req,res,req.params.profileId,'document:write'))return;const d=db.prepare('SELECT * FROM documents WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId);if(!d)return res.status(404).json({error:'Document not found.'});const file=path.join(uploadDir,path.basename(d.storage_name));if(fs.existsSync(file))fs.unlinkSync(file);db.prepare('DELETE FROM documents WHERE id=?').run(d.id);addTimeline(req.params.profileId,'document','Medical document removed',d.name,req.user.id,d.id);res.json({ok:true});});

// Daily summaries are factual roll-ups, not diagnoses or AI output.
function generateSummary(profileId) {
  const day=new Date().toISOString().slice(0,10);
  const doses=db.prepare('SELECT status,COUNT(*) n FROM medication_events WHERE profile_id=? AND substr(scheduled_time,1,10)=? GROUP BY status').all(profileId,day);
  const readings=db.prepare('SELECT parameter,value,secondary_value,unit,recorded_at,source FROM health_readings WHERE profile_id=? AND substr(recorded_at,1,10)=? ORDER BY recorded_at DESC').all(profileId,day);
  const appts=db.prepare("SELECT doctor,appointment_at,status FROM appointments WHERE profile_id=? AND status='scheduled' AND appointment_at>=? ORDER BY appointment_at LIMIT 5").all(profileId,iso());
  const alerts=db.prepare("SELECT title,status FROM alerts WHERE profile_id=? AND status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 5").all(profileId);
  const obs=db.prepare('SELECT note FROM observations WHERE profile_id=? AND substr(created_at,1,10)=? ORDER BY created_at DESC LIMIT 3').all(profileId,day);
  const doseText=doses.length?doses.map(x=>`${x.n} ${x.status}`).join(', '):'No medication events recorded';
  const readingText=readings.length?readings.map(r=>`${r.parameter.replace('_',' ')} ${r.value}${r.secondary_value==null?'':`/${r.secondary_value}`} ${r.unit} (${r.source})`).join('; '):'No readings recorded today';
  const apptText=appts.length?appts.map(a=>`${a.doctor} at ${a.appointment_at}`).join('; '):'No upcoming appointments recorded';
  const alertText=alerts.length?alerts.map(a=>`${a.title} (${a.status})`).join('; '):'No unresolved alerts';
  const observationText=obs.length?obs.map(o=>o.note).join('; '):'No caregiver observations recorded';
  const base=`Medication events: ${doseText}. Readings: ${readingText}. Upcoming appointments: ${apptText}. Care alerts: ${alertText}. Caregiver observations: ${observationText}.`;
  const id=uid();db.prepare(`INSERT INTO summaries(id,profile_id,summary_date,patient_summary,family_summary,caregiver_summary,generated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(profile_id,summary_date) DO UPDATE SET patient_summary=excluded.patient_summary,family_summary=excluded.family_summary,caregiver_summary=excluded.caregiver_summary,generated_at=excluded.generated_at`).run(id,profileId,day,base,base,base,iso());
  return db.prepare('SELECT * FROM summaries WHERE profile_id=? AND summary_date=?').get(profileId,day);
}
app.get('/api/profiles/:profileId/summary',(req,res)=>{if(!access(req,res,req.params.profileId))return;const day=req.query.date||new Date().toISOString().slice(0,10);let s=db.prepare('SELECT * FROM summaries WHERE profile_id=? AND summary_date=?').get(req.params.profileId,day);if(!s&&day===new Date().toISOString().slice(0,10))s=generateSummary(req.params.profileId);res.json({summary:s||null});});
app.post('/api/profiles/:profileId/summary/generate',(req,res)=>{if(!access(req,res,req.params.profileId,'observation:write'))return;const s=generateSummary(req.params.profileId);addTimeline(req.params.profileId,'summary','Daily health summary generated',s.summary_date,req.user.id,s.id);res.json({summary:s,notice:'Generated from stored events and measurements. This is not a medical diagnosis.'});});

// SOS always persists; location is optional and only stored when the browser grants it.
app.post('/api/profiles/:profileId/sos',(req,res)=>{if(!access(req,res,req.params.profileId,'sos:manage'))return;const lat=Number.isFinite(Number(req.body?.latitude))?Number(req.body.latitude):null;const lng=Number.isFinite(Number(req.body?.longitude))?Number(req.body.longitude):null;const has=lat!==null&&lng!==null;const id=uid();db.prepare('INSERT INTO sos_events(id,profile_id,activated_by,latitude,longitude,location_status,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,req.params.profileId,req.user.id,has?lat:null,has?lng:null,has?'shared-with-consent':'unavailable-or-not-shared','active',iso());addTimeline(req.params.profileId,'sos','Emergency SOS activated',has?'Location shared with permission':'Location unavailable or not shared',req.user.id,id);addNotification(req.params.profileId,'sos','Emergency SOS activated','An SOS event was created. Open ElderCare to acknowledge and coordinate assistance.');res.status(201).json({event:db.prepare('SELECT * FROM sos_events WHERE id=?').get(id),notice:'SOS event recorded. This does not automatically contact emergency services.'});});
app.get('/api/profiles/:profileId/sos',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({events:db.prepare('SELECT s.*,u.name AS activated_by_name FROM sos_events s LEFT JOIN users u ON u.id=s.activated_by WHERE s.profile_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.profileId)});});
app.patch('/api/profiles/:profileId/sos/:id',(req,res)=>{if(!access(req,res,req.params.profileId,'sos:manage'))return;const e=db.prepare('SELECT * FROM sos_events WHERE id=? AND profile_id=?').get(req.params.id,req.params.profileId);if(!e)return res.status(404).json({error:'SOS event not found.'});const status=req.body?.status;if(!['acknowledged','resolved'].includes(status))return res.status(400).json({error:'Unsupported SOS status.'});db.prepare('UPDATE sos_events SET status=?,acknowledged_by=CASE WHEN ?=\'acknowledged\' THEN ? ELSE acknowledged_by END,acknowledged_at=CASE WHEN ?=\'acknowledged\' THEN ? ELSE acknowledged_at END,resolved_at=CASE WHEN ?=\'resolved\' THEN ? ELSE resolved_at END WHERE id=?').run(status,status,req.user.id,status,iso(),status,iso(),e.id);addTimeline(req.params.profileId,'sos',`SOS ${status}`,`Event ${e.id}`,req.user.id,e.id);res.json({ok:true});});

app.get('/api/profiles/:profileId/notification-preferences',(req,res)=>{if(!access(req,res,req.params.profileId))return;const prefs=db.prepare('SELECT email_enabled,updated_at FROM notification_preferences WHERE user_id=? AND profile_id=?').get(req.user.id,req.params.profileId);const person=db.prepare('SELECT email FROM users WHERE id=?').get(req.user.id);res.json({preferences:{emailEnabled:Boolean(prefs?.email_enabled),emailAvailable:Boolean(person?.email),updatedAt:prefs?.updated_at||null,providerConfigured:Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS)}});});
app.put('/api/profiles/:profileId/notification-preferences',(req,res)=>{if(!access(req,res,req.params.profileId))return;const enabled=req.body?.emailEnabled===true?1:0;db.prepare('INSERT INTO notification_preferences(user_id,profile_id,email_enabled,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,profile_id) DO UPDATE SET email_enabled=excluded.email_enabled,updated_at=excluded.updated_at').run(req.user.id,req.params.profileId,enabled,iso());res.json({ok:true,emailEnabled:Boolean(enabled)});});
app.get('/api/profiles/:profileId/notifications',(req,res)=>{if(!access(req,res,req.params.profileId))return;res.json({notifications:db.prepare('SELECT * FROM notifications WHERE profile_id=? AND (recipient_id IS NULL OR recipient_id=?) ORDER BY created_at DESC LIMIT 100').all(req.params.profileId,req.user.id)});});
app.patch('/api/profiles/:profileId/notifications/:id/read',(req,res)=>{if(!access(req,res,req.params.profileId))return;db.prepare("UPDATE notifications SET status='read' WHERE id=? AND profile_id=? AND (recipient_id IS NULL OR recipient_id=?)").run(req.params.id,req.params.profileId,req.user.id);res.json({ok:true});});

// Cloud Scheduler can POST to this authenticated job endpoint. Never depend on an open browser tab.
app.post('/api/jobs/process',async (req,res)=>{
  if(!process.env.JOB_SECRET || req.headers['x-job-secret']!==process.env.JOB_SECRET)return res.status(401).json({error:'A valid scheduler secret is required.'});
  const now=new Date();const profiles=db.prepare('SELECT id FROM profiles').all();let reminders=0,missed=0,summaries=0;
  for(const {id:profileId} of profiles){
    const meds=db.prepare('SELECT * FROM medications WHERE profile_id=? AND active=1').all(profileId);
    for(const med of meds){if(med.start_date&&med.start_date>now.toISOString().slice(0,10))continue;if(med.end_date&&med.end_date<now.toISOString().slice(0,10))continue;for(const time of json(med.times)){const scheduled=new Date(`${now.toISOString().slice(0,10)}T${time}:00`);const delta=now-scheduled;if(delta>=0&&delta<10*60*1000){const exists=db.prepare("SELECT id FROM medication_events WHERE medication_id=? AND scheduled_time=?").get(med.id,scheduled.toISOString());if(!exists){const ev=uid();db.prepare("INSERT INTO medication_events(id,medication_id,profile_id,scheduled_time,recorded_by,status,source,notes) VALUES(?,?,?,?,?,'reminded','scheduler','Reminder event')").run(ev,med.id,profileId,scheduled.toISOString(),'system');addNotification(profileId,'medication-reminder','Medication reminder',`${med.name} is due. Please record the event in ElderCare.`);addTimeline(profileId,'medication','Medication reminder generated',med.name,'system',ev);reminders++;}}}}
    const stale=db.prepare("SELECT e.*,m.name FROM medication_events e JOIN medications m ON m.id=e.medication_id WHERE e.profile_id=? AND e.status IN ('scheduled','reminded','acknowledged') AND e.scheduled_time<? AND e.scheduled_time>=?").all(profileId, new Date(now.getTime()-30*60*1000).toISOString(),new Date(now.getTime()-24*60*60*1000).toISOString());
    for(const e of stale){db.prepare("UPDATE medication_events SET status='missed' WHERE id=?").run(e.id);const dup=db.prepare("SELECT id FROM alerts WHERE related_id=? AND category='medication'").get(e.id);if(!dup){const a=uid();db.prepare('INSERT INTO alerts(id,profile_id,category,title,message,severity,related_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(a,profileId,'medication','Medication dose unconfirmed',`${e.name} has no recorded confirmation for its scheduled time.`,'warning',e.id,iso());const primary=db.prepare("SELECT user_id FROM memberships WHERE profile_id=? AND role='caregiver' AND active=1 ORDER BY id LIMIT 1").get(profileId);if(primary){addNotification(profileId,'missed-medication','Medication dose unconfirmed',`${e.name} is unconfirmed. Please check with the patient.`,primary.user_id);db.prepare('INSERT OR IGNORE INTO escalation_events(id,profile_id,alert_id,stage,recipient_id,created_at) VALUES(?,?,?,?,?,?)').run(uid(),profileId,a,'primary-notified',primary.user_id,iso());}else{addNotification(profileId,'missed-medication','Medication dose unconfirmed',`${e.name} is unconfirmed. Please check with the patient or caregiver.`);}addTimeline(profileId,'alert','Missed medication alert created',e.name,'system',a);missed++;}}
    const cfg=db.prepare('SELECT primary_minutes,secondary_minutes FROM escalation_settings WHERE profile_id=?').get(profileId);
    const primaryMinutes=Math.max(1,Number(cfg?.primary_minutes||process.env.PRIMARY_ESCALATION_MINUTES||15));
    const secondaryMinutes=Math.max(primaryMinutes+1,Number(cfg?.secondary_minutes||process.env.SECONDARY_ESCALATION_MINUTES||30));
    const openAlerts=db.prepare("SELECT * FROM alerts WHERE profile_id=? AND category='medication' AND status IN ('open','escalated')").all(profileId);
    for(const alert of openAlerts){
      const age=(now-new Date(alert.created_at))/60000;
      if(age>=secondaryMinutes){
        const family=db.prepare("SELECT user_id FROM memberships WHERE profile_id=? AND role='family' AND active=1").all(profileId);
        for(const f of family){const exists=db.prepare('SELECT id FROM escalation_events WHERE alert_id=? AND stage=? AND recipient_id=?').get(alert.id,'secondary-family',f.user_id);if(!exists){addNotification(profileId,'care-escalation','Care alert escalated',`${alert.title} remains unresolved and has been escalated to an authorized family member.`,f.user_id);db.prepare('INSERT OR IGNORE INTO escalation_events(id,profile_id,alert_id,stage,recipient_id,created_at) VALUES(?,?,?,?,?,?)').run(uid(),profileId,alert.id,'secondary-family',f.user_id,iso());addTimeline(profileId,'escalation','Care alert escalated to family',alert.title,'system',alert.id);}}
        if(family.length)db.prepare("UPDATE alerts SET status='escalated' WHERE id=? AND status='open'").run(alert.id);
      } else if(age>=primaryMinutes){
        const primary=db.prepare("SELECT user_id FROM memberships WHERE profile_id=? AND role='caregiver' AND active=1 ORDER BY id LIMIT 1").get(profileId);
        if(primary){const exists=db.prepare('SELECT id FROM escalation_events WHERE alert_id=? AND stage=? AND recipient_id=?').get(alert.id,'primary-follow-up',primary.user_id);if(!exists){addNotification(profileId,'care-escalation','Caregiver follow-up needed',`${alert.title} remains open and needs acknowledgement.`,primary.user_id);db.prepare('INSERT OR IGNORE INTO escalation_events(id,profile_id,alert_id,stage,recipient_id,created_at) VALUES(?,?,?,?,?,?)').run(uid(),profileId,alert.id,'primary-follow-up',primary.user_id,iso());}}
      }
    }
    const appts=db.prepare("SELECT * FROM appointments WHERE profile_id=? AND status='scheduled' AND appointment_at>? AND appointment_at<=?").all(profileId,now.toISOString(),new Date(now.getTime()+24*60*60*1000).toISOString());
    for(const appt of appts){const body=`Appointment ${appt.id}: ${appt.doctor} is scheduled for ${appt.appointment_at}.`;const seen=db.prepare('SELECT id FROM notifications WHERE profile_id=? AND category=? AND body=?').get(profileId,'appointment-reminder',body);if(!seen)addNotification(profileId,'appointment-reminder','Appointment reminder',body);}
    const day=now.toISOString().slice(0,10);if(!db.prepare('SELECT id FROM summaries WHERE profile_id=? AND summary_date=?').get(profileId,day)){generateSummary(profileId);addNotification(profileId,'daily-summary','Daily health summary ready','A factual daily summary is available in ElderCare.');summaries++;}
  }
  let emailsSent=0,emailsFailed=0;
  if(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS){
    const recent=db.prepare("SELECT * FROM notifications WHERE created_at>=? ORDER BY created_at").all(new Date(now.getTime()-24*60*60*1000).toISOString());
    for(const note of recent){
      const recipients=note.recipient_id?db.prepare('SELECT id,email FROM users WHERE id=?').all(note.recipient_id):db.prepare('SELECT u.id,u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.profile_id=? AND m.active=1').all(note.profile_id);
      for(const recipient of recipients){
        if(!recipient.email)continue;
        const pref=db.prepare('SELECT email_enabled FROM notification_preferences WHERE user_id=? AND profile_id=?').get(recipient.id,note.profile_id);
        if(!pref?.email_enabled)continue;
        const previous=db.prepare("SELECT * FROM notification_deliveries WHERE notification_id=? AND recipient_id=? AND channel='email'").get(note.id,recipient.id);
        if(previous?.status==='sent')continue;
        if(previous&&previous.attempted_at&&now-new Date(previous.attempted_at)<10*60*1000)continue;
        const result=await sendEmail(recipient.email,`ElderCare update: ${note.title}`,'You have a new healthcare update in ElderCare. Sign in to your private care space to review it.');
        const status=result.sent?'sent':'failed';
        db.prepare("INSERT INTO notification_deliveries(id,notification_id,recipient_id,channel,status,attempts,attempted_at,result) VALUES(?,?,?,'email',?,?,?,?) ON CONFLICT(notification_id,recipient_id,channel) DO UPDATE SET status=excluded.status,attempts=notification_deliveries.attempts+1,attempted_at=excluded.attempted_at,result=excluded.result").run(uid(),note.id,recipient.id,status,1,iso(),result.sent?'Delivered':result.reason);
        if(result.sent)emailsSent++;else emailsFailed++;
      }
    }
  }
  res.json({ok:true,remindersCreated:reminders,missedEventsMarked:missed,dailySummariesCreated:summaries,emailsSent,emailsFailed,emailProviderConfigured:Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS),processedAt:iso()});
});

// Optional OpenAI-compatible AI endpoint. It receives only the specific question and, by explicit opt-in, a factual care summary.
app.get('/api/ai/status',(req,res)=>res.json({available:Boolean(process.env.AI_ASSISTANT_URL),provider:process.env.AI_ASSISTANT_PROVIDER||null,notice:process.env.AI_ASSISTANT_URL?'AI endpoint configured. Review the provider privacy terms before sending care summaries.':'AI assistant is not configured. Healthcare summaries remain rule-based and factual.'}));
app.post('/api/profiles/:profileId/ai/ask',async (req,res)=>{
  if(!access(req,res,req.params.profileId))return;
  if(!process.env.AI_ASSISTANT_URL)return res.status(503).json({error:'AI assistant is not configured. No answer was generated.'});
  const question=String(req.body?.question||'').trim(); if(!question||question.length>1500)return res.status(400).json({error:'Enter a question of 1â€“1500 characters.'});
  const messages=[{role:'system',content:'You are ElderCare information assistant. Explain only information supplied in context, use plain language, do not diagnose, prescribe, recommend dosage changes, infer unrecorded facts, or replace a clinician. For urgent symptoms, advise contacting local emergency services or a clinician. Clearly state when context is insufficient.'}];
  if(req.body?.includeSummary===true){const day=new Date().toISOString().slice(0,10);const summary=db.prepare('SELECT patient_summary FROM summaries WHERE profile_id=? AND summary_date=?').get(req.params.profileId,day)||generateSummary(req.params.profileId);messages.push({role:'user',content:`Current recorded care summary (data may be incomplete): ${summary.patient_summary}`});}
  messages.push({role:'user',content:question});
  try{const response=await fetch(process.env.AI_ASSISTANT_URL,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.AI_ASSISTANT_API_KEY?{Authorization:`Bearer ${process.env.AI_ASSISTANT_API_KEY}`}:{})},body:JSON.stringify({model:process.env.AI_ASSISTANT_MODEL||'gpt-4o-mini',messages,reasoning_effort:'none'}),signal:AbortSignal.timeout(25000)});if(!response.ok)return res.status(502).json({error:`AI provider returned ${response.status}. No answer was accepted.`});const payload=await response.json();const answer=payload.choices?.[0]?.message?.content;if(typeof answer!=='string'||!answer.trim())return res.status(502).json({error:'AI provider response was not in the expected format.'});res.json({answer:answer.trim(),generatedBy:process.env.AI_ASSISTANT_PROVIDER||'configured AI provider',includesCareSummary:req.body?.includeSummary===true,notice:'AI-generated information only; not diagnosis or treatment advice.'});}
  catch(error){res.status(502).json({error:error.name==='TimeoutError'?'AI provider timed out.':'AI provider is unavailable. No answer was generated.'});}
});

const publicDir = path.resolve(__dirname, '../public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(express.static(publicDir, { maxAge: isProd ? '1h' : 0 }));
  app.get(/^\/(?!api(?:\/|$)|health$).*/, (_req,res) => res.sendFile(path.join(publicDir,'index.html')));
}
app.use((err,_req,res,_next)=>{console.error(err);const code=err instanceof multer.MulterError?400:500;res.status(code).json({error:code===400?err.message:'An unexpected server error occurred.'});});
app.listen(PORT,'0.0.0.0',()=>console.log(`ElderCare API listening on ${PORT}`));
