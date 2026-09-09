/**
 * iCampus WhatsApp Bot using Baileys
 * - Multi-user concurrent access for all students
 * - Remembers student ID and password securely per user
 * - Auto-prompts CAPTCHA when session expires & automatically delivers pending intent
 * - Quick re-login: typing "login" re-uses remembered credentials without re-entering password
 * - Responds to: attendance, fee, timetable, marks, profile, status, logout, forget, cancel, help
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Configuration
const PUBLIC_BOT = true; // Enabled for all students
const BOT_OWNER_PHONE = '919455515206';
const ALLOWED_USERS = [
    `${BOT_OWNER_PHONE}@s.whatsapp.net`,
    '242528230109359@lid'
];

const QR_IMAGE_PATH = path.join(__dirname, 'auth', 'qr.png');
const CREDITS_PATH = path.join(__dirname, 'auth', 'creds.json');
const SESSION_FILE = path.join(__dirname, 'session.txt');
const SESSIONS_DIR = path.join(__dirname, 'auth', 'sessions');
const USERS_DIR = path.join(__dirname, 'auth', 'users');
const PYTHON_SCRIPT = path.join(__dirname, 'icampus_fetcher.py');
const EVENT_LOG = path.join(__dirname, 'events.log');

// In-memory pending logins (keyed by userKey)
const pendingLogins = new Map();

// Ensure all required directories exist
fs.mkdirSync(path.dirname(QR_IMAGE_PATH), { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });

// Event logging
function logEvent(event) {
    const timestamp = new Date().toISOString();
    const line = `${timestamp} | ${event}\n`;
    fs.appendFileSync(EVENT_LOG, line);
    console.log(line.trim());
}

// Strip brackets or quotes from user inputs
function cleanArg(val) {
    if (!val) return '';
    return val.replace(/^[<\[("']+|[>\])"']+$/g, '').trim();
}

// Check if user is authorized
function isAuthorized(sender, participant) {
    if (PUBLIC_BOT) return true;
    if (ALLOWED_USERS.includes(sender)) return true;
    if (participant && ALLOWED_USERS.includes(participant)) return true;
    if (sender && sender.includes(BOT_OWNER_PHONE)) return true;
    if (participant && participant.includes(BOT_OWNER_PHONE)) return true;
    return false;
}

// Unique per-user session key (handles 1-on-1 chats and groups)
function getUserSessionKey(jid, participant) {
    const raw = participant || jid || 'default';
    return raw.replace(/[^A-Za-z0-9]/g, '_').substring(0, 40);
}

// Get user session cookie
function getUserSession(jid, participant) {
    const key = getUserSessionKey(jid, participant);
    const userSessionFile = path.join(SESSIONS_DIR, `${key}.txt`);
    if (fs.existsSync(userSessionFile)) {
        const cookie = fs.readFileSync(userSessionFile, 'utf-8').trim();
        if (cookie) return cookie;
    }
    // Fallback for owner to default session.txt
    const raw = participant || jid || '';
    if (raw.includes(BOT_OWNER_PHONE) || raw === '242528230109359@lid') {
        if (fs.existsSync(SESSION_FILE)) {
            const cookie = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
            if (cookie) return cookie;
        }
    }
    return null;
}

// Set user session cookie
function setUserSession(jid, participant, cookie) {
    const key = getUserSessionKey(jid, participant);
    const userSessionFile = path.join(SESSIONS_DIR, `${key}.txt`);
    fs.writeFileSync(userSessionFile, cookie.trim());

    const raw = participant || jid || '';
    if (raw.includes(BOT_OWNER_PHONE) || raw === '242528230109359@lid') {
        fs.writeFileSync(SESSION_FILE, cookie.trim());
    }
}

// Remove user session cookie
function removeUserSession(jid, participant) {
    const key = getUserSessionKey(jid, participant);
    const userSessionFile = path.join(SESSIONS_DIR, `${key}.txt`);
    if (fs.existsSync(userSessionFile)) {
        try { fs.unlinkSync(userSessionFile); } catch (_) { }
    }
}

// Get remembered credentials
function getUserCredentials(jid, participant) {
    const key = getUserSessionKey(jid, participant);
    const userFile = path.join(USERS_DIR, `${key}.json`);
    if (fs.existsSync(userFile)) {
        try {
            return JSON.parse(fs.readFileSync(userFile, 'utf-8'));
        } catch (_) { }
    }
    // Owner fallback
    const raw = participant || jid || '';
    if (raw.includes(BOT_OWNER_PHONE) || raw === '242528230109359@lid') {
        const ownerFile = path.join(USERS_DIR, '242528230109359_lid.json');
        if (fs.existsSync(ownerFile)) {
            try {
                return JSON.parse(fs.readFileSync(ownerFile, 'utf-8'));
            } catch (_) { }
        }
    }
    return null;
}

// Save or update remembered credentials
function saveUserCredentials(jid, participant, data) {
    const key = getUserSessionKey(jid, participant);
    const userFile = path.join(USERS_DIR, `${key}.json`);
    const existing = getUserCredentials(jid, participant) || {};

    const payload = {
        college: data.college || existing.college || 'UCRN',
        username: data.username || existing.username,
        password: data.password || existing.password,
        name: data.name || existing.name || '',
        updated_at: Date.now()
    };

    fs.writeFileSync(userFile, JSON.stringify(payload, null, 2));

    const raw = participant || jid || '';
    if (raw.includes(BOT_OWNER_PHONE) || raw === '242528230109359@lid') {
        const ownerFile = path.join(USERS_DIR, '242528230109359_lid.json');
        fs.writeFileSync(ownerFile, JSON.stringify(payload, null, 2));
    }
}

// Delete remembered credentials
function forgetUserCredentials(jid, participant) {
    const key = getUserSessionKey(jid, participant);
    const userFile = path.join(USERS_DIR, `${key}.json`);
    if (fs.existsSync(userFile)) {
        try { fs.unlinkSync(userFile); } catch (_) { }
    }
    removeUserSession(jid, participant);
}

// Safe send message wrapper
async function safeSendMessage(sock, jid, content) {
    try {
        return await sock.sendMessage(jid, content);
    } catch (err) {
        logEvent('SEND_MESSAGE_ERROR: ' + err.message);
        return null;
    }
}

// Save QR code as PNG
async function saveQRCode(qr) {
    try {
        await qrcode.toFile(QR_IMAGE_PATH, qr);
        logEvent('QR_SAVED: ' + QR_IMAGE_PATH);
    } catch (err) {
        logEvent('QR_SAVE_ERROR: ' + err.message);
    }
}

// Run Python fetcher
function runPythonFetcher(cookie, intent) {
    try {
        const output = execFileSync('python3', [PYTHON_SCRIPT, cookie, intent], {
            encoding: 'utf-8',
            timeout: 30000
        });
        return output.trim();
    } catch (err) {
        logEvent('PYTHON_ERROR: ' + err.message);
        return 'Error fetching data: ' + err.message;
    }
}

// Run Python login init
function runLoginInit(college, username, password, prefix) {
    try {
        const res = execFileSync('python3', [PYTHON_SCRIPT, 'login-init', college, username, password, prefix], {
            encoding: 'utf-8',
            timeout: 30000
        });
        return JSON.parse(res.trim());
    } catch (err) {
        logEvent('LOGIN_INIT_ERROR: ' + err.message);
        return { status: 'error', message: err.message };
    }
}

// Run Python login submit
function runLoginSubmit(captchaCode, prefix) {
    try {
        const res = execFileSync('python3', [PYTHON_SCRIPT, 'login-submit', captchaCode, prefix], {
            encoding: 'utf-8',
            timeout: 30000
        });
        return JSON.parse(res.trim());
    } catch (err) {
        logEvent('LOGIN_SUBMIT_ERROR: ' + err.message);
        return { status: 'error', message: err.message };
    }
}

// Trigger login with credentials & send CAPTCHA image
async function triggerLoginFlow(sock, jid, participant, userKey, college, username, password, pendingIntent = null) {
    const prefix = userKey;
    const initRes = runLoginInit(college, username, password, prefix);

    if (initRes.status === 'ok' && fs.existsSync(initRes.captcha_path)) {
        pendingLogins.set(userKey, {
            college: initRes.college,
            username: initRes.username,
            password: password,
            prefix: prefix,
            pendingIntent: pendingIntent,
            timestamp: Date.now()
        });

        // Save remembered credentials
        saveUserCredentials(jid, participant, {
            college: initRes.college,
            username: initRes.username,
            password: password
        });

        const intentNotice = pendingIntent
            ? `\n🎯 _After solving, your *${pendingIntent}* will automatically be shown._\n`
            : '';

        await safeSendMessage(sock, jid, {
            image: fs.readFileSync(initRes.captcha_path),
            caption: `🔐 *iCampus Login Verification*\n` +
                `College: *${initRes.college}*\n` +
                `Student ID: *${initRes.username}*\n` +
                intentNotice +
                `\nPlease reply with the CAPTCHA code:\n` +
                `• \`captcha <code>\` (e.g. \`captcha 8205\`)\n` +
                `• Or just reply with the *digits* directly\n\n` +
                `_(Type *cancel* to abort)_`
        });
        return true;
    } else {
        await safeSendMessage(sock, jid, {
            text: `❌ Failed to initiate login: ${initRes.message || 'Unknown error'}`
        });
        return false;
    }
}

// Main bot function
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.dirname(CREDITS_PATH));

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['iCampus Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('connection.update', async (update) => {
        const connection = update.connection;
        const lastDisconnect = update.lastDisconnect;
        const qr = update.qr;

        if (qr) {
            logEvent('QR_RECEIVED');
            await saveQRCode(qr);
            logEvent('QR_SAVED');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isConflict = lastDisconnect?.error?.message?.includes('conflict');
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            logEvent(`CONNECTION_CLOSE: ${lastDisconnect?.error?.message || 'unknown'} | statusCode: ${statusCode} | reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                const delay = isConflict ? 10000 : 5000;
                setTimeout(startBot, delay);
            } else {
                logEvent('LOGGED_OUT - delete auth folder to restart');
            }
        } else if (connection === 'open') {
            logEvent('CONNECTED_TO_WA');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const m of messages) {
            try {
                if (m.key.fromMe) continue;

                const jid = m.key.remoteJid;
                const sender = jid;
                const participant = m.key.participant;
                const rawText = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();

                if (!rawText) continue;

                logEvent(`MSG_RECV: from=${sender} text=${rawText.substring(0, 50).replace(/\n/g, ' ')}`);

                if (!isAuthorized(sender, participant)) {
                    await safeSendMessage(sock, jid, { text: 'Unauthorized. This bot is private.' });
                    continue;
                }

                const userKey = getUserSessionKey(jid, participant);
                const lowerText = rawText.toLowerCase().trim();
                const prefix = userKey;
                const statePath = path.join(__dirname, 'auth', `state_${prefix}.json`);
                const pendingData = pendingLogins.get(userKey);
                const hasPendingLogin = !!pendingData || fs.existsSync(statePath);

                // Handle cancel
                if (lowerText === 'cancel' && hasPendingLogin) {
                    pendingLogins.delete(userKey);
                    if (fs.existsSync(statePath)) {
                        try { fs.unlinkSync(statePath); } catch (_) { }
                    }
                    await safeSendMessage(sock, jid, { text: '❌ Login process cancelled.' });
                    continue;
                }

                // Dedicated 'captcha' / 'code' command OR direct code submission
                let captchaInputCode = null;
                const isCaptchaCmd = lowerText.startsWith('captcha') || lowerText.startsWith('/captcha') ||
                    lowerText.startsWith('code') || lowerText.startsWith('/code');

                if (isCaptchaCmd) {
                    const parts = rawText.split(/\s+/);
                    if (parts.length >= 2) {
                        captchaInputCode = cleanArg(parts[1]);
                    } else {
                        await safeSendMessage(sock, jid, {
                            text: `🔐 *Captcha Input Command*\n\nUsage:\n\`captcha <code>\`\n\n_Example:_\n\`captcha 8205\``
                        });
                        continue;
                    }
                } else if (hasPendingLogin && /^[A-Za-z0-9]{3,6}$/.test(cleanArg(rawText))) {
                    captchaInputCode = cleanArg(rawText);
                }

                if (captchaInputCode) {
                    if (!hasPendingLogin) {
                        await safeSendMessage(sock, jid, {
                            text: `❌ No active login session found.\nPlease start login first:\n\`login <student_id> <password>\` or send \`login\``
                        });
                        continue;
                    }

                    await safeSendMessage(sock, jid, { text: `⏳ Submitting CAPTCHA *${captchaInputCode}* & authenticating...` });
                    const submitRes = runLoginSubmit(captchaInputCode, prefix);

                    const pendingIntent = pendingData?.pendingIntent;
                    pendingLogins.delete(userKey);

                    if (submitRes.status === 'ok') {
                        setUserSession(jid, participant, submitRes.session_id);

                        // Save student name if extracted
                        if (submitRes.student_name) {
                            saveUserCredentials(jid, participant, { name: submitRes.student_name });
                        }

                        const studentName = submitRes.student_name || 'Student';
                        await safeSendMessage(sock, jid, {
                            text: `✅ *Login Successful!*\nWelcome, *${studentName}*!\n\n` +
                                `💾 _Your credentials are saved. Future logins will only require solving the CAPTCHA._\n\n` +
                                `Available commands:\n• *attendance* - Check attendance & average\n• *fee* - View dues & balance\n• *timetable* - Class schedule\n• *marks* - Sessional marks\n• *profile* - Your account info`
                        });

                        // If user requested data that triggered this login, auto-deliver it now
                        if (pendingIntent) {
                            await safeSendMessage(sock, jid, { text: `⏳ Automatically fetching your *${pendingIntent}*...` });
                            const autoResult = runPythonFetcher(submitRes.session_id, pendingIntent);
                            await safeSendMessage(sock, jid, { text: autoResult });
                        }
                    } else {
                        await safeSendMessage(sock, jid, {
                            text: `❌ *Login Failed:*\n${submitRes.message}\n\nPlease try again with:\n\`login <student_id> <password>\` or send \`login\` to retry with saved account.`
                        });
                    }
                    continue;
                }

                // Command: profile / myinfo
                if (['profile', 'myinfo', 'me', 'whoami'].includes(lowerText)) {
                    const creds = getUserCredentials(jid, participant);
                    const cookie = getUserSession(jid, participant);
                    if (!creds && !cookie) {
                        await safeSendMessage(sock, jid, {
                            text: `👤 *Profile Information*\nNo account registered for your WhatsApp number yet.\n\nType:\n\`login <student_id> <password>\` to save your account.`
                        });
                        continue;
                    }

                    const profileMsg = `👤 *Your iCampus Account*\n\n` +
                        `• Name: *${creds?.name || 'Not cached yet'}*\n` +
                        `• Student ID: *${creds?.username || 'N/A'}*\n` +
                        `• College: *${creds?.college || 'UCRN'}*\n` +
                        `• Saved Password: *${creds?.password ? '•••••••• (' + creds.password.length + ' chars)' : 'None'}*\n` +
                        `• Active Session: ${cookie ? '✅ Active' : '❌ Expired (send *login* to refresh)'}\n\n` +
                        `💡 _Type *login* anytime to get a new CAPTCHA without retyping your password._`;
                    await safeSendMessage(sock, jid, { text: profileMsg });
                    continue;
                }

                // Command: forget / clear
                if (['forget', 'clear credentials', 'delete account'].includes(lowerText)) {
                    forgetUserCredentials(jid, participant);
                    pendingLogins.delete(userKey);
                    await safeSendMessage(sock, jid, {
                        text: `🗑️ *Credentials Forgotten*\nYour remembered Student ID, Password, and saved session have been permanently deleted for this WhatsApp account.`
                    });
                    continue;
                }

                // Command: logout
                if (lowerText === 'logout' || lowerText === '/logout') {
                    removeUserSession(jid, participant);
                    pendingLogins.delete(userKey);
                    await safeSendMessage(sock, jid, {
                        text: '🚪 *Logged Out*\nYour active session has been cleared. (Your credentials are still remembered; send *login* to reconnect).'
                    });
                    continue;
                }

                // Command: help
                if (lowerText === 'help' || lowerText === '/help') {
                    const helpText = `*🎓 iCampus WhatsApp Bot*\n\n` +
                        `🔐 *Authentication & Memory:*\n` +
                        `• \`login <student_id> <password>\`\n` +
                        `  _Saves your credentials & sends CAPTCHA._\n` +
                        `• \`login\` or \`relogin\`\n` +
                        `  _Quick login using remembered ID & password!_\n` +
                        `• \`captcha <code>\` - Submit CAPTCHA\n` +
                        `  _Example:_ \`captcha 8205\` (or just send digits)\n` +
                        `• \`profile\` - View your remembered account\n` +
                        `• \`logout\` - Clear active session\n` +
                        `• \`forget\` - Erase saved ID & password\n\n` +
                        `📊 *Student Commands:*\n` +
                        `• *attendance* - Subject-wise attendance & average\n` +
                        `• *fee* - Dues, payments & balance\n` +
                        `• *timetable* - Class schedule & batch\n` +
                        `• *marks* - Sessional marks\n` +
                        `• *status* - Bot health & session status\n` +
                        `• *cancel* - Abort pending login`;
                    await safeSendMessage(sock, jid, { text: helpText });
                    continue;
                }

                // Command: status
                if (lowerText === 'status') {
                    const creds = getUserCredentials(jid, participant);
                    const hasSession = !!getUserSession(jid, participant);
                    await safeSendMessage(sock, jid, {
                        text: `*🎓 iCampus Bot Status*\n` +
                            `• Mode: 🌐 Multi-User Public\n` +
                            `• Remembered User: ${creds ? `*${creds.name || creds.username}* (${creds.college})` : '❌ None'}\n` +
                            `• Session Status: ${hasSession ? '✅ Active' : '❌ Inactive'}\n` +
                            `• Bot Status: Online 🟢`
                    });
                    continue;
                }

                // Command: login / relogin
                if (lowerText.startsWith('login') || lowerText.startsWith('relogin')) {
                    const rawParts = rawText.split(/\s+/);

                    // Quick login using remembered credentials
                    if (rawParts.length === 1) {
                        const creds = getUserCredentials(jid, participant);
                        if (creds && creds.username && creds.password) {
                            await safeSendMessage(sock, jid, {
                                text: `🔄 *Quick Login with Saved Account*\n` +
                                    `Student: *${creds.name || creds.username}* (${creds.username})\n` +
                                    `College: *${creds.college}*\n\n` +
                                    `⏳ Fetching new CAPTCHA...`
                            });
                            await triggerLoginFlow(sock, jid, participant, userKey, creds.college, creds.username, creds.password);
                            continue;
                        } else {
                            const usageText = `🔐 *iCampus Login Usage*\n\n` +
                                `To login and remember your account, send:\n` +
                                `\`login <student_id> <password>\`\n\n` +
                                `_Example:_\n\`login 41250075 MySecretPass\`\n\n` +
                                `With optional college code:\n\`login UCRN 41250075 MySecretPass\`\n` +
                                `_(Colleges: UCRN [Engineering], UCEN [Education], UIMN [Management])_\n\n` +
                                `💡 _After logging in once, the bot will remember your account!_`;
                            await safeSendMessage(sock, jid, { text: usageText });
                            continue;
                        }
                    }

                    if (rawParts.length < 3) {
                        await safeSendMessage(sock, jid, {
                            text: `⚠️ *Incomplete Login Command*\nFormat: \`login <student_id> <password>\`\n_Example:_ \`login 41250075 MySecretPassword\``
                        });
                        continue;
                    }

                    let college = 'UCRN';
                    let username = '';
                    let password = '';

                    const arg1 = cleanArg(rawParts[1]);
                    if (['ucrn', 'ucen', 'uimn'].includes(arg1.toLowerCase())) {
                        college = arg1.toUpperCase();
                        username = cleanArg(rawParts[2]);
                        password = cleanArg(rawParts.slice(3).join(' '));
                    } else {
                        username = arg1;
                        password = cleanArg(rawParts.slice(2).join(' '));
                    }

                    await safeSendMessage(sock, jid, {
                        text: `⏳ Fetching CAPTCHA for student *${username}* (${college})...`
                    });

                    await triggerLoginFlow(sock, jid, participant, userKey, college, username, password);
                    continue;
                }

                // Handle raw session cookie (16-30 alphanumeric chars)
                const cleanedCookie = cleanArg(rawText);
                if (/^[A-Za-z0-9]{16,30}$/.test(cleanedCookie)) {
                    setUserSession(jid, participant, cleanedCookie);
                    logEvent('SESSION_COOKIE_SAVED for ' + userKey);
                    await safeSendMessage(sock, jid, {
                        text: '✅ Your personal session cookie has been saved. You can now use student commands (e.g. attendance, fee, timetable).'
                    });
                    continue;
                }

                // Data commands: attendance, fee, timetable, marks
                const intentAliases = {
                    'attendance': 'attendance',
                    'attandence': 'attendance',
                    'attendance average': 'attendance',
                    'attandence average': 'attendance',
                    'attendance avg': 'attendance',
                    'avg attendance': 'attendance',
                    'average attendance': 'attendance',
                    'fee': 'fee',
                    'fees': 'fee',
                    'timetable': 'timetable',
                    'time table': 'timetable',
                    'marks': 'marks',
                    'sessional': 'marks'
                };
                const mappedIntent = intentAliases[lowerText];
                if (mappedIntent) {
                    const cookie = getUserSession(jid, participant);
                    const creds = getUserCredentials(jid, participant);

                    // If no cookie but remembered credentials exist -> Auto-prompt CAPTCHA!
                    if (!cookie) {
                        if (creds && creds.username && creds.password) {
                            await safeSendMessage(sock, jid, {
                                text: `⚠️ *No Active Session*\nFound saved credentials for *${creds.name || creds.username}*.\n⏳ Fetching CAPTCHA to automatically show your *${mappedIntent}*:`
                            });
                            await triggerLoginFlow(sock, jid, participant, userKey, creds.college, creds.username, creds.password, mappedIntent);
                            continue;
                        } else {
                            await safeSendMessage(sock, jid, {
                                text: `❌ You are not logged in yet.\n\nPlease login using:\n\`login <student_id> <password>\`\n_Example:_ \`login 41250075 MyPassword\``
                            });
                            continue;
                        }
                    }

                    await safeSendMessage(sock, jid, { text: `⏳ Fetching ${mappedIntent}...` });

                    const result = runPythonFetcher(cookie, mappedIntent);

                    // If result indicates session expired and we have saved credentials -> Auto-refresh via CAPTCHA!
                    if (result.includes('Session may be expired') || result.startsWith('❌ No data found')) {
                        if (creds && creds.username && creds.password) {
                            await safeSendMessage(sock, jid, {
                                text: `⚠️ *Session Expired*\nYour iCampus session has ended.\nRefreshing for *${creds.name || creds.username}*...\n⏳ Fetching new CAPTCHA:`
                            });
                            await triggerLoginFlow(sock, jid, participant, userKey, creds.college, creds.username, creds.password, mappedIntent);
                            continue;
                        }
                    }

                    await safeSendMessage(sock, jid, { text: result });
                    continue;
                }

                // Unknown command
                await safeSendMessage(sock, jid, {
                    text: 'Unknown command. Type *help* for available commands, or *login* to authenticate.'
                });
            } catch (err) {
                logEvent('MESSAGES_UPSERT_ERROR: ' + err.message);
            }
        }
    });

    return sock;
}

// Global safety error handlers
process.on('uncaughtException', (err) => {
    logEvent('UNCAUGHT_EXCEPTION: ' + err.message);
});

process.on('unhandledRejection', (reason) => {
    logEvent('UNHANDLED_REJECTION: ' + (reason?.message || reason));
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    logEvent('SIGINT received, exiting...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logEvent('SIGTERM received, exiting...');
    process.exit(0);
});

// Start
startBot().catch(err => {
    logEvent('FATAL_ERROR: ' + err.message);
    process.exit(1);
});