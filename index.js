/**
 * WestJet | PTFS - Application Bot
 * -----------------------------------------------------
 * - Posts a panel with 4 buttons: ATC / Moderator / Cabin Crew / Pilot
 * - Clicking a button DMs the user a confirmation, then asks questions
 *   one by one in their DMs (Appy-style flow).
 * - Built-in DM answer moderation: profanity / gibberish / too-short
 *   answers are rejected with a friendly re-prompt instead of being
 *   silently accepted, so staff don't have to review garbage applications.
 * - If the user states an age under MIN_AGE, they are AUTOMATICALLY
 *   blacklisted (kicked from the server + saved to blacklist.json) and
 *   the application stops immediately.
 * - Finished applications are posted to a staff review channel with
 *   Accept / Deny buttons and a WestJet-branded embed.
 *
 * Files: index.js + package.json (this file). blacklist.json is
 * created automatically the first time someone gets blacklisted.
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
} = require('discord.js');

// ============================================================
// CONFIG - edit these or set them in a .env file (see .env.example)
// ============================================================
const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;                   // your server ID
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID; // where finished apps get posted
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;       // where auto-blacklist / rejection logs go
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;         // role allowed to post the panel / review apps
const PREFIX = '!';
const MIN_AGE = 13;
const APPLICATION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
const MIN_ANSWER_LENGTH = 12;      // "why do you want to join" type questions
const MAX_REPROMPTS = 3;           // how many times we re-ask before soft-flagging
const BRAND_NAME = 'WestJet | PTFS';
const BRAND_FOOTER = 'Sent from WestJet | PTFS';
const BRAND_COLOR = 0x00885A;   // WestJet green
const BRAND_GOLD = 0xF2A900;    // WestJet gold accent
const BRAND_DENY = 0xC8102E;    // WestJet red accent
const BRAND_THUMBNAIL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/WestJet_Logo_2018.svg/512px-WestJet_Logo_2018.svg.png';

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
// ANSWER MODERATION
// -----------------------------------------------------------
// Lightweight, dependency-free checks run on every DM answer before
// it's accepted into the application. Nothing here replaces human
// judgment on the final review - it just filters obvious junk so
// staff aren't stuck reading "idk", "asdf", or slurs in a review
// channel.
// ============================================================

// Keep this list short and generic on purpose - it's a first pass filter,
// not a moderation system. Extend it in your own deployment as needed.
const BLOCKED_WORDS = [
  'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'chink', 'spic', 'kike',
  'rape', 'kys', 'cunt',
];

const LOW_EFFORT_ANSWERS = new Set([
  'idk', 'idc', 'na', 'n/a', 'none', 'nothing', 'lol', 'lmao', 'test',
  'asdf', 'skibidi', 'ok', 'yes', 'no', 'sure', 'meh',
]);

function containsBlockedWord(text) {
  const lowered = text.toLowerCase();
  return BLOCKED_WORDS.some((w) => lowered.includes(w));
}

function isGibberish(text) {
  const cleaned = text.trim();
  if (cleaned.length === 0) return true;
  // Extremely repetitive characters, e.g. "aaaaaaaaaa" or "??????"
  if (/^(.)\1{4,}$/.test(cleaned.replace(/\s/g, ''))) return true;
  // No vowels at all in a longer string usually means keyboard mashing
  if (cleaned.length >= 6 && !/[aeiouAEIOU]/.test(cleaned)) return true;
  return false;
}

/**
 * Validates a free-text answer for the questions that need real effort
 * (motivation, scenario, experience questions). Short numeric / scale
 * answers and the age question are validated separately.
 *
 * Returns { ok: true } or { ok: false, reason: "..." } with a short,
 * friendly reason to show the applicant.
 */
function moderateAnswer(text, question) {
  const trimmed = text.trim();

  if (containsBlockedWord(trimmed)) {
    return { ok: false, reason: 'That answer contains language that is not allowed here.' };
  }

  if (question.minLength && trimmed.length < question.minLength) {
    return {
      ok: false,
      reason: `Please give a bit more detail (at least ${question.minLength} characters) so staff can properly review your application.`,
    };
  }

  if (question.requireEffort) {
    if (isGibberish(trimmed)) {
      return { ok: false, reason: "That doesn't look like a real answer - please try again." };
    }
    if (LOW_EFFORT_ANSWERS.has(trimmed.toLowerCase())) {
      return { ok: false, reason: 'Please write a genuine, specific answer rather than a one-word reply.' };
    }
  }

  return { ok: true };
}

