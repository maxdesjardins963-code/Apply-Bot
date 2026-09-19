/**
 * WestJet | PTFS - Apply Bot (full version)
 * -----------------------------------------------------
 * - /panel slash command posts 4 buttons: ATC / Moderator / Cabin Crew / Pilot
 * - Clicking a button DMs the user a confirmation, then asks questions
 *   one by one in their DMs (Appy-style flow) - 15 questions per department
 *   (7 shared + 8 department-specific).
 * - 20 distinct moderation checks run on every DM answer (see the numbered
 *   list right above the moderation section below) before it's accepted.
 * - If the user states an age under MIN_AGE, they are AUTOMATICALLY
 *   blacklisted (kicked from the server + saved to blacklist.json) and
 *   the application stops immediately.
 * - Finished applications are posted to a staff review channel with
 *   Accept / Deny buttons.
 *
 * Files: index.js + package.json. blacklist.json is created automatically
 * the first time someone gets blacklisted.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ============================================================
// CONFIG
// ============================================================
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;                 // Application ID (Developer Portal)
const GUILD_ID = process.env.GUILD_ID;                   // your server ID
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID; // where finished apps get posted
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;       // where auto-blacklist / flag logs go
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;         // role allowed to review applications

const MIN_AGE = 13;
const APPLICATION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
const MAX_REPROMPTS = 3; // after this many failed attempts on one question, flag & move on

const BRAND_NAME = 'WestJet | PTFS';
const BRAND_FOOTER = 'Sent from WestJet | PTFS';
const BRAND_COLOR = 0x00885A;  // WestJet green
const BRAND_GOLD = 0xF2A900;   // WestJet gold accent
const BRAND_DENY = 0xC8102E;   // WestJet red accent
const BRAND_THUMBNAIL =
  'https://cdn.discordapp.com/attachments/1546678087134093412/1550944516914159686/Capture_decran_2026-09-13_173847.png?ex=6ab02d23&is=6aaedba3&hm=00b0179e903fdceca66f645369cdfa0f1274ef0a2518b6f32adb0c5a072aecf1&';

const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');

// ============================================================
// BLACKLIST STORAGE (simple JSON file so it survives restarts)
// ============================================================
function loadBlacklist() {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveBlacklist(data) {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}
function isBlacklisted(userId) {
  return Boolean(loadBlacklist()[userId]);
}
function addToBlacklist(userId, tag, reason) {
  const bl = loadBlacklist();
  bl[userId] = { tag, reason, date: new Date().toISOString() };
  saveBlacklist(bl);
}
function removeFromBlacklist(userId) {
  const bl = loadBlacklist();
  const existed = Boolean(bl[userId]);
  delete bl[userId];
  saveBlacklist(bl);
  return existed;
}

// ============================================================
// MODERATION - 20 checks
// -----------------------------------------------------------
//  1. Empty / whitespace-only answer
//  2. Minimum length per question
//  3. Maximum length cap (spam protection)
//  4. Blocked words / slurs (leetspeak-normalized)
//  5. Discord invite link detection
//  6. General URL / link detection
//  7. Mass mention detection (@everyone / @here / pings)
//  8. Repeated-character gibberish ("aaaaaa", "??????")
//  9. No-vowel gibberish detection
// 10. ALL CAPS shouting detection
// 11. Excessive punctuation spam ("!!!!!!", "??????")
// 12. Low-effort / lazy one-word answers
// 13. Word-repetition spam ("yes yes yes yes")
// 14. Emoji-only message detection
// 15. Excessive emoji ratio relative to text
// 16. Control / zero-width character detection (filter-bypass attempts)
// 17. Duplicate-answer detection (copy-pasting a previous answer)
// 18. Discord token / webhook leak pattern detection
// 19. Numeric scale validation (must be a whole number 1-10)
// 20. Age validation (must be a real number, must meet MIN_AGE)
// ============================================================

const MIN_LEN_DEFAULT = 8;
const MAX_LEN = 800;

const BLOCKED_WORDS = [
  'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'chink', 'spic', 'kike',
  'rape', 'kys', 'cunt', 'tranny',
];

const LOW_EFFORT_ANSWERS = new Set([
  'idk', 'idc', 'na', 'n/a', 'none', 'nothing', 'lol', 'lmao', 'test',
  'asdf', 'skibidi', 'ok', 'yes', 'no', 'sure', 'meh', 'nvm', 'w/e',
]);

const INVITE_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;
const URL_REGEX = /(https?:\/\/|www\.)\S+/i;
const MASS_MENTION_REGEX = /@(everyone|here)|<@&?\d+>/;
const TOKEN_REGEX = /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}|discord\.com\/api\/webhooks\/\d+\/[\w-]+/i;
const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u202A-\u202E\uFEFF]/;
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

function normalizeForBadWords(text) {
  return text
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
}

function isRepeatedCharGibberish(text) {
  const stripped = text.replace(/\s/g, '');
  return stripped.length >= 5 && /^(.)\1{4,}$/.test(stripped);
}

function isNoVowelGibberish(text) {
  return text.length >= 6 && !/[aeiouAEIOU]/.test(text);
}

function isAllCaps(text) {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  return letters.length >= 10 && letters === letters.toUpperCase();
}

function hasExcessivePunctuation(text) {
  return /([!?])\1{4,}/.test(text);
}

function hasWordRepetitionSpam(text) {
  const words = text.trim().toLowerCase().split(/\s+/);
  if (words.length < 4) return false;
  const uniqueRatio = new Set(words).size / words.length;
  return uniqueRatio < 0.4;
}

function isEmojiOnly(text) {
  const withoutEmoji = text.replace(EMOJI_REGEX, '').replace(/\s/g, '');
  const emojiCount = (text.match(EMOJI_REGEX) || []).length;
  return emojiCount > 0 && withoutEmoji.length === 0;
}

function hasExcessiveEmojiRatio(text) {
  const emojiCount = (text.match(EMOJI_REGEX) || []).length;
  return emojiCount >= 6 && emojiCount > text.replace(/\s/g, '').length / 3;
}

/**
 * Runs all applicable text checks in order and returns the first failure
 * as a short, friendly message - or null if the answer passes everything.
 */
