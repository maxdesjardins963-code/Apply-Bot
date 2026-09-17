/**
 * WestJet | PTFS - Apply Bot (compact version)
 * -----------------------------------------------------
 * Panel -> DM -> questions -> staff review (Accept/Deny).
 * Basic answer moderation + auto-blacklist if age < 13.
 * Panel is posted with the /panel slash command.
 */

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField,
  REST, Routes, SlashCommandBuilder,
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Application ID (Developer Portal -> General Information)
const GUILD_ID = process.env.GUILD_ID;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MIN_AGE = 13;
const TIMEOUT_MS = 3 * 60 * 60 * 1000;
const COLOR = 0x00885A;
const DENY = 0xC8102E;
const BLACKLIST_FILE = './blacklist.json';
const BAD_WORDS = ['nigger', 'nigga', 'faggot', 'retard', 'kys', 'cunt'];
const LAZY = new Set(['idk', 'na', 'n/a', 'none', 'lol', 'test', 'asdf', 'ok', 'sure']);

// ---- blacklist (simple JSON file) ----
const loadBL = () => (fs.existsSync(BLACKLIST_FILE) ? JSON.parse(fs.readFileSync(BLACKLIST_FILE)) : {});
const saveBL = (d) => fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(d, null, 2));
const isBL = (id) => Boolean(loadBL()[id]);
const addBL = (id, tag, reason) => { const bl = loadBL(); bl[id] = { tag, reason, date: new Date().toISOString() }; saveBL(bl); };
const removeBL = (id) => { const bl = loadBL(); const ok = Boolean(bl[id]); delete bl[id]; saveBL(bl); return ok; };

// ---- moderation: returns null if ok, otherwise an error message ----
function moderate(text, q) {
  const t = text.trim();
  if (q.type === 'scale') {
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? null : 'Please answer with a whole number from 1 to 10.';
  }
  if (BAD_WORDS.some((w) => t.toLowerCase().includes(w))) return "That language isn't allowed here.";
  if (t.length < (q.min || 8)) return `Please give a bit more detail (min. ${q.min || 8} characters).`;
  if (LAZY.has(t.toLowerCase())) return 'Please give a real answer, not just one word.';
  return null;
}

// ---- questions ----
const COMMON = [
  { key: 'username', text: 'What is your Roblox username?', min: 3 },
  { key: 'age', text: 'How old are you?', type: 'age' },
  { key: 'activity', text: 'On a scale of 1-10, how active are you on PTFS?', type: 'scale' },
  { key: 'motivation', text: 'Why do you want to join WestJet?', min: 12 },
];

const DEPARTMENTS = {
  atc: { label: '🛫 Air Traffic Control', color: COLOR, questions: [
    { key: 'atc_exp', text: 'Have you done any ATC before (ProController, VATSIM, etc.)?', min: 5 },
    { key: 'atc_scenario', text: 'Two aircraft request the same runway at the same time. What do you do?', min: 12 },
  ]},
  mod: { label: '🛡️ Moderator', color: 0xF2A900, questions: [
    { key: 'mod_exp', text: 'Have you moderated a Discord server before? Describe it.', min: 12 },
    { key: 'mod_scenario', text: 'A member is spamming and insulting others. What are your steps?', min: 12 },
  ]},
  cabin: { label: '🧳 Cabin Crew', color: 0x4EA5D9, questions: [
    { key: 'cabin_exp', text: 'Have you been cabin crew before, here or elsewhere?', min: 5 },
    { key: 'cabin_scenario', text: 'A passenger is furious about their meal. How do you react?', min: 12 },
  ]},
  pilot: { label: '✈️ Pilot', color: 0x6C4AB6, questions: [
    { key: 'pilot_rank', text: 'What is your current PTFS rank and flight hours?', min: 3 },
    { key: 'pilot_scenario', text: 'You lose an engine right after takeoff. What is your plan?', min: 12 },
  ]},
};
const questionsFor = (dept) => [...COMMON, ...DEPARTMENTS[dept].questions];

// ---- in-memory sessions ----
const sessions = new Map();
const clearSession = (id) => { clearTimeout(sessions.get(id)?.timeout); sessions.delete(id); };

// ---- client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const commands = [new SlashCommandBuilder().setName('panel').setDescription('Post the WestJet application panel').toJSON()];
  const rest = new REST().setToken(TOKEN);
  try {
    // Registered on the guild (GUILD_ID) -> instant, unlike global (up to 1h)
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('/panel slash command registered.');
  } catch (err) {
    console.error('Error registering slash command:', err);
  }
});

const isStaff = (m) => m?.permissions.has(PermissionsBitField.Flags.Administrator) || (STAFF_ROLE_ID && m?.roles.cache.has(STAFF_ROLE_ID));

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle('✈️ Join the WestJet | PTFS Team')
    .setDescription('Pick a position below. You will be asked a few questions **in your DMs**.')
    .setColor(COLOR);
}
function panelRow() {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(DEPARTMENTS).map(([key, d]) =>
      new ButtonBuilder().setCustomId(`apply_${key}`).setLabel(d.label).setStyle(ButtonStyle.Secondary))
  );
}
function questionEmbed(dept, step) {
  const list = questionsFor(dept);
  return new EmbedBuilder()
    .setTitle(DEPARTMENTS[dept].label)
    .setDescription(`**Question ${step + 1}/${list.length}**\n${list[step].text}`)
    .setColor(DEPARTMENTS[dept].color);
}
function cancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
}
function summaryEmbed(dept, user, answers) {
  const e = new EmbedBuilder().setTitle(`New Application — ${DEPARTMENTS[dept].label}`)
    .setColor(DEPARTMENTS[dept].color).setThumbnail(user.displayAvatarURL()).setFooter({ text: `ID: ${user.id}` });
  for (const q of questionsFor(dept)) e.addFields({ name: q.text, value: String(answers[q.key] ?? 'N/A').slice(0, 1024) });
  return e;
}
function reviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept_${userId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_${userId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
  );
}