/**
 * Validates a numeric scale answer (1-10 style questions).
 */
function moderateScaleAnswer(text) {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    return { ok: false, reason: 'Please answer with a whole number from 1 to 10.' };
  }
  return { ok: true };
}

// ============================================================
// DEPARTMENTS & QUESTIONS
// ============================================================
// Asked to EVERY applicant first, in this order. "age" is handled
// specially (see checkAge below) no matter which department it's in.
// type: "text" | "scale" | "age"
const COMMON_QUESTIONS = [
  { key: 'roblox_username', text: 'What is your Roblox username?', type: 'text', minLength: 3 },
  { key: 'age', text: 'How old are you?', type: 'age' },
  { key: 'timezone', text: 'What timezone do you live in? (e.g. EST, CET, GMT+1)', type: 'text', minLength: 2 },
  {
    key: 'ptfs_activity',
    text: 'On a scale from 1 to 10, how active are you on PTFS?',
    type: 'scale',
  },
  {
    key: 'discord_activity',
    text: 'On a scale from 1 to 10, how active are you on this Discord server?',
    type: 'scale',
  },
  {
    key: 'motivation',
    text: 'Why do you want to join the WestJet team specifically, and what would you bring to it?',
    type: 'text',
    minLength: MIN_ANSWER_LENGTH,
    requireEffort: true,
  },
  {
    key: 'past_departments',
    text: 'Have you been part of another virtual airline or aviation Discord server before? If so, which one(s), and what did you do there?',
    type: 'text',
    minLength: 3,
    requireEffort: true,
  },
];

const DEPARTMENTS = {
  atc: {
    label: 'Air Traffic Control (ATC)',
    emoji: '🛫',
    color: BRAND_COLOR,
    questions: [
      {
        key: 'atc_training',
        text: 'Have you had any ATC training before (ProController, IVAO, VATSIM, in-game training, etc.)? If so, describe it.',
        type: 'text',
        minLength: 5,
        requireEffort: true,
      },
      {
        key: 'atc_phraseology',
        text: 'On a scale from 1 to 10, how would you rate your knowledge of ATC phraseology?',
        type: 'scale',
      },
      {
        key: 'atc_scenario',
        text: 'Two aircraft request the same runway at the same time and one reports a minor mechanical issue. Walk me through how you would handle it.',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'atc_why',
        text: 'Why do you specifically want to work in ATC rather than another department?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
    ],
  },
  mod: {
    label: 'Server Moderator',
    emoji: '🛡️',
    color: BRAND_GOLD,
    questions: [
      {
        key: 'mod_experience',
        text: 'Have you moderated a Discord server before? Describe your experience and what your responsibilities were.',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'mod_scenario_spam',
        text: 'A member is spamming the chat and insulting other members while a friend of theirs defends them publicly. What steps do you take, in order?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'mod_scenario_conflict',
        text: 'You need to warn a close friend of yours on staff for breaking the rules. How do you handle that fairly?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'mod_availability',
        text: 'How many hours per week can you realistically dedicate to moderating, and at what times of day?',
        type: 'text',
        minLength: 5,
        requireEffort: true,
      },
    ],
  },
  cabin: {
    label: 'Cabin Crew',
    emoji: '🧳',
    color: 0x4EA5D9,
    questions: [
      {
        key: 'cabin_experience',
        text: 'Have you been cabin crew before, here or on another server? What did that role involve?',
        type: 'text',
        minLength: 5,
        requireEffort: true,
      },
      {
        key: 'cabin_service_scenario',
        text: 'A passenger is upset because their meal preference was not honored and they are being loud about it in front of others. How would you handle it?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'cabin_teamwork',
        text: 'Describe a time you had to work closely with a team toward a shared goal (gaming or real life). What was your role?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'cabin_availability',
        text: 'What are your usual availabilities for flights (days and times, with your timezone)?',
        type: 'text',
        minLength: 5,
        requireEffort: true,
      },
    ],
  },
  pilot: {
    label: 'Pilot / Flight Deck',
    emoji: '✈️',
    color: 0x6C4AB6,
    questions: [
      {
        key: 'pilot_rank',
        text: 'What is your current PTFS rank, and roughly how many flight hours do you have?',
        type: 'text',
        minLength: 3,
        requireEffort: true,
      },
      {
        key: 'pilot_aircraft',
        text: 'What is your favorite aircraft to fly on PTFS, and why?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'pilot_emergency',
        text: 'You lose an engine shortly after takeoff on a busy route. In a few sentences, what is your immediate plan?',
        type: 'text',
        minLength: MIN_ANSWER_LENGTH,
        requireEffort: true,
      },
      {
        key: 'pilot_license',
        text: 'Do you hold any license, rating, or certification worth mentioning (in PTFS or otherwise)?',
        type: 'text',
        minLength: 2,
      },
    ],
  },
};

function getFullQuestionList(deptKey) {
  return [...COMMON_QUESTIONS, ...DEPARTMENTS[deptKey].questions];
}

// ============================================================
// ACTIVE APPLICATION SESSIONS (in memory)
// userId -> { deptKey, step, answers, timeout, guildId, repromptCount }
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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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
        'You will be asked a short series of questions **in your DMs**, one at a time - ' +
        'just like a real interview. Please make sure your DMs are open before applying.\n\n' +
        '🛫 **ATC** — direct traffic and keep the skies safe\n' +
        '🛡️ **Moderator** — help keep the community friendly and fair\n' +
        '🧳 **Cabin Crew** — deliver the in-flight experience\n' +
        '✈️ **Pilot** — take the controls on scheduled flights'
    )
    .setColor(BRAND_COLOR)
    .setThumbnail(BRAND_THUMBNAIL)
    .setFooter({ text: BRAND_FOOTER })
    .setTimestamp();
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_atc').setLabel('ATC').setEmoji('🛫').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_mod').setLabel('Moderator').setEmoji('🛡️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('apply_cabin').setLabel('Cabin Crew').setEmoji('🧳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_pilot').setLabel('Pilot').setEmoji('✈️').setStyle(ButtonStyle.Success)
  );
}