function moderateTextAnswer(rawText, question, session) {
  const text = rawText;
  const trimmed = text.trim();
  const minLen = question.minLength || MIN_LEN_DEFAULT;

  // 1. Empty / whitespace-only
  if (trimmed.length === 0) return "That message looks empty - please write an actual answer.";

  // 16. Control / zero-width characters (often used to sneak past filters)
  if (ZERO_WIDTH_REGEX.test(text)) return "Your message contains hidden characters - please retype it normally.";

  // 3. Maximum length cap
  if (trimmed.length > MAX_LEN) return `That's a bit long - please keep your answer under ${MAX_LEN} characters.`;

  // 18. Token / webhook leak protection
  if (TOKEN_REGEX.test(trimmed)) {
    return "That looks like it might contain a Discord token or webhook URL - please remove it and answer in plain text.";
  }

  // 5. Discord invite links
  if (INVITE_REGEX.test(trimmed)) return "Please don't include Discord invite links in your answers.";

  // 6. Other links
  if (URL_REGEX.test(trimmed)) return "Please don't include links in your answers - describe it in your own words.";

  // 7. Mass mentions / pings
  if (MASS_MENTION_REGEX.test(trimmed)) return "Please don't include pings or mentions in your answers.";

  // 4. Blocked words (leetspeak-normalized)
  const normalized = normalizeForBadWords(trimmed);
  if (BLOCKED_WORDS.some((w) => normalized.includes(w))) {
    return "That language isn't allowed here.";
  }

  // 14. Emoji-only message
  if (isEmojiOnly(trimmed)) return "Please answer with words, not just emojis.";

  // 15. Excessive emoji ratio
  if (hasExcessiveEmojiRatio(trimmed)) return "Please cut back on the emojis and answer in plain text.";

  // 10. ALL CAPS shouting
  if (isAllCaps(trimmed)) return "No need to shout - please retype that without all caps.";

  // 11. Excessive punctuation spam
  if (hasExcessivePunctuation(trimmed)) return 'Please avoid spamming punctuation (e.g. "!!!!!").';

  // 2. Minimum length
  if (trimmed.length < minLen) {
    return `Please give a bit more detail (at least ${minLen} characters) so staff can properly review your application.`;
  }

  if (question.requireEffort) {
    // 8. Repeated-character gibberish
    if (isRepeatedCharGibberish(trimmed)) return "That doesn't look like a real answer - please try again.";

    // 9. No-vowel gibberish
    if (isNoVowelGibberish(trimmed)) return "That doesn't look like a real answer - please try again.";

    // 13. Word-repetition spam
    if (hasWordRepetitionSpam(trimmed)) return "Please give a genuine answer instead of repeating the same word.";

    // 12. Low-effort / lazy answers
    if (LOW_EFFORT_ANSWERS.has(trimmed.toLowerCase())) {
      return 'Please write a genuine, specific answer rather than a one-word reply.';
    }
  }

  // 17. Duplicate-answer detection (copy-pasting a previous answer verbatim)
  const previousAnswers = Object.values(session.answers);
  if (question.requireEffort && previousAnswers.some((a) => a && a.trim().toLowerCase() === trimmed.toLowerCase())) {
    return "You've already used that exact answer for another question - please write something specific to this one.";
  }

  return null;
}

