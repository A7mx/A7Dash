require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, collection, getDocs } = require('firebase/firestore');
const app = express();
const path = require('path');

// Firebase Config from .env
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Initialize Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Temporary storage for 2FA codes
const twoFactorCodes = new Map();

// Cached users and voice data
let cachedUsers = [];
let lastUserFetch = 0;
const USER_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const voiceDataCache = new Map();
let lastVoiceDataFetch = 0;
const VOICE_CACHE_DURATION = 1 * 60 * 1000; // 1 minute

// Debounce timer for batched Firestore updates
const debounceTimers = new Map();
const DEBOUNCE_DELAY = 5000; // 5 seconds

// Helper function to get Israel time (Asia/Jerusalem) as a Date object
function getIsraelTime() {
  const now = new Date();
  console.log(`Current Israel Time: ${now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })}`);
  return now;
}

function getIsraelDateISO() {
  const now = getIsraelTime();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`; // e.g., "2025-02-23"
}

// Preload voice data cache on startup
async function preloadVoiceDataCache() {
  try {
    const querySnapshot = await getDocs(collection(db, 'voice_data'));
    querySnapshot.forEach((doc) => {
      voiceDataCache.set(doc.id, { discord_id: doc.id, ...doc.data() });
    });
    lastVoiceDataFetch = Date.now();
    console.log('Voice data cache preloaded');
  } catch (error) {
    console.error('Error preloading voice data:', error.message);
  }
}

// Serve Login Page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Serve Dashboard Page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// API Route: Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const users = await fetchUsersFromDiscord();
  const user = users.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const token = `user_${user.discord_id}`;
  res.json({ token });
});

// API Route: Request 2FA Code (Admins Only)
app.post('/api/auth/request-2fa', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const discordId = token.replace('user_', '');
  const users = await fetchUsersFromDiscord();
  const user = users.find(u => u.discord_id === discordId);

  if (!user || !isAdmin(user.discord_id)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 30 * 1000;
  twoFactorCodes.set(discordId, { code, expires });

  try {
    const discordUser = await client.users.fetch(discordId);
    await discordUser.send(`Your admin 2FA code is: **${code}**. It expires in 30 seconds.`);
    res.json({ message: '2FA code sent' });
  } catch (error) {
    console.error(`Failed to send 2FA code to ${discordId}:`, error.message);
    res.status(500).json({ message: 'Failed to send 2FA code', error: error.message });
  }
});

// API Route: Verify 2FA Code (Admins Only)
app.post('/api/auth/verify-2fa', async (req, res) => {
  const { code } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const discordId = token.replace('user_', '');
  if (!twoFactorCodes.has(discordId)) return res.status(401).json({ message: 'Invalid or expired session' });

  const { code: storedCode, expires } = twoFactorCodes.get(discordId);
  if (Date.now() > expires) {
    twoFactorCodes.delete(discordId);
    return res.status(401).json({ message: 'Code expired' });
  }

  if (code !== storedCode) return res.status(401).json({ message: 'Invalid code' });

  twoFactorCodes.delete(discordId);
  res.json({ message: '2FA verified successfully' });
});

// API Route: Get Current User
app.get('/api/user/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const users = await fetchUsersFromDiscord();
  const user = users.find(u => `user_${u.discord_id}` === token);
  if (!user) return res.status(404).json({ message: 'User not found' });

  const guild = client.guilds.cache.first();
  let serverNickname = user.nickname;
  try {
    const member = await guild.members.fetch(user.discord_id);
    serverNickname = member.nickname || member.user.username;
  } catch (error) {
    // Keep stored nickname if fetch fails
  }

  res.json({ ...user, nickname: serverNickname });
});

// API Route: Get Voice Time
app.get('/api/user/voice-time', async (req, res) => {
  const { date, discordId } = req.query;
  try {
    const cachedData = voiceDataCache.get(discordId);
    if (cachedData) {
      const dailyTimes = cachedData.daily_times || {};
      const dailyTime = dailyTimes[date] || 0;
      const totalTime = cachedData.total_time || 0;
      return res.json({ voiceTime: formatTime(dailyTime), totalTime: formatTime(totalTime), dailyTimes, nickname: cachedData.nickname || '' });
    }

    const docRef = doc(db, 'voice_data', discordId);
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      return res.json({ voiceTime: '00:00:00', totalTime: '00:00:00', dailyTimes: {}, nickname: '' });
    }

    const data = docSnap.data();
    voiceDataCache.set(discordId, { discord_id: discordId, ...data });
    const dailyTimes = data.daily_times || {};
    const dailyTime = dailyTimes[date] || 0;
    const totalTime = data.total_time || 0;
    res.json({ voiceTime: formatTime(dailyTime), totalTime: formatTime(totalTime), dailyTimes, nickname: data.nickname || '' });
  } catch (error) {
    console.error('Error fetching voice time:', error.message);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// API Route: Get All Users with Roles (Admin Only)
app.get('/api/admin/all-users', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const registeredUsers = await fetchUsersFromDiscord();
  const currentUser = registeredUsers.find(u => `user_${u.discord_id}` === token);
  if (!currentUser || !isAdmin(currentUser.discord_id)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  const voiceData = await fetchVoiceDataFromFirestore();
  const guild = client.guilds.cache.first();
  const allUsers = await Promise.all(registeredUsers.map(async (user) => {
    let discordRole = 'user';
    let serverNickname = user.nickname;
    try {
      const member = await guild.members.fetch(user.discord_id);
      const roles = member.roles.cache.map(r => r.id);
      if (roles.includes(process.env.SUPERADMIN_ROLE)) discordRole = 'superadmin';
      else if (roles.includes(process.env.ADMIN_ROLE)) discordRole = 'admin';
      else if (roles.includes(process.env.COADMIN_ROLE)) discordRole = 'coadmin';
      serverNickname = member.nickname || member.user.username;
    } catch (error) {
      // User might not be in guild
    }

    const userVoiceData = voiceData.find(data => data.discord_id === user.discord_id);
    return {
      discord_id: user.discord_id,
      nickname: serverNickname,
      avatar: user.avatar,
      total_time: userVoiceData?.total_time || 0,
      registered: true,
      isWebsiteAdmin: isAdmin(user.discord_id),
      discordRole,
      username: user.username,
      password: user.password,
    };
  }));

  res.json(allUsers);
});

// API Route: Get Voice Data (Public - Accessible to All Users)
app.get('/api/voice-data', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const registeredUsers = await fetchUsersFromDiscord();
  const currentUser = registeredUsers.find(u => `user_${u.discord_id}` === token);
  if (!currentUser) return res.status(404).json({ message: 'User not found' });

  const guild = client.guilds.cache.first();
  let voiceData = Array.from(voiceDataCache.values());

  const voiceDataWithRoles = await Promise.all(voiceData.map(async (data) => {
    let discordRole = 'user';
    let serverNickname = data.nickname;
    try {
      const member = await guild.members.fetch(data.discord_id);
      const roles = member.roles.cache.map(r => r.id);
      if (roles.includes(process.env.SUPERADMIN_ROLE)) discordRole = 'superadmin';
      else if (roles.includes(process.env.ADMIN_ROLE)) discordRole = 'admin';
      else if (roles.includes(process.env.COADMIN_ROLE)) discordRole = 'coadmin';
      serverNickname = member.nickname || member.user.username;
    } catch (error) {
      // User might not be in guild
    }
    return { ...data, nickname: serverNickname, isWebsiteAdmin: isAdmin(data.discord_id), discordRole };
  }));
  res.json(voiceDataWithRoles);
});

// API Route: Change Password
app.post('/api/user/change-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const users = await fetchUsersFromDiscord();
  const user = users.find(u => `user_${u.discord_id}` === token);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (user.password !== oldPassword) return res.status(400).json({ message: 'Old password is incorrect' });

  user.password = newPassword;
  await updateSingleUserInDiscord(user);
  res.json({ message: 'Password changed successfully!' });
});

// API Route: Update User (Handles Registration Too - Admin Only)
app.post('/api/admin/update-user', async (req, res) => {
  const { discord_id, username, nickname, password } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const users = await fetchUsersFromDiscord();
  const currentUser = users.find(u => `user_${u.discord_id}` === token);
  if (!currentUser || !isAdmin(currentUser.discord_id)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  let userToUpdate = users.find(u => u.discord_id === discord_id);
  let avatarUrl = 'https://via.placeholder.com/100';

  try {
    const discordUser = await client.users.fetch(discord_id);
    avatarUrl = discordUser.avatarURL() || avatarUrl;
  } catch (error) {
    console.error(`Failed to fetch avatar for ${discord_id}:`, error.message);
  }

  if (!userToUpdate) {
    userToUpdate = {
      id: users.length + 1,
      username: username,
      nickname: nickname,
      discord_id,
      avatar: avatarUrl,
      password: password,
      role: 'user'
    };
  } else {
    userToUpdate.username = username || userToUpdate.username;
    userToUpdate.nickname = nickname || userToUpdate.nickname;
    userToUpdate.password = password || userToUpdate.password;
    userToUpdate.avatar = avatarUrl;
  }

  try {
    await updateSingleUserInDiscord(userToUpdate);
    res.json({ message: 'User updated or registered successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update/register user', error: error.message });
  }
});

// API Route: Delete User (Admin Only)
app.post('/api/admin/delete-user', async (req, res) => {
  const { discord_id } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  const users = await fetchUsersFromDiscord();
  const currentUser = users.find(u => `user_${u.discord_id}` === token);
  if (!currentUser || !isAdmin(currentUser.discord_id)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  const userToDelete = users.find(u => u.discord_id === discord_id);
  if (!userToDelete) return res.status(404).json({ message: 'User not found' });

  try {
    const dbChannel = await client.channels.fetch(process.env.DATABASE_CHANNEL_ID);
    const dbMessages = await dbChannel.messages.fetch({ limit: 100 });
    const userMessage = dbMessages.find(msg => 
      msg.embeds.length > 0 && 
      msg.embeds[0].fields.some(field => field.name === 'Discord ID' && field.value === discord_id)
    );
    if (userMessage) await userMessage.delete();
    cachedUsers = cachedUsers.filter(u => u.discord_id !== discord_id);
    lastUserFetch = 0;
    res.json({ message: 'User registration deleted successfully!' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete user', error: error.message });
  }
});

// Fetch Users from Discord Channel (Cached)
async function fetchUsersFromDiscord() {
  const now = Date.now();
  if (cachedUsers.length > 0 && (now - lastUserFetch) < USER_CACHE_DURATION) {
    return cachedUsers;
  }

  try {
    const channel = await client.channels.fetch(process.env.DATABASE_CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 100 });
    const users = [];

    for (const message of messages.values()) {
      if (message.embeds.length > 0) {
        const embed = message.embeds[0];
        const user = {
          id: parseInt(embed.fields.find(field => field.name === 'ID')?.value || '0'),
          username: embed.fields.find(field => field.name === 'Username')?.value || '',
          nickname: embed.fields.find(field => field.name === 'Nickname')?.value || '',
          discord_id: embed.fields.find(field => field.name === 'Discord ID')?.value || '',
          avatar: embed.thumbnail?.url || 'https://via.placeholder.com/100',
          password: embed.fields.find(field => field.name === 'Password')?.value || '',
          role: isAdmin(embed.fields.find(field => field.name === 'Discord ID')?.value || '') ? 'admin' : 'user',
        };
        if (user.discord_id) users.push(user);
      }
    }
    cachedUsers = users;
    lastUserFetch = now;
    return users;
  } catch (error) {
    console.error('Error fetching users from Discord:', error.message);
    return [];
  }
}

// Update Single User in Discord Channel (Handles Registration Too)
async function updateSingleUserInDiscord(user) {
  try {
    const channel = await client.channels.fetch(process.env.DATABASE_CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 100 });

    const userMessage = messages.find(msg => 
      msg.embeds.length > 0 && 
      msg.embeds[0].fields.some(field => field.name === 'Discord ID' && field.value === user.discord_id)
    );

    if (userMessage) {
      const updatedEmbed = generateUserCard(user);
      await userMessage.edit({ embeds: [updatedEmbed] });
    } else {
      const newEmbed = generateUserCard(user);
      await channel.send({ embeds: [newEmbed] });
    }
    cachedUsers = cachedUsers.map(u => u.discord_id === user.discord_id ? user : u);
    if (!cachedUsers.some(u => u.discord_id === user.discord_id)) cachedUsers.push(user);
  } catch (error) {
    console.error('Error updating user in Discord:', error.message);
    throw error;
  }
}

// Fetch Voice Data from Firestore
async function fetchVoiceDataFromFirestore() {
  const now = Date.now();
  if (voiceDataCache.size > 0 && (now - lastVoiceDataFetch) < VOICE_CACHE_DURATION) {
    return Array.from(voiceDataCache.values());
  }

  try {
    const querySnapshot = await getDocs(collection(db, 'voice_data'));
    voiceDataCache.clear();
    const voiceData = [];
    querySnapshot.forEach((doc) => {
      const data = { discord_id: doc.id, ...doc.data() };
      voiceData.push(data);
      voiceDataCache.set(doc.id, data);
    });
    lastVoiceDataFetch = now;
    return voiceData;
  } catch (error) {
    console.error('Error fetching voice data:', error.message);
    return [];
  }
}

// Debounced Save or Update Voice Data to Firestore
function debounceSaveUserVoiceData(userVoiceData) {
  const { discord_id } = userVoiceData;
  voiceDataCache.set(discord_id, { ...voiceDataCache.get(discord_id), ...userVoiceData });

  if (debounceTimers.has(discord_id)) clearTimeout(debounceTimers.get(discord_id));

  debounceTimers.set(discord_id, setTimeout(async () => {
    try {
      const dataToSave = voiceDataCache.get(discord_id);
      await setDoc(doc(db, 'voice_data', discord_id), {
        nickname: dataToSave.nickname,
        avatar: dataToSave.avatar,
        total_time: dataToSave.total_time || 0,
        daily_times: dataToSave.daily_times || {},
        join_time: dataToSave.join_time || null
      }, { merge: true });
      console.log(`Saved voice data for ${discord_id}`);
      debounceTimers.delete(discord_id);
    } catch (error) {
      console.error('Error saving voice data:', error.message);
    }
  }, DEBOUNCE_DELAY));
}

// Flush all debounced updates
async function flushDebouncedUpdates() {
  for (const [discord_id, timer] of debounceTimers) {
    clearTimeout(timer);
    const dataToSave = voiceDataCache.get(discord_id);
    if (dataToSave) {
      await setDoc(doc(db, 'voice_data', discord_id), {
        nickname: dataToSave.nickname,
        avatar: dataToSave.avatar,
        total_time: dataToSave.total_time || 0,
        daily_times: dataToSave.daily_times || {},
        join_time: dataToSave.join_time || null
      }, { merge: true });
      console.log(`Flushed data for ${discord_id}`);
    }
  }
  debounceTimers.clear();
}

// Check if a User is an Admin (Website-specific)
function isAdmin(discordId) {
  const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
  return adminIds.includes(discordId);
}

// Format Time (seconds to HH:MM:SS)
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Bot Ready Event
client.once('ready', async () => {
  await preloadVoiceDataCache();
  console.log(`Bot logged in as ${client.user.tag} on ${getIsraelTime().toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })}`);
});

// Handle Voice State Updates
client.on('voiceStateUpdate', (oldState, newState) => {
  const user = newState.member?.user;
  if (!user) return;

  let userVoiceData = voiceDataCache.get(user.id) || {
    discord_id: user.id,
    nickname: newState.member?.nickname || user.username,
    avatar: user.avatarURL()?.toString() || 'https://via.placeholder.com/100',
    total_time: 0,
    daily_times: {},
    join_time: null
  };

  const now = getIsraelTime();
  const today = getIsraelDateISO();

  if (newState.channelId && !oldState.channelId) {
    // User joins a voice channel
    userVoiceData.join_time = now.getTime();
    console.log(`${user.username} joined at ${now.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem' })}`);
    debounceSaveUserVoiceData(userVoiceData);
  } else if (!newState.channelId && oldState.channelId) {
    // User leaves a voice channel
    if (userVoiceData.join_time) {
      const leaveTime = now.getTime();
      const timeSpent = Math.floor((leaveTime - userVoiceData.join_time) / 1000);
      const safeTimeSpent = Math.max(0, timeSpent);
      userVoiceData.total_time = (userVoiceData.total_time || 0) + safeTimeSpent;
      userVoiceData.daily_times[today] = (userVoiceData.daily_times[today] || 0) + safeTimeSpent;
      userVoiceData.join_time = null;
      console.log(`${user.username} left after ${safeTimeSpent} seconds on ${today}`);
      debounceSaveUserVoiceData(userVoiceData);
      if (timeSpent < 0) {
        console.error(`Negative timeSpent detected for ${user.id}: ${timeSpent} seconds (corrected to 0)`);
      }
    } else {
      console.warn(`${user.username} left but no join_time recorded`);
    }
  }
});

// Generate User Card (Embed)
function generateUserCard(user) {
  return {
    title: `User Profile - ${user.username}`,
    thumbnail: { url: user.avatar },
    fields: [
      { name: 'ID', value: `${user.id}`, inline: true },
      { name: 'Username', value: user.username, inline: true },
      { name: 'Nickname', value: user.nickname, inline: true },
      { name: 'Discord ID', value: user.discord_id, inline: true },
      { name: 'Password', value: user.password, inline: true },
      { name: 'Role', value: user.role, inline: true },
    ],
    color: 0x3498db,
    footer: { text: 'User Management System' },
  };
}

// Start the Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Login the Bot
client.login(process.env.BOT_TOKEN).catch(err => console.error('Bot login failed:', err));

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await flushDebouncedUpdates();
  client.destroy();
  process.exit(0);
});
