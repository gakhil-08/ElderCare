const API = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';
let token = localStorage.getItem('eldercare_token') || '';
export const setToken = (value) => { token = value || ''; if (token) localStorage.setItem('eldercare_token', token); else localStorage.removeItem('eldercare_token'); };
export const getToken = () => token;
export async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}
export const api = {
  login: (email,password) => request('/auth/demo-login',{method:'POST',body:JSON.stringify({email,password})}),
  me: () => request('/me'),
  profiles: () => request('/profiles'),
  dashboard: (id) => request(`/dashboard/${id}`),
  medications: (id) => request(`/profiles/${id}/medications`),
  addMedication: (id,data) => request(`/profiles/${id}/medications`,{method:'POST',body:JSON.stringify(data)}),
  updateMedication: (id,medId,data) => request(`/profiles/${id}/medications/${medId}`,{method:'PATCH',body:JSON.stringify(data)}),
  logDose: (id,medId,data) => request(`/profiles/${id}/medications/${medId}/events`,{method:'POST',body:JSON.stringify(data)}),
  appointments: (id) => request(`/profiles/${id}/appointments`),
  addAppointment: (id,data) => request(`/profiles/${id}/appointments`,{method:'POST',body:JSON.stringify(data)}),
  updateAppointment: (id,apptId,data) => request(`/profiles/${id}/appointments/${apptId}`,{method:'PATCH',body:JSON.stringify(data)}),
  readings: (id) => request(`/profiles/${id}/readings`),
  addReading: (id,data) => request(`/profiles/${id}/readings`,{method:'POST',body:JSON.stringify(data)}),
  thresholds: (id) => request(`/profiles/${id}/thresholds`),
  addThreshold: (id,data) => request(`/profiles/${id}/thresholds`,{method:'POST',body:JSON.stringify(data)}),
  alerts: (id) => request(`/profiles/${id}/alerts`),
  updateAlert: (id,alertId,status) => request(`/profiles/${id}/alerts/${alertId}`,{method:'PATCH',body:JSON.stringify({status})}),
  observations: (id) => request(`/profiles/${id}/observations`),
  addObservation: (id,note) => request(`/profiles/${id}/observations`,{method:'POST',body:JSON.stringify({note})}),
  timeline: (id,limit=50,offset=0) => request(`/profiles/${id}/timeline?limit=${limit}&offset=${offset}`),
  chat: (id) => request(`/profiles/${id}/chat`),
  sendMessage: (id,body) => request(`/profiles/${id}/chat`,{method:'POST',body:JSON.stringify({body})}),
  documents: (id) => request(`/profiles/${id}/documents`),
  uploadDocument: (id,form) => request(`/profiles/${id}/documents`,{method:'POST',body:form}),
  downloadDocument: (id,docId) => request(`/profiles/${id}/documents/${docId}/download`),
  deleteDocument: (id,docId) => request(`/profiles/${id}/documents/${docId}`,{method:'DELETE'}),
  summary: (id) => request(`/profiles/${id}/summary`),
  generateSummary: (id) => request(`/profiles/${id}/summary/generate`,{method:'POST'}),
  notifications: (id) => request(`/profiles/${id}/notifications`),
  notificationPreferences: (id) => request(`/profiles/${id}/notification-preferences`),
  updateNotificationPreferences: (id,data) => request(`/profiles/${id}/notification-preferences`,{method:'PUT',body:JSON.stringify(data)}),
  sos: (id,data) => request(`/profiles/${id}/sos`,{method:'POST',body:JSON.stringify(data)}),
  sosEvents: (id) => request(`/profiles/${id}/sos`),
  updateSos: (id,eventId,status) => request(`/profiles/${id}/sos/${eventId}`,{method:'PATCH',body:JSON.stringify({status})}),
  aiStatus: () => request('/ai/status')
};

// ElderCare V2 workflows.
api.familyPassChallenge = (email) => request('/auth/familypass/challenge', { method: 'POST', body: JSON.stringify({ email }) });
api.verifyFamilyPass = (challengeId, answers) => request(`/auth/familypass/challenge/${challengeId}/verify`, { method: 'POST', body: JSON.stringify({ answers }) });
api.profile = (id) => request(`/profiles/${id}/profile`);
api.updateProfile = (id, data) => request(`/profiles/${id}/profile`, { method: 'PATCH', body: JSON.stringify(data) });
api.familyMembers = (id) => request(`/profiles/${id}/family-members`);
api.addFamilyMember = (id, data) => request(`/profiles/${id}/family-members`, { method: 'POST', body: JSON.stringify(data) });
api.updateFamilyMember = (id, memberId, data) => request(`/profiles/${id}/family-members/${memberId}`, { method: 'PATCH', body: JSON.stringify(data) });
api.uploadFamilyPhoto = (id, memberId, form) => request(`/profiles/${id}/family-members/${memberId}/photo`, { method: 'POST', body: form });
api.members = (id) => request(`/profiles/${id}/members`);
api.updateMember = (id, userId, data) => request(`/profiles/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(data) });
api.createInvite = (id, data) => request(`/profiles/${id}/invites`, { method: 'POST', body: JSON.stringify(data) });
api.acceptInvite = (token) => request('/invites/accept', { method: 'POST', body: JSON.stringify({ token }) });
api.escalationSettings = (id) => request(`/profiles/${id}/escalation-settings`);
api.updateEscalationSettings = (id, data) => request(`/profiles/${id}/escalation-settings`, { method: 'PUT', body: JSON.stringify(data) });
api.auditLogs = (id) => request(`/profiles/${id}/audit-logs`);
api.deviceIntegrations = (id) => request(`/profiles/${id}/device-integrations`);
api.createDeviceIntegration = (id, data) => request(`/profiles/${id}/device-integrations`, { method: 'POST', body: JSON.stringify(data) });
api.revokeDeviceIntegration = (id, integrationId) => request(`/profiles/${id}/device-integrations/${integrationId}`, { method: 'DELETE' });
api.preferences = (id) => request(`/profiles/${id}/preferences`);
api.savePreferences = (id, data) => request(`/profiles/${id}/preferences`, { method: 'PUT', body: JSON.stringify(data) });
api.chatStreamTicket = (id) => request(`/profiles/${id}/chat/stream-ticket`, { method: 'POST' });
api.markChatRead = (id) => request(`/profiles/${id}/chat/read`, { method: 'PATCH' });
api.askAI = (id, data) => request(`/profiles/${id}/ai/ask`, { method: 'POST', body: JSON.stringify(data) });
export const getApiRoot = () => API.replace(/\/api$/, '');

api.passkeyStatus = () => request('/auth/passkeys/status');
api.passkeyLoginOptions = (email) => request('/auth/passkeys/login/options', { method: 'POST', body: JSON.stringify({ email }) });
api.passkeyLoginVerify = (challengeId, response) => request('/auth/passkeys/login/verify', { method: 'POST', body: JSON.stringify({ challengeId, response }) });
api.passkeyRegistrationOptions = () => request('/passkeys/register/options', { method: 'POST' });
api.passkeyRegistrationVerify = (challengeId, response) => request('/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ challengeId, response }) });
api.passkeys = () => request('/passkeys');
api.removePasskey = (credentialId) => request(`/passkeys/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
