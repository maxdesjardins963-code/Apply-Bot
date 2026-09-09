/**
 * AF | PTFS - Appy-style application bot
 * -----------------------------------------------------
 * - Posts a panel with 4 buttons: ATC / Moderator / Cabin Crew / Pilot
 * - Clicking a button DMs the user a confirmation, then asks questions
 *   one by one in their DMs (just like the original "Appy" bot).
 * - If the user states an age under MIN_AGE, they are AUTOMATICALLY
 *   blacklisted (kicked from the server + saved to blacklist.json) and
 *   the application stops immediately.
 * - Finished applications are posted to a staff review channel with
 *   Accept / Deny buttons.
 *
 * Files: index.js + package.json (this file). blacklist.json is
 * created automatically the first time someone gets blacklisted.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
const GUILD_ID = process.env.GUILD_ID;                 // your server ID
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID; // where finished apps get posted
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;       // where auto-blacklist actions get logged
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;         // role allowed to post the panel / review apps
const PREFIX = '!';
const MIN_AGE = 13;
const APPLICATION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours, same as Appy
const BRAND_FOOTER = 'Sent from Air France | PTFS';

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
// DEPARTMENTS & QUESTIONS
// ============================================================
// Asked to EVERY applicant first, in this order. "age" is handled
// specially (see checkAge below) no matter which department it's in.
const COMMON_QUESTIONS = [
  { key: 'roblox_username', text: 'What is your Roblox username?' },
  { key: 'age', text: 'How old are you?' },
  {
    key: 'ptfs_activity',
    text: 'On a scale from 1-10, how active are you on PTFS?',
  },
  {
    key: 'discord_activity',
    text: 'On a scale from 1-10, how active are you on this Discord server?',
  },
  {
    key: 'motivation',
    text: 'Why do you want to join our team? What motivates you?',
  },
];

const DEPARTMENTS = {
  atc: {
    label: 'Air Traffic Control (ATC)',
    color: 0x3ba55d,
    questions: [
      {
        key: 'atc_training',
        text: 'Have you had any ATC training before (ProController, IVAO, VATSIM, etc.)? If so, where?',
      },
      {
        key: 'atc_phraseology',
        text: 'On a scale from 1-10, how would you rate your knowledge of ATC phraseology?',
      },
      { key: 'atc_why', text: 'Why do you want to join the ATC team?' },
    ],
  },
  mod: {
    label: 'Server Moderator',
    color: 0xed4245,
    questions: [
      {
        key: 'mod_experience',
        text: 'Have you moderated a Discord server before? Describe your experience.',
      },
      {
        key: 'mod_scenario',
        text: 'A member is spamming the chat and insulting other members. What steps do you take?',
      },
      {
        key: 'mod_availability',
        text: 'How many hours per week can you dedicate to moderating?',
      },
    ],
  },
  cabin: {
    label: 'Cabin Crew',
    color: 0x5865f2,
    questions: [
      {
        key: 'cabin_experience',
        text: 'Have you been cabin crew before (here or on another server)?',
      },
      {
        key: 'cabin_service',
        text: 'How would you handle an unhappy passenger during a flight?',
      },
      {
        key: 'cabin_availability',
        text: 'What are your usual availabilities for flights (days/times)?',
      },
    ],
  },
  pilot: {
    label: 'Pilot / Flight Deck',
    color: 0xf1c40f,
    questions: [
      {
        key: 'pilot_rank',
        text: 'What is your current PTFS rank and how many flight hours do you have?',
      },
      {
        key: 'pilot_aircraft',
        text: 'What is your favorite aircraft to fly on PTFS and why?',
      },
      {
        key: 'pilot_license',
        text: 'Do you hold any license or certification worth mentioning?',
      },
    ],
  },
};

function getFullQuestionList(deptKey) {
  return [...COMMON_QUESTIONS, ...DEPARTMENTS[deptKey].questions];
}

// ============================================================
// ACTIVE APPLICATION SESSIONS (in memory)
// userId -> { deptKey, step, answers, timeout, guildId }
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
    .setTitle('Join the Air France | PTFS team')
    .setDescription(
      'Click a button below to apply for one of the open positions.\n\n' +
        'You will be asked a series of questions **in your DMs**. ' +
        'Make sure your DMs are open before applying.'
    )
    .setColor(0x2b2d31)
    .setFooter({ text: BRAND_FOOTER });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('apply_atc').setLabel('ATC').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('apply_mod').setLabel('Moderator').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('apply_cabin').setLabel('Cabin Crew').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('apply_pilot').setLabel('Pilot').setStyle(ButtonStyle.Success)
  );
}

function buildConfirmEmbed(deptKey) {
  const dept = DEPARTMENTS[deptKey];
  return new EmbedBuilder()
    .setTitle(dept.label)
    .setDescription(
      'Are you sure you want to apply?\n\n' +
        'Once you start the application I will send you a series of questions. ' +
        'You will have 3 hours to complete the application. If you do not complete it in time, ' +
        'you will have to restart. If you wish to stop the application, feel free to click the cancel button at any time.'
    )
    .setColor(dept.color)
    .setFooter({ text: BRAND_FOOTER });
}

function buildConfirmRow(deptKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`start_${deptKey}`)
      .setLabel('Start application')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('cancel_confirm')
      .setLabel('Cancel application')
      .setStyle(ButtonStyle.Danger)
  );
}

function buildQuestionEmbed(deptKey, step) {
  const dept = DEPARTMENTS[deptKey];
  const list = getFullQuestionList(deptKey);
  const q = list[step];
  return new EmbedBuilder()
    .setTitle(dept.label)
    .setDescription(
      `${step + 1}/${list.length}. ${q.text}\n\n` +
        '_To answer this question, please send a message to the bot with your response._'
    )
    .setColor(dept.color)
    .setFooter({ text: BRAND_FOOTER });
}

function buildCancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('cancel_application')
      .setLabel('Cancel Application')
      .setStyle(ButtonStyle.Danger)
  );
}

function buildSummaryEmbed(deptKey, user, answers) {
  const dept = DEPARTMENTS[deptKey];
  const list = getFullQuestionList(deptKey);
  const embed = new EmbedBuilder()
    .setTitle(`New application - ${dept.label}`)
    .setColor(dept.color)
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: `User ID: ${user.id}` })
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
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${userId}`)
      .setLabel('Deny')
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

  // Try to kick them from the server
  try {
    const member = await guild.members.fetch(user.id);
    if (member.kickable) {
      await member.kick(`Auto-blacklist: stated age under ${MIN_AGE}`);
    }
  } catch (err) {
    console.error(`Could not kick ${user.id}:`, err.message);
  }

  // DM the user
  try {
    await user.send(
      "Your application has been stopped because you don't meet the minimum age requirement (13+) " +
        'to use Discord and to be a member of this server. You have been blacklisted from applying again.'
    );
  } catch {
    // DMs closed, ignore
  }

  // Log it
  if (LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      const embed = new EmbedBuilder()
        .setTitle('Auto-blacklist: underage applicant')
        .setDescription(`<@${user.id}> (${user.tag}) stated an age under ${MIN_AGE} and was auto-blacklisted + kicked.`)
        .setColor(0xed4245)
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
    // Application complete
    await finishApplication(user);
    return;
  }

  const embed = buildQuestionEmbed(session.deptKey, session.step);
  await user.send({ embeds: [embed], components: [buildCancelRow()] });

  // reset the 3h timeout every time we send a question
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    sessions.delete(user.id);
    try {
      await user.send(
        'You took longer than 3 hours to answer, so your application has expired. Please start a new one if you are still interested.'
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
    await user.send('Thank you! Your application has been submitted and is now being reviewed by staff.');
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
        content: 'You are blacklisted and cannot submit applications.',
        ephemeral: true,
      });
    }

    if (sessions.has(user.id)) {
      return interaction.reply({
        content: 'You already have an application in progress. Check your DMs.',
        ephemeral: true,
      });
    }

    try {
      await user.send({
        embeds: [buildConfirmEmbed(deptKey)],
        components: [buildConfirmRow(deptKey)],
      });
      await interaction.reply({ content: 'Check your DMs!', ephemeral: true });
    } catch {
      await interaction.reply({
        content: "I can't DM you! Please enable direct messages from server members and try again.",
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
        content: 'You are blacklisted and cannot submit applications.',
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
    });

    await interaction.update({
      content: 'Your application has started!',
      embeds: [],
      components: [],
    });
    await sendNextQuestion(user);
    return;
  }

  if (customId === 'cancel_confirm') {
    return interaction.update({ content: 'Application cancelled.', embeds: [], components: [] });
  }

  // ---- Cancel mid-application ----
  if (customId === 'cancel_application') {
    clearSession(user.id);
    return interaction.update({ content: 'Your application has been cancelled.', embeds: [], components: [] });
  }

  // ---- Staff review buttons ----
  if (customId.startsWith('accept_') || customId.startsWith('deny_')) {
    const member = interaction.member;
    if (!isStaff(member)) {
      return interaction.reply({ content: 'You are not allowed to review applications.', ephemeral: true });
    }

    const applicantId = customId.split('_')[1];
    const accepted = customId.startsWith('accept_');

    const oldEmbed = interaction.message.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(accepted ? 0x3ba55d : 0xed4245)
      .setFooter({ text: `${accepted ? 'Accepted' : 'Denied'} by ${interaction.user.tag}` });

    await interaction.update({ embeds: [newEmbed], components: [] });

    try {
      const applicant = await client.users.fetch(applicantId);
      await applicant.send(
        accepted
          ? 'Congratulations! Your application has been **accepted**. Staff will be in touch with next steps.'
          : 'Thank you for applying. Unfortunately your application has been **denied** this time. You are welcome to reapply in the future.'
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

    if (currentQuestion.key === 'age') {
      const age = extractAge(message.content);
      if (Number.isNaN(age) || age < MIN_AGE) {
        const guild = client.guilds.cache.get(session.guildId) || (await client.guilds.fetch(session.guildId).catch(() => null));
        clearSession(message.author.id);
        if (guild) await autoBlacklistForAge(message.author, guild);
        else {
          // fallback if guild lookup fails: still blacklist + DM
          addToBlacklist(message.author.id, message.author.tag, `Stated an age under ${MIN_AGE} during application`);
          try {
            await message.author.send('Your application has been stopped because you do not meet the minimum age requirement (13+).');
          } catch {}
        }
        return;
      }
    }

    session.answers[currentQuestion.key] = message.content;
    session.step += 1;
    await sendNextQuestion(message.author);
    return;
  }

  // ---- Text commands (server channels only) ----
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'panel') {
    if (!isStaff(message.member)) {
      return message.reply("You don't have permission to do that.");
    }
    await message.channel.send({ embeds: [buildPanelEmbed()], components: [buildPanelRow()] });
    return;
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