async function sendNext(user) {
  const s = sessions.get(user.id);
  if (!s) return;
  const list = questionsFor(s.dept);
  if (s.step >= list.length) return finish(user);

  await user.send({ embeds: [questionEmbed(s.dept, s.step)], components: [cancelRow()] });
  clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    sessions.delete(user.id);
    user.send('⏰ You took too long (3h). Start a new application if you are still interested.').catch(() => {});
  }, TIMEOUT_MS);
}

async function finish(user) {
  const s = sessions.get(user.id);
  if (!s) return;
  if (REVIEW_CHANNEL_ID) {
    const ch = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
    if (ch) await ch.send({ embeds: [summaryEmbed(s.dept, user, s.answers)], components: [reviewRow(user.id)] });
  }
  await user.send('🎉 Application submitted! Staff will review it soon.').catch(() => {});
  clearSession(user.id);
}

client.on('interactionCreate', async (i) => {
  // ---- /panel: post the application panel in the channel ----
  if (i.isChatInputCommand() && i.commandName === 'panel') {
    if (!isStaff(i.member)) return i.reply({ content: '🚫 Staff only.', ephemeral: true });
    await i.channel.send({ embeds: [panelEmbed()], components: [panelRow()] });
    return i.reply({ content: '✅ Panel posted.', ephemeral: true });
  }

  if (!i.isButton()) return;
  const { customId: id, user } = i;

  if (id.startsWith('apply_')) {
    const dept = id.replace('apply_', '');
    if (isBL(user.id)) return i.reply({ content: '🚫 You are blacklisted.', ephemeral: true });
    if (sessions.has(user.id)) return i.reply({ content: '📨 You already have an application in progress, check your DMs.', ephemeral: true });
    try {
      await user.send({ embeds: [new EmbedBuilder().setTitle(DEPARTMENTS[dept].label).setDescription('Ready to start? You have 3 hours to complete it.').setColor(DEPARTMENTS[dept].color)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`start_${dept}`).setLabel('Start').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('cancel_confirm').setLabel('Cancel').setStyle(ButtonStyle.Danger))] });
      await i.reply({ content: '✅ Check your DMs!', ephemeral: true });
    } catch { await i.reply({ content: '❌ Please enable your DMs and try again.', ephemeral: true }); }
    return;
  }

  if (id.startsWith('start_')) {
    const dept = id.replace('start_', '');
    sessions.set(user.id, { dept, step: 0, answers: {}, timeout: null });
    await i.update({ content: "🚀 Let's go!", embeds: [], components: [] });
    return sendNext(user);
  }

  if (id === 'cancel_confirm') return i.update({ content: 'Cancelled.', embeds: [], components: [] });
  if (id === 'cancel') { clearSession(user.id); return i.update({ content: 'Your application has been cancelled.', embeds: [], components: [] }); }

  if (id.startsWith('accept_') || id.startsWith('deny_')) {
    if (!isStaff(i.member)) return i.reply({ content: '🚫 Staff only.', ephemeral: true });
    const applicantId = id.split('_')[1];
    const accepted = id.startsWith('accept_');
    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(accepted ? COLOR : DENY)
      .setFooter({ text: `${accepted ? 'Accepted' : 'Denied'} by ${i.user.tag}` });
    await i.update({ embeds: [embed], components: [] });
    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (applicant) applicant.send(accepted ? '🎉 Your application has been accepted!' : 'Your application has been denied. You can try again later.').catch(() => {});
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.guild) return; // DM only: answers to questions
  const s = sessions.get(msg.author.id);
  if (!s) return;

  const list = questionsFor(s.dept);
  const q = list[s.step];

  if (q.type === 'age') {
    const age = parseInt(msg.content.match(/\d+/)?.[0], 10);
    if (isNaN(age) || age < MIN_AGE) {
      clearSession(msg.author.id);
      addBL(msg.author.id, msg.author.tag, `Age below ${MIN_AGE}`);
      const guild = client.guilds.cache.get(GUILD_ID);
      const member = await guild?.members.fetch(msg.author.id).catch(() => null);
      if (member?.kickable) await member.kick('Auto-blacklist: underage').catch(() => {});
      return msg.author.send("You don't meet the minimum age requirement (13+). Application cancelled and blacklisted.").catch(() => {});
    }
    s.answers[q.key] = String(age);
  } else {
    const error = moderate(msg.content, q);
    if (error) return msg.author.send(`⚠️ ${error}\n\n${q.text}`).catch(() => {});
    s.answers[q.key] = msg.content.trim();
  }

  s.step += 1;
  sendNext(msg.author);
});

client.login(TOKEN);

// fake HTTP server for Render's port check
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);