// 19. Numeric scale validation (1-10)
function moderateScaleAnswer(text) {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    return 'Please answer with a whole number from 1 to 10.';
  }
  return null;
}

// ============================================================
// DEPARTMENTS & QUESTIONS - 15 per department (7 shared + 8 own)
// ============================================================
const COMMON_QUESTIONS = [
  { key: 'roblox_username', text: 'What is your Roblox username?', minLength: 3 },
  { key: 'age', text: 'How old are you?', type: 'age' },
  { key: 'timezone', text: 'What timezone do you live in? (e.g. EST, CET, GMT+1)', minLength: 2 },
  { key: 'heard_about', text: 'How did you hear about WestJet | PTFS?', minLength: 5 },
  { key: 'ptfs_activity', text: 'On a scale from 1 to 10, how active are you on PTFS?', type: 'scale' },
  { key: 'discord_activity', text: 'On a scale from 1 to 10, how active are you on this Discord server?', type: 'scale' },
  {
    key: 'motivation',
    text: 'Why do you want to join the WestJet team specifically, and what would you bring to it?',
    minLength: 15,
    requireEffort: true,
  },
];

const DEPARTMENTS = {
  atc: {
    label: 'Air Traffic Control (ATC)',
    emoji: '🛫',
    color: BRAND_COLOR,
    questions: [
      { key: 'atc_training', text: 'Have you had any ATC training before (ProController, IVAO, VATSIM, in-game training, etc.)? Describe it.', minLength: 5, requireEffort: true },
      { key: 'atc_phraseology', text: 'On a scale from 1 to 10, how would you rate your knowledge of ATC phraseology?', type: 'scale' },
      { key: 'atc_runway_conflict', text: 'Two aircraft request the same runway at the same time. Walk me through how you would handle it.', minLength: 15, requireEffort: true },
      { key: 'atc_emergency', text: 'A pilot declares an emergency mid-approach. What are your immediate priorities as ATC?', minLength: 15, requireEffort: true },
      { key: 'atc_weather', text: 'Weather suddenly closes your active runway. How do you manage the aircraft already in your airspace?', minLength: 15, requireEffort: true },
      { key: 'atc_communication', text: 'On a scale from 1 to 10, how would you rate your clarity and calm when speaking under pressure?', type: 'scale' },
      { key: 'atc_availability', text: 'What days/times are you usually available to control traffic?', minLength: 5, requireEffort: true },
      { key: 'atc_why', text: 'Why do you specifically want to work in ATC rather than another department?', minLength: 15, requireEffort: true },
    ],
  },
  mod: {
    label: 'Server Moderator',
    emoji: '🛡️',
    color: BRAND_GOLD,
    questions: [
      { key: 'mod_experience', text: 'Have you moderated a Discord server before? Describe your experience and responsibilities.', minLength: 15, requireEffort: true },
      { key: 'mod_scenario_spam', text: 'A member is spamming the chat and insulting others while a friend of theirs defends them publicly. What steps do you take, in order?', minLength: 15, requireEffort: true },
      { key: 'mod_scenario_conflict', text: 'You need to warn a close friend of yours on staff for breaking the rules. How do you handle that fairly?', minLength: 15, requireEffort: true },
      { key: 'mod_scenario_report', text: 'Someone reports another member for something that turns out to be false. How do you handle the situation afterward?', minLength: 15, requireEffort: true },
      { key: 'mod_rule_knowledge', text: "On a scale from 1 to 10, how well do you know this server's rules?", type: 'scale' },
      { key: 'mod_deescalation', text: 'Describe your general approach to de-escalating an argument between two upset members.', minLength: 15, requireEffort: true },
      { key: 'mod_availability', text: 'How many hours per week can you realistically dedicate to moderating, and at what times?', minLength: 5, requireEffort: true },
      { key: 'mod_why', text: 'Why do you want to be a moderator here specifically?', minLength: 15, requireEffort: true },
    ],
  },
  cabin: {
    label: 'Cabin Crew',
    emoji: '🧳',
    color: 0x4EA5D9,
    questions: [
      { key: 'cabin_experience', text: 'Have you been cabin crew before, here or on another server? What did that involve?', minLength: 5, requireEffort: true },
      { key: 'cabin_unhappy_passenger', text: "A passenger is upset because their meal preference wasn't honored and is being loud about it. How would you handle it?", minLength: 15, requireEffort: true },
      { key: 'cabin_teamwork', text: 'Describe a time you worked closely with a team toward a shared goal (gaming or real life). What was your role?', minLength: 15, requireEffort: true },
      { key: 'cabin_medical', text: 'A passenger says they feel unwell mid-flight. What are your first steps?', minLength: 15, requireEffort: true },
      { key: 'cabin_service_rating', text: 'On a scale from 1 to 10, how would you rate your own customer-service attitude?', type: 'scale' },
      { key: 'cabin_communication', text: 'How comfortable are you speaking in front of a group of passengers (briefings, announcements)?', minLength: 10, requireEffort: true },
      { key: 'cabin_availability', text: 'What are your usual availabilities for flights (days/times, with your timezone)?', minLength: 5, requireEffort: true },
      { key: 'cabin_why', text: 'Why do you want to be cabin crew specifically, rather than another department?', minLength: 15, requireEffort: true },
    ],
  },
  pilot: {
    label: 'Pilot / Flight Deck',
    emoji: '✈️',
    color: 0x6C4AB6,
    questions: [
      { key: 'pilot_rank', text: 'What is your current PTFS rank, and roughly how many flight hours do you have?', minLength: 3, requireEffort: true },
      { key: 'pilot_aircraft', text: 'What is your favorite aircraft to fly on PTFS, and why?', minLength: 15, requireEffort: true },
      { key: 'pilot_engine_failure', text: 'You lose an engine shortly after takeoff on a busy route. What is your immediate plan?', minLength: 15, requireEffort: true },
      { key: 'pilot_diversion', text: 'Weather at your destination suddenly drops below minimums while you are en route. What do you do?', minLength: 15, requireEffort: true },
      { key: 'pilot_license', text: 'Do you hold any license, rating, or certification worth mentioning (in PTFS or otherwise)?', minLength: 2 },
      { key: 'pilot_instruments', text: 'On a scale from 1 to 10, how confident are you flying with instruments only (no visual reference)?', type: 'scale' },
      { key: 'pilot_availability', text: 'What are your usual availabilities for flights (days/times, with your timezone)?', minLength: 5, requireEffort: true },
      { key: 'pilot_why', text: 'Why do you want to fly for WestJet specifically, and what are your long-term goals here?', minLength: 15, requireEffort: true },
    ],
  },
  ground: {
    label: 'Ground Crew',
    emoji: '🧰',
    color: 0x8B5E3C,
    questions: [
      { key: 'ground_experience', text: 'Have you done ground handling before (marshalling, pushback, baggage)? Describe it.', minLength: 5, requireEffort: true },
      { key: 'ground_marshalling', text: 'Describe how you would marshal an aircraft safely into a tight gate.', minLength: 15, requireEffort: true },
      { key: 'ground_scenario_weather', text: 'A snowstorm hits and several flights need de-icing at once. How do you prioritize?', minLength: 15, requireEffort: true },
      { key: 'ground_safety', text: 'What safety checks do you always do before approaching an active aircraft?', minLength: 15, requireEffort: true },
      { key: 'ground_scenario_damage', text: 'You notice minor damage on a plane during turnaround. What do you do?', minLength: 15, requireEffort: true },
      { key: 'ground_pressure_rating', text: 'On a scale from 1 to 10, how well do you work under time pressure during a fast turnaround?', type: 'scale' },
      { key: 'ground_availability', text: 'What days/times are you usually available for ground shifts?', minLength: 5, requireEffort: true },
      { key: 'ground_why', text: 'Why do you want to join ground crew specifically, rather than another department?', minLength: 15, requireEffort: true },
    ],
  },
  checkin: {
    label: 'Check-in Agent',
    emoji: '🎫',
    color: 0x2E8B99,
    questions: [
      { key: 'checkin_experience', text: 'Do you have any customer-service experience, here or elsewhere? Describe it.', minLength: 5, requireEffort: true },
      { key: 'checkin_scenario_late', text: 'A passenger arrives right at the check-in cutoff and is panicking. What do you do?', minLength: 15, requireEffort: true },
      { key: 'checkin_scenario_document', text: "A passenger's ID or passport looks invalid or doesn't match their booking. How do you handle it?", minLength: 15, requireEffort: true },
      { key: 'checkin_scenario_overbook', text: 'The flight is overbooked and you need volunteers to take a later flight. How do you approach passengers about it?', minLength: 15, requireEffort: true },
      { key: 'checkin_scenario_baggage', text: "A passenger's bag is overweight and they refuse to pay the fee. How do you resolve it?", minLength: 15, requireEffort: true },
      { key: 'checkin_patience_rating', text: 'On a scale from 1 to 10, how would you rate your patience with difficult passengers?', type: 'scale' },
      { key: 'checkin_availability', text: 'What days/times are you usually available for check-in shifts?', minLength: 5, requireEffort: true },
      { key: 'checkin_why', text: 'Why do you want to be a check-in agent specifically, rather than another department?', minLength: 15, requireEffort: true },
    ],
  },
};

