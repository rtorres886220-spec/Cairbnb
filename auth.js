const OPS_AUTH_KEY = 'cairbnb-owner-auth-v1';
const OPS_SESSION_KEY = 'cairbnb-owner-session-v1';

function authBytesHex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function authPasswordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 210000, hash: 'SHA-256'}, key, 256);
  return authBytesHex(bits);
}

function setAuthMode(isSetup) {
  const title = document.getElementById('authTitle');
  const intro = document.getElementById('authIntro');
  const label = document.getElementById('authPasswordLabel');
  const password = document.getElementById('authPassword');
  const confirm = document.getElementById('confirmPasswordWrap');
  const submit = document.getElementById('authSubmit');
  title.textContent = isSetup ? 'A calmer way to run every turn.' : 'Welcome back to CairBnB.';
  intro.textContent = isSetup
    ? 'Set your private workspace password, then bring your leads, properties, and daily plan together.'
    : 'Your leads, properties, and daily plan are ready when you are.';
  label.textContent = isSetup ? 'CREATE A PASSWORD' : 'PASSWORD';
  password.autocomplete = isSetup ? 'new-password' : 'current-password';
  password.placeholder = isSetup ? 'At least 10 characters' : 'Enter your password';
  password.minLength = isSetup ? 10 : 1;
  confirm.hidden = !isSetup;
  submit.innerHTML = isSetup ? 'Create my workspace <span>→</span>' : 'Sign in <span>→</span>';
}

async function initAuth() {
  const error = document.getElementById('authError');
  let record = null;
  try {
    record = JSON.parse(localStorage.getItem(OPS_AUTH_KEY) || 'null');
    if (!record || typeof record !== 'object' || !/^[a-f\d]{32}$/i.test(record.salt || '') || !/^[a-f\d]{64}$/i.test(record.hash || '')) record = null;
  } catch {
    error.textContent = 'Browser storage is unavailable. Enable site storage to sign in.';
  }
  setAuthMode(!record);
  try {
    if (record && sessionStorage.getItem(OPS_SESSION_KEY) === 'unlocked') document.body.classList.add('authenticated');
  } catch { /* Stay at the sign-in screen if this browser blocks session storage. */ }

  document.getElementById('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = document.getElementById('authPassword').value;
    const message = document.getElementById('authError');
    message.textContent = '';
    if (!window.crypto?.subtle) {
      message.textContent = 'Password setup needs HTTPS or localhost. Open this app through its secure web address.';
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(OPS_AUTH_KEY) || 'null');
      if (!saved) {
        if (password.length < 10) {
          message.textContent = 'Use at least 10 characters for your workspace password.';
          return;
        }
        if (password !== document.getElementById('authConfirm').value) {
          message.textContent = 'Those passwords do not match yet.';
          return;
        }
        const salt = authBytesHex(crypto.getRandomValues(new Uint8Array(16)));
        const hash = await authPasswordHash(password, salt);
        localStorage.setItem(OPS_AUTH_KEY, JSON.stringify({salt, hash}));
      } else {
        const candidate = await authPasswordHash(password, saved.salt);
        if (candidate !== saved.hash) {
          message.textContent = 'That password did not match. Please try again.';
          document.getElementById('authPassword').select();
          return;
        }
      }
      sessionStorage.setItem(OPS_SESSION_KEY, 'unlocked');
      document.body.classList.add('authenticated');
      document.getElementById('authPassword').value = '';
    } catch {
      message.textContent = 'Could not access browser storage. Enable site storage and try again.';
    }
  });

  document.getElementById('authReveal').addEventListener('click', () => {
    const input = document.getElementById('authPassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    document.getElementById('authReveal').textContent = show ? 'Hide' : 'Show';
    document.getElementById('authReveal').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  document.getElementById('signOut')?.addEventListener('click', () => {
    try { sessionStorage.removeItem(OPS_SESSION_KEY); } catch { /* The gate still hides the app in this tab. */ }
    document.body.classList.remove('authenticated');
    document.getElementById('authPassword').value = '';
    error.textContent = '';
  });
}

initAuth();