function buildConfirmEmbed(deptKey) {
  const dept = DEPARTMENTS[deptKey];
  return new EmbedBuilder()
    .setTitle(`${dept.emoji}  ${dept.label} Application`)
    .setDescription(
      'Are you sure you want to apply?\n\n' +
        `You will have **3 hours** to complete the application once it starts. Answer honestly and with ` +
        'real detail - one-word or joke answers will be rejected automatically and asked again.\n\n' +
        'You can cancel at any time using the button below the questions.'
    )
    .setColor(dept.color)
    .setThumbnail(BRAND_THUMBNAIL)
    .setFooter({ text: BRAND_FOOTER });
}

function buildConfirmRow(deptKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`start_${deptKey}`)
      .setLabel('Start Application')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('cancel_confirm')
      .setLabel('Cancel')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
  );
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

function renderProgressBar(step, total, length = 12) {
  const filled = Math.round((step / total) * length);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, length - filled));
}

function buildRepromptEmbed(deptKey, step, reason) {
  const dept = DEPARTMENTS[deptKey];
  return new EmbedBuilder()
    .setTitle('⚠️  Please try again')
    .setDescription(`${reason}\n\n**Question ${step + 1}:**\n${getFullQuestionList(deptKey)[step].text}`)
    .setColor(BRAND_DENY);
}

function buildCancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cancel_application')
      .setLabel('Cancel Application')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
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
    embed.addFields({
      name: q.text,
      value: String(answers[q.key] ?? 'N/A').slice(0, 1024),
    });
  }
  embed.addFields({ name: 'Applicant', value: `<@${user.id}> (${user.tag})` });
  return embed;
}

function buildReviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${userId}`)
      .setLabel('Accept')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${userId}`)
      .setLabel('Deny')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );
}

// Extracts the first whole number found in a string, e.g. "im 12 lol" -> 12
function extractAge(text) {
  const match = text.match(/-?\d+/);
  if (!match) return NaN;
  return parseInt(match[0], 10);
}