function getFullQuestionList(deptKey) {
  return [...COMMON_QUESTIONS, ...DEPARTMENTS[deptKey].questions];
}

// ============================================================
// ACTIVE APPLICATION SESSIONS (in memory)
// ============================================================
const sessions = new Map();
function clearSession(userId) {
  const s = sessions.get(userId);
  if (s?.timeout) clearTimeout(s.timeout);
  sessions.delete(userId);
}

// ============================================================
// CLIENT
// ============================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Post the WestJet application panel').toJSON(),
  ];
  const rest = new REST().setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('/panel slash command registered.');
  } catch (err) {
    console.error('Error registering slash command:', err);
  }
});

// ============================================================
// HELPERS
// ============================================================
function isStaff(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) return true;
  return false;
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle(`✈️  Join the ${BRAND_NAME} Team`)
    .setDescription(
      '**Welcome aboard!** Select the department you would like to apply for below.\n\n' +
        'You will be asked a series of questions **in your DMs**, one at a time. ' +
        'Please make sure your DMs are open before applying.\n\n' +
        '🛫 **ATC** — direct traffic and keep the skies safe\n' +
        '🛡️ **Moderator** — help keep the community friendly and fair\n' +
        '🧳 **Cabin Crew** — deliver the in-flight experience\n' +
        '✈️ **Pilot** — take the controls on scheduled flights\n' +
        '🧰 **Ground Crew** — marshal, push back and turn around aircraft\n' +
        '🎫 **Check-in Agent** — welcome passengers and get them to the gate'
    )
    .setColor(BRAND_COLOR)
    .setThumbnail(BRAND_THUMBNAIL)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();
}

function buildPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('apply_atc').setLabel('ATC').setEmoji('🛫').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('apply_mod').setLabel('Moderator').setEmoji('🛡️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('apply_cabin').setLabel('Cabin Crew').setEmoji('🧳').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('apply_pilot').setLabel('Pilot').setEmoji('✈️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('apply_ground').setLabel('Ground Crew').setEmoji('🧰').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('apply_checkin').setLabel('Check-in Agent').setEmoji('🎫').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildConfirmEmbed(deptKey) {
  const dept = DEPARTMENTS[deptKey];
  return new EmbedBuilder()
    .setTitle(`${dept.emoji}  ${dept.label} Application`)
    .setDescription(
      'Are you sure you want to apply?\n\n' +
        'This application has **15 questions** and you will have **3 hours** to complete it once started. ' +
        'Answer honestly and with real detail - low-effort or inappropriate answers will be rejected automatically and asked again.\n\n' +
        'You can cancel at any time using the button below the questions.'
    )
    .setColor(dept.color)
    .setThumbnail(BRAND_THUMBNAIL)
    .setFooter({ text: BRAND_FOOTER });
}

function buildConfirmRow(deptKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`start_${deptKey}`).setLabel('Start Application').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cancel_confirm').setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );
}

function renderProgressBar(step, total, length = 12) {
  const filled = Math.round((step / total) * length);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, length - filled));
}

