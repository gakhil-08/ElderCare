import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signInWithCustomToken, sendPasswordResetEmail, createUserWithEmailAndPassword, sendEmailVerification, signOut } from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
export const firebaseReady = Object.values(config).every(Boolean);
let auth = null;
if (firebaseReady) {
  const app = getApps()[0] || initializeApp(config);
  auth = getAuth(app);
}
export async function firebaseSignIn(email, password) {
  if (!auth) throw new Error('Firebase Authentication is not configured.');
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user.getIdToken(true);
}
export async function firebaseSignInWithCustomToken(token) { if (!auth) throw new Error('Firebase Authentication is not configured.'); const result=await signInWithCustomToken(auth,token); return result.user.getIdToken(true); }
export async function firebaseSendPasswordReset(email) { if (!auth) throw new Error('Firebase Authentication is not configured.'); await sendPasswordResetEmail(auth,email); }
export async function firebaseCreateAccount(email,password) { if (!auth) throw new Error('Firebase Authentication is not configured.'); const result=await createUserWithEmailAndPassword(auth,email,password); await sendEmailVerification(result.user); return { verificationEmailSent: true }; }
export async function firebaseSignOut() { if (auth) await signOut(auth); }