async function autoBlacklistForAge(user, guild) {
  addToBlacklist(user.id, user.tag, `Stated an age under ${MIN_AGE} during application`);

  try {
    const member = await guild.members.fetch(user.id);
    if (member.kickable) {
      await member.kick(`Auto-blacklist: stated age under ${MIN_AGE}`);
    }
  } catch (err) {
    console.error(`Could not kick ${user.id}:`, err.message);
  }

  try {
    await user.send(
      "Your application has been stopped because you don't meet the minimum age requirement (13+) " +
        'to use Discord and to be a member of this server. You have been blacklisted from applying again.'
    );
  } catch {
    // DMs closed, ignore
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

  if (session.step >= list.length) {
    await finishApplication(user);
    return;
  }

  const embed = buildQuestionEmbed(session.deptKey, session.step);
  await user.send({ embeds: [embed], components: [buildCancelRow()] });

  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    sessions.delete(user.id);
    try {
      await user.send(
        '⏰ You took longer than 3 hours to answer, so your application has expired. Please start a new one if you are still interested.'
      );
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
    await user.send(
      '🎉 Thank you! Your application has been submitted and is now being reviewed by WestJet staff. ' +
        "We'll follow up here as soon as a decision is made."
    );
  } catch {
    // ignore
  }

  clearSession(user.id);
}

// ============================================================
// INTERACTIONS (buttons)
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId, user } = interaction;

  // ---- Step 1: user clicks a department button on the panel ----
  if (customId.startsWith('apply_')) {
    const deptKey = customId.replace('apply_', '');
    if (!DEPARTMENTS[deptKey]) return;

    if (isBlacklisted(user.id)) {
      return interaction.reply({
        content: '🚫 You are blacklisted and cannot submit applications.',
        ephemeral: true,
      });
    }

    if (sessions.has(user.id)) {
      return interaction.reply({
        content: '📨 You already have an application in progress. Check your DMs.',
        ephemeral: true,
      });
    }

    try {
      await user.send({
        embeds: [buildConfirmEmbed(deptKey)],
        components: [buildConfirmRow(deptKey)],
      });
      await interaction.reply({ content: '✅ Check your DMs!', ephemeral: true });
    } catch {
      await interaction.reply({
        content: "❌ I can't DM you! Please enable direct messages from server members and try again.",
        ephemeral: true,
      });
    }
    return;
  }

  // ---- Step 2: confirmation buttons in DM ----
  if (customId.startsWith('start_')) {
    const deptKey = customId.replace('start_', '');
    if (!DEPARTMENTS[deptKey]) return;

    if (isBlacklisted(user.id)) {
      return interaction.update({
        content: '🚫 You are blacklisted and cannot submit applications.',
        embeds: [],
        components: [],
      });
    }

    sessions.set(user.id, {
      deptKey,
      step: 0,
      answers: {},
      timeout: null,
      guildId: GUILD_ID,
      repromptCount: 0,
    });

    await interaction.update({
      content: '🚀 Your application has started!',
      embeds: [],
      components: [],
    });
    await sendNextQuestion(user);
    return;
  }

  if (customId === 'cancel_confirm') {
    return interaction.update({ content: '✖️ Application cancelled.', embeds: [], components: [] });
  }

  // ---- Cancel mid-application ----
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
      // ignore if DMs closed
    }
    return;
  }
});