function buildQuestionEmbed(deptKey, step) {
  const dept = DEPARTMENTS[deptKey];
  const list = getFullQuestionList(deptKey);
  const q = list[step];
  const progress = renderProgressBar(step, list.length);

  return new EmbedBuilder()
    .setTitle(`${dept.emoji}  ${dept.label}`)
    .setDescription(`**Question ${step + 1} / ${list.length}**\n${progress}\n\n${q.text}`)
    .setColor(dept.color)
    .setFooter({ text: BRAND_FOOTER });
}

function buildRepromptEmbed(deptKey, step, reason) {
  return new EmbedBuilder()
    .setTitle('⚠️  Please try again')
    .setDescription(`${reason}\n\n**Question ${step + 1}:**\n${getFullQuestionList(deptKey)[step].text}`)
    .setColor(BRAND_DENY);
}

function buildCancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cancel_application').setLabel('Cancel Application').setEmoji('✖️').setStyle(ButtonStyle.Danger)
  );
}

function buildSummaryEmbed(deptKey, user, answers) {
  const dept = DEPARTMENTS[deptKey];
  const list = getFullQuestionList(deptKey);
  const embed = new EmbedBuilder()
    .setTitle(`${dept.emoji}  New Application — ${dept.label}`)
    .setColor(dept.color)
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: `${BRAND_FOOTER} • User ID: ${user.id}` })
    .setTimestamp();

  for (const q of list) {
    embed.addFields({ name: q.text, value: String(answers[q.key] ?? 'N/A').slice(0, 1024) });
  }
  embed.addFields({ name: 'Applicant', value: `<@${user.id}> (${user.tag})` });
  return embed;
}

function buildReviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept_${userId}`).setLabel('Accept').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_${userId}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger)
  );
}

function extractAge(text) {
  const match = text.match(/-?\d+/);
  if (!match) return NaN;
  return parseInt(match[0], 10);
}

async function autoBlacklistForAge(user, guild) {
  addToBlacklist(user.id, user.tag, `Stated an age under ${MIN_AGE} during application`);

  try {
    const member = await guild.members.fetch(user.id);
    if (member.kickable) await member.kick(`Auto-blacklist: stated age under ${MIN_AGE}`);
  } catch (err) {
    console.error(`Could not kick ${user.id}:`, err.message);
  }

  try {
    await user.send(
      "Your application has been stopped because you don't meet the minimum age requirement (13+) " +
        'to use Discord and to be a member of this server. You have been blacklisted from applying again.'
    );
  } catch {
    // DMs closed
  }

  if (LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setTitle('🚫 Auto-blacklist: underage applicant')
        .setDescription(`<@${user.id}> (${user.tag}) stated an age under ${MIN_AGE} and was auto-blacklisted + kicked.`)
        .setColor(BRAND_DENY)
        .setTimestamp();
      await logChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error('Could not send to log channel:', err.message);
    }
  }
}

async function sendNextQuestion(user) {
  const session = sessions.get(user.id);
  if (!session) return;

  const list = getFullQuestionList(session.deptKey);
  if (session.step >= list.length) return finishApplication(user);

  await user.send({ embeds: [buildQuestionEmbed(session.deptKey, session.step)], components: [buildCancelRow()] });

  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    sessions.delete(user.id);
    try {
      await user.send('⏰ You took longer than 3 hours to answer, so your application has expired. Please start a new one if you are still interested.');
    } catch {
      // ignore
    }
  }, APPLICATION_TIMEOUT_MS);
}

async function finishApplication(user) {
  const session = sessions.get(user.id);
  if (!session) return;

  const embed = buildSummaryEmbed(session.deptKey, user, session.answers);

  if (REVIEW_CHANNEL_ID) {
    try {
      const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID);
      await reviewChannel.send({ embeds: [embed], components: [buildReviewRow(user.id)] });
    } catch (err) {
      console.error('Could not post to review channel:', err.message);
    }
  }

  try {
    await user.send("🎉 Thank you! Your application has been submitted and is now being reviewed by WestJet staff. We'll follow up here as soon as a decision is made.");
  } catch {
    // ignore
  }

  clearSession(user.id);
}

// ============================================================
// INTERACTIONS (slash command + buttons)
// ============================================================
client.on('interactionCreate', async (interaction) => {
  // ---- /panel slash command ----
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '🚫 You are not allowed to do that.', ephemeral: true });
    }
    await interaction.channel.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
    return interaction.reply({ content: '✅ Panel posted.', ephemeral: true });
  }

  if (!interaction.isButton()) return;
  const { customId, user } = interaction;

  // ---- Step 1: user clicks a department button on the panel ----
  if (customId.startsWith('apply_')) {
    const deptKey = customId.replace('apply_', '');
    if (!DEPARTMENTS[deptKey]) return;

    if (isBlacklisted(user.id)) {
      return interaction.reply({ content: '🚫 You are blacklisted and cannot submit applications.', ephemeral: true });
    }
    if (sessions.has(user.id)) {
      return interaction.reply({ content: '📨 You already have an application in progress. Check your DMs.', ephemeral: true });
    }

    try {
      await user.send({ embeds: [buildConfirmEmbed(deptKey)], components: [buildConfirmRow(deptKey)] });
      await interaction.reply({ content: '✅ Check your DMs!', ephemeral: true });
    } catch {
      await interaction.reply({ content: "❌ I can't DM you! Please enable direct messages from server members and try again.", ephemeral: true });
    }
    return;
  }

  // ---- Step 2: confirmation buttons in DM ----
  if (customId.startsWith('start_')) {
    const deptKey = customId.replace('start_', '');
    if (!DEPARTMENTS[deptKey]) return;

    if (isBlacklisted(user.id)) {
      return interaction.update({ content: '🚫 You are blacklisted and cannot submit applications.', embeds: [], components: [] });
    }

    sessions.set(user.id, { deptKey, step: 0, answers: {}, timeout: null, guildId: GUILD_ID, repromptCount: 0 });

    await interaction.update({ content: '🚀 Your application has started!', embeds: [], components: [] });
    await sendNextQuestion(user);
    return;
  }

  if (customId === 'cancel_confirm') {
    return interaction.update({ content: '✖️ Application cancelled.', embeds: [], components: [] });
  }

  if (customId === 'cancel_application') {
    clearSession(user.id);
    return interaction.update({ content: '✖️ Your application has been cancelled.', embeds: [], components: [] });
  }

  // ---- Staff review buttons ----
  if (customId.startsWith('accept_') || customId.startsWith('deny_')) {
    const member = interaction.member;
    if (!isStaff(member)) {
      return interaction.reply({ content: '🚫 You are not allowed to review applications.', ephemeral: true });
    }

    const applicantId = customId.split('_')[1];
    const accepted = customId.startsWith('accept_');

    const oldEmbed = interaction.message.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(accepted ? BRAND_COLOR : BRAND_DENY)
      .setFooter({ text: `${accepted ? '✅ Accepted' : '❌ Denied'} by ${interaction.user.tag}` });

    await interaction.update({ embeds: [newEmbed], components: [] });

    try {
      const applicant = await client.users.fetch(applicantId);
      await applicant.send(
        accepted
          ? `🎉 Congratulations! Your application to **${BRAND_NAME}** has been **accepted**. Staff will be in touch with next steps.`
          : `Thank you for applying to **${BRAND_NAME}**. Unfortunately your application has been **denied** this time. You are welcome to reapply in the future.`
      );
    } catch {
      // ignore
    }
    return;
  }
});

// ============================================================
// MESSAGES (DM answers only - no text commands in this version)
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.guild) return; // DM only

  const session = sessions.get(message.author.id);
  if (!session) return;

  const list = getFullQuestionList(session.deptKey);
  const currentQuestion = list[session.step];

  // --- Age question: special auto-blacklist path ---
  if (currentQuestion.type === 'age') {
    const age = extractAge(message.content);
    if (Number.isNaN(age) || age < MIN_AGE) {
      const guild =
        client.guilds.cache.get(session.guildId) ||
        (await client.guilds.fetch(session.guildId).catch(() => null));
      clearSession(message.author.id);
      if (guild) {
        await autoBlacklistForAge(message.author, guild);
      } else {
        addToBlacklist(message.author.id, message.author.tag, `Stated an age under ${MIN_AGE} during application`);
        try {
          await message.author.send('Your application has been stopped because you do not meet the minimum age requirement (13+).');
        } catch {}
      }
      return;
    }
    session.answers[currentQuestion.key] = String(age);
    session.step += 1;
    session.repromptCount = 0;
    return sendNextQuestion(message.author);
  }

  // --- Scale question (1-10) ---
  if (currentQuestion.type === 'scale') {
    const error = moderateScaleAnswer(message.content);
    if (error) {
      await message.author.send({ embeds: [buildRepromptEmbed(session.deptKey, session.step, error)], components: [buildCancelRow()] });
      return;
    }
    session.answers[currentQuestion.key] = message.content.trim();
    session.step += 1;
    session.repromptCount = 0;
    return sendNextQuestion(message.author);
  }

  // --- Regular text question, passed through the 20 moderation checks ---
  const error = moderateTextAnswer(message.content, currentQuestion, session);
  if (error) {
    session.repromptCount = (session.repromptCount || 0) + 1;

    if (session.repromptCount > MAX_REPROMPTS) {
      session.answers[currentQuestion.key] = `${message.content}\n\n_(⚠️ flagged: repeated moderation failures)_`;
      session.step += 1;
      session.repromptCount = 0;
      await message.author.send("Thanks for your patience - we'll let staff take a closer look at that answer during review.");
      return sendNextQuestion(message.author);
    }

    await message.author.send({ embeds: [buildRepromptEmbed(session.deptKey, session.step, error)], components: [buildCancelRow()] });
    return;
  }

  session.answers[currentQuestion.key] = message.content.trim();
  session.step += 1;
  session.repromptCount = 0;
  return sendNextQuestion(message.author);
});

client.login(TOKEN);

// ============================================================
// FAKE HTTP SERVER (Render port check)
// ============================================================
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WestJet | PTFS apply bot is running.');
  })
  .listen(PORT, () => {
    console.log(`Fake HTTP server listening on port ${PORT} (for Render's port check)`);
  });