// ============================================================
// MESSAGES (DM answers + text commands)
// ============================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ---- Handle DM answers to an active application ----
  if (!message.guild) {
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
            await message.author.send(
              'Your application has been stopped because you do not meet the minimum age requirement (13+).'
            );
          } catch {}
        }
        return;
      }
      session.answers[currentQuestion.key] = String(age);
      session.step += 1;
      session.repromptCount = 0;
      await sendNextQuestion(message.author);
      return;
    }

    // --- Scale question (1-10) ---
    if (currentQuestion.type === 'scale') {
      const result = moderateScaleAnswer(message.content);
      if (!result.ok) {
        await message.author.send({
          embeds: [buildRepromptEmbed(session.deptKey, session.step, result.reason)],
          components: [buildCancelRow()],
        });
        return;
      }
      session.answers[currentQuestion.key] = message.content.trim();
      session.step += 1;
      session.repromptCount = 0;
      await sendNextQuestion(message.author);
      return;
    }

    // --- Regular text question, passed through moderation ---
    const result = moderateAnswer(message.content, currentQuestion);
    if (!result.ok) {
      session.repromptCount = (session.repromptCount || 0) + 1;

      // After too many rejected attempts, flag it for staff instead of
      // looping the applicant forever - could be a language barrier, not
      // bad faith.
      if (session.repromptCount > MAX_REPROMPTS) {
        session.answers[currentQuestion.key] = `${message.content} \n\n_(⚠️ flagged: repeated moderation failures)_`;
        session.step += 1;
        session.repromptCount = 0;
        await message.author.send(
          "Thanks for your patience - we'll let staff take a closer look at that answer during review."
        );
        await sendNextQuestion(message.author);
        return;
      }

      await message.author.send({
        embeds: [buildRepromptEmbed(session.deptKey, session.step, result.reason)],
        components: [buildCancelRow()],
      });
      return;
    }

    session.answers[currentQuestion.key] = message.content.trim();
    session.step += 1;
    session.repromptCount = 0;
    await sendNextQuestion(message.author);
    return;
  }

  // ---- Text commands (server channels only) ----
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'panel') {
    await message.channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
    return;
  }

  if (command === 'ping') {
    const sent = await message.reply('Pinging...');
    const latency = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit(`🏓 Pong! Latency: ${latency}ms | API: ${Math.round(client.ws.ping)}ms`);
  }

  if (command === 'about') {
    const embed = new EmbedBuilder()
      .setTitle(`✈️  ${BRAND_NAME} Apply Bot`)
      .setDescription(
        'I handle applications for **ATC**, **Moderator**, **Cabin Crew** and **Pilot** positions, ' +
          'and automatically filter out low-effort or inappropriate DM answers.\n\n' +
          'Type `!panel` to post the application panel, or `!help` to see everything I can do.'
      )
      .addFields(
        { name: 'Departments', value: Object.values(DEPARTMENTS).map((d) => `${d.emoji} ${d.label}`).join('\n') },
        { name: 'Minimum age', value: `${MIN_AGE}+`, inline: true },
        { name: 'Time limit', value: '3 hours per application', inline: true }
      )
      .setColor(BRAND_COLOR)
      .setThumbnail(BRAND_THUMBNAIL)
      .setFooter({ text: BRAND_FOOTER });
    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'myapp') {
    const session = sessions.get(message.author.id);
    if (!session) {
      return message.reply(
        isBlacklisted(message.author.id)
          ? "🚫 You don't have an active application, and you're currently blacklisted from applying."
          : "You don't have an application in progress. Click a button on the panel to start one!"
      );
    }
    const list = getFullQuestionList(session.deptKey);
    return message.reply(
      `You're applying for **${DEPARTMENTS[session.deptKey].label}** — question ${session.step + 1}/${list.length}. Check your DMs to keep answering, or click "Cancel Application" there to stop.`
    );
  }

  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('📋 Commands')
      .setColor(BRAND_COLOR)
      .addFields(
        { name: '!panel', value: 'Post the application panel (ATC / Moderator / Cabin Crew / Pilot buttons).' },
        { name: '!myapp', value: 'Check the status of your own in-progress application.' },
        { name: '!ping', value: "Check the bot's latency." },
        { name: '!about', value: 'Info about this bot.' },
        { name: '!blacklist', value: '*(staff only)* List everyone who is blacklisted and why.' },
        { name: '!unblacklist <userId or @mention>', value: '*(staff only)* Remove someone from the blacklist.' }
      )
      .setFooter({ text: BRAND_FOOTER });
    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'blacklist') {
    if (!isStaff(message.member)) {
      return message.reply("You don't have permission to do that.");
    }
    const bl = loadBlacklist();
    const ids = Object.keys(bl);
    if (ids.length === 0) return message.reply('The blacklist is empty.');
    const lines = ids.map((id) => `<@${id}> (${bl[id].tag}) - ${bl[id].reason}`);
    return message.reply(lines.join('\n').slice(0, 1900));
  }

  if (command === 'unblacklist') {
    if (!isStaff(message.member)) {
      return message.reply("You don't have permission to do that.");
    }
    const targetId = message.mentions.users.first()?.id || args[0];
    if (!targetId) return message.reply('Usage: `!unblacklist <userId or @mention>`');
    const existed = removeFromBlacklist(targetId);
    return message.reply(existed ? `<@${targetId}> has been removed from the blacklist.` : 'That user was not blacklisted.');
  }
});

client.login(TOKEN);

// ============================================================
// FAKE HTTP SERVER
// ------------------------------------------------------------
// Discord bots don't need a web server, but Render's "Web Service"
// plan expects something to be listening on a port. This tiny
// server just answers "OK" so Render's port check passes. If you
// deploy this as a "Background Worker" on Render instead, this
// block is harmless and simply won't be checked.
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
